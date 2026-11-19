// vx-docker: Docker, like VS Code's Docker extension, as a side-bar view (activity bar ⌘⌥D).
//   panel    props {}                    Containers (by compose project), Images, Volumes,
//                                        Networks, Contexts; filter; hover and right-click actions
//   menu     props { menu }              a right-click popup (posts to the panel: vx.docker.cmd)
//   inspect  props { inspect }           a centre tab: `docker inspect` as JSON (inspect.js)
//   run      props { runImage }          the Run Image dialog (inspect.js)
//   confirm  props { confirm }           remove / prune / compose down: always asked first
// Start, stop, restart and pause run at once (they're undone by the opposite one). Logs and
// pulls run in the bottom panel; a shell opens as a tab. Polls every 3 s while the view shows,
// every 30 s otherwise (for the activity badge: shared vx.docker.summary).
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, props, exec, notify, layout, checking, shared, setShared, openOverlay, run, spaces, nextCommand } from "herdr";
import {
  FORMAT, jsonLines, toContainer, groupContainers, toImage, sortImages, toVolume, toNetwork, toContext, parseStats,
  daemonDown, matchesFilter, isRunning, portLabel, composeArgs, BUILTIN_NETWORKS, parseLabels,
} from "./docker-core.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { runInPanel, runInTab } from "./term.js";
import { findNode } from "./layout-core.js";
import { TEXT, Icon, IconButton, Button, Message, ConfirmView, Dot } from "./ui.js";
import { menuMethods } from "./docker-menu.js";
import { inspectMethods } from "./inspect.js";

const MOD = "vx-docker";
const CMD = "vx.docker.cmd";
const SUMMARY = "vx.docker.summary";
const POLL_MS = 3000;
const IDLE_MS = 30000;
const STATS_MS = 6000;
const ROW = 22;
const SECTIONS = [["containers", "Containers"], ["images", "Images"], ["volumes", "Volumes"], ["networks", "Networks"], ["contexts", "Contexts"]];

export const post = (cmd) => setShared(CMD, { ...cmd, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });

class VxDocker extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.menu) return void (this.menu = p.menu);
    if (p.inspect) return this.initInspect(p, cx);
    if (p.runImage) return this.initRunDialog(p, cx);
    this.panel = true;
    this.data = null; // { containers, images, volumes, networks, contexts }
    this.stats = {};
    this.down = false;
    this.error = null;
    this.hover = null;
    this.expanded = new Set(); // compose projects and containers showing details
    this.busy = new Set(); // ids with an action running
    try {
      this.open = { containers: true, ...JSON.parse(localStorage.getItem("open") ?? "{}") };
    } catch {
      this.open = { containers: true };
    }
    this.filter = InputState.new({ placeholder: "Filter containers, images…" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.cmdSeen = shared(CMD)?.id ?? null;
    if (checking()) return;
    this.lastLoad = 0;
    this.lastStats = 0;
    this.load(cx);
    cx.timer.every(1000, (cx) => this.tick(cx));
    cx.timer.every(200, (cx) => this.takeCommand(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "refresh") this.load(cx);
        if (c === "focus" || c === "filter") this.filter.focus();
        cx.notify();
      }
    });
  }

  // Is the Docker view on screen? (vx-code: the side bar shows and its stack has "docker"
  // selected; in any other layout, assume yes.)
  shown() {
    const root = layout();
    const stack = findNode(root, "sidebar-views");
    if (!stack) return true;
    const side = findNode(root, "sidebar");
    return Boolean(side && !side.hidden && stack.active === "docker");
  }

  tick(cx) {
    const now = Date.now();
    const shown = this.shown();
    if (now - this.lastLoad >= (shown ? POLL_MS : IDLE_MS)) this.load(cx, !shown);
    if (shown && this.open.containers && now - this.lastStats >= STATS_MS && (this.data?.containers ?? []).some(isRunning)) this.loadStats(cx);
  }

  async docker(args, timeout = 20000) {
    return exec("docker", args, { timeout }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  }

  // light: only containers (the badge needs no more while the view is hidden).
  load(cx, light = false) {
    if (this.loading) return;
    this.loading = true;
    this.lastLoad = Date.now();
    cx.spawn(async (cx) => {
      try {
        const ps = await this.docker(["ps", "-a", "--format", FORMAT]);
        if (ps.code !== 0) {
          this.down = daemonDown(ps.stderr) || /not found|no such file/i.test(ps.stderr);
          this.missing = /not found|no such file|ENOENT/i.test(ps.stderr) && !daemonDown(ps.stderr);
          this.error = this.down ? null : (ps.stderr || "docker failed").trim();
          this.publish([]);
          return;
        }
        this.down = false;
        this.missing = false;
        this.error = null;
        const containers = jsonLines(ps.stdout).map(toContainer);
        const prev = this.data ?? {};
        if (light) {
          this.data = { ...prev, containers };
        } else {
          const [im, vo, ne, co] = await Promise.all([
            this.docker(["images", "--format", FORMAT]),
            this.docker(["volume", "ls", "--format", FORMAT]),
            this.docker(["network", "ls", "--format", FORMAT]),
            this.docker(["context", "ls", "--format", FORMAT]),
          ]);
          this.data = {
            containers,
            images: im.code === 0 ? sortImages(jsonLines(im.stdout).map(toImage)) : prev.images ?? [],
            volumes: vo.code === 0 ? jsonLines(vo.stdout).map(toVolume).sort((a, b) => a.name.localeCompare(b.name)) : prev.volumes ?? [],
            networks: ne.code === 0 ? jsonLines(ne.stdout).map(toNetwork).sort((a, b) => a.name.localeCompare(b.name)) : prev.networks ?? [],
            contexts: co.code === 0 ? jsonLines(co.stdout).map(toContext) : prev.contexts ?? [],
          };
        }
        this.publish(containers);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  publish(containers) {
    const running = containers.filter(isRunning).length;
    const next = { running, total: containers.length, down: this.down };
    const was = shared(SUMMARY);
    if (!was || was.running !== next.running || was.total !== next.total || was.down !== next.down) setShared(SUMMARY, next);
  }

  loadStats(cx) {
    if (this.statsBusy) return;
    this.statsBusy = true;
    this.lastStats = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await this.docker(["stats", "--no-stream", "--format", FORMAT], 15000);
        if (r.code === 0) this.stats = parseStats(r.stdout);
      } finally {
        this.statsBusy = false;
        cx.notify();
      }
    });
  }

  // ── commands (from menus, dialogs and the row buttons) ─────────────────────────────────
  takeCommand(cx) {
    const c = shared(CMD);
    if (!c || c.id === this.cmdSeen) return;
    this.cmdSeen = c.id;
    this.act(c, cx);
  }

  act(c, cx) {
    const d = this.data ?? {};
    const container = c.container ? d.containers?.find((x) => x.id === c.container) : null;
    const group = c.project ? groupContainers(d.containers ?? []).projects.find((g) => g.project === c.project) : null;
    switch (c.cmd) {
      case "start": case "stop": case "restart": case "pause": case "unpause":
        return this.quick([c.cmd, c.container], c.container, `${c.cmd} ${container?.name ?? ""}`, cx);
      case "logs":
        return void runInPanel(["docker", "logs", "-f", "--tail", "500", c.container]);
      case "shell":
        return runInTab(["docker", "exec", "-it", c.container, "sh", "-c", "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi"], { name: `${container?.name ?? c.container} · shell` });
      case "open":
        return void exec("open", [`http://localhost:${c.port}`]).catch(() => {});
      case "inspect":
        return this.openInspect(c.kind, c.ref, c.name);
      case "remove":
        return this.askRemove(c);
      case "compose":
        return group ? this.compose(group, c.verb, cx) : null;
      case "prune":
        return this.askPrune(c.what);
      case "pull":
        return void runInPanel(["docker", "pull", c.ref]);
      case "runImage":
        return openOverlay({ mod: MOD, kind: "dialog", width: 460, height: 330, props: { runImage: { ref: c.ref } } });
      case "run":
        if (c.detached) return this.quick(c.args, null, `run ${c.args[c.args.length - 1]}`, cx);
        return runInTab(["docker", ...c.args], { name: `run ${c.image}` });
      case "context":
        return this.quick(["context", "use", c.name], null, `context ${c.name}`, cx);
      case "copy":
        return void cx.write_to_clipboard(c.text);
      case "startDaemon":
        return this.startDaemon(cx);
      case "refresh":
        return this.load(cx);
    }
  }

  // A short docker command with a spinner on its row and a toast only when it fails.
  quick(args, id, what, cx) {
    if (id) this.busy.add(id);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.docker(args, 120000);
      if (id) this.busy.delete(id);
      if (r.code !== 0) notify({ title: `docker ${what} failed`, body: (r.stderr || r.stdout).trim().slice(-500), level: "error", timeout: 8000 });
      this.load(cx);
    });
  }

  compose(g, verb, cx) {
    if (verb === "logs") return void runInPanel(["docker", ...composeArgs(g, "logs", ["-f", "--tail", "200"])], { cwd: g.workdir ?? undefined });
    if (verb === "down") {
      return askConfirm(MOD, {
        title: `Stop and remove ${g.project}?`, detail: "docker compose down: its containers and networks go; volumes and images stay.", label: "Down", danger: true,
        action: { cmd: "docker", args: composeArgs(g, "down"), cwd: g.workdir ?? undefined, doing: `compose down ${g.project}`, done: `${g.project} is down`, timeout: 300000 },
      });
    }
    if (verb === "up" || verb === "pull") {
      // The ps labels lose all but the first config file (they're comma-joined): read them whole.
      cx.spawn(async () => {
        const first = g.containers[0];
        const r = first ? await this.docker(["inspect", "--format", "{{json .Config.Labels}}", first.id]) : null;
        let files = g.configFiles;
        try {
          const labels = parseLabels(JSON.parse(r?.stdout ?? "null") ?? {});
          files = (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean);
        } catch {}
        const full = { ...g, configFiles: files.length ? files : g.configFiles };
        runInPanel(["docker", ...composeArgs(full, verb, verb === "up" ? ["-d"] : [])], { cwd: g.workdir ?? undefined });
      });
      return;
    }
    return this.quick(composeArgs(g, verb), `project:${g.project}`, `compose ${verb} ${g.project}`, cx);
  }

  askRemove(c) {
    const what = {
      container: { title: `Remove container ${c.name}?`, args: c.running ? ["rm", "-f", c.ref] : ["rm", c.ref], detail: c.running ? "It's running: it will be stopped first (rm -f)." : null },
      image: { title: `Remove image ${c.name}?`, args: ["rmi", c.ref], detail: "Fails if a container still uses it." },
      volume: { title: `Remove volume ${c.name}?`, args: ["volume", "rm", c.ref], detail: "Its data is deleted for good." },
      network: { title: `Remove network ${c.name}?`, args: ["network", "rm", c.ref], detail: null },
    }[c.kind];
    if (!what) return;
    askConfirm(MOD, { title: what.title, detail: what.detail, label: "Remove", danger: true, action: { cmd: "docker", args: what.args, doing: `Removing ${c.name}`, done: `Removed ${c.name}` } });
  }

  askPrune(what) {
    const spec = {
      containers: ["Remove all stopped containers?", ["container", "prune", "-f"], null],
      images: ["Remove dangling images?", ["image", "prune", "-f"], "Images with no tag that no container uses."],
      "images-all": ["Remove all unused images?", ["image", "prune", "-a", "-f"], "Every image no container uses, tagged or not."],
      volumes: ["Remove unused volumes?", ["volume", "prune", "-f"], "Their data is deleted for good."],
      networks: ["Remove unused networks?", ["network", "prune", "-f"], null],
      system: ["Clean up Docker?", ["system", "prune", "-f"], "Stopped containers, unused networks, dangling images and build cache."],
    }[what];
    if (!spec) return;
    askConfirm(MOD, { title: spec[0], detail: spec[2], label: "Prune", danger: true, action: { cmd: "docker", args: spec[1], doing: "Pruning", done: "Pruned", timeout: 600000 } });
  }

  startDaemon(cx) {
    cx.spawn(async (cx) => {
      const orb = await exec("test", ["-d", "/Applications/OrbStack.app"]).catch(() => ({ code: 1 }));
      const app = orb.code === 0 ? "OrbStack" : "Docker";
      const r = await exec("open", ["-a", app]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) notify({ title: `Couldn't start ${app}`, body: (r.stderr ?? "").trim(), level: "error" });
      else notify({ title: `Starting ${app}…`, level: "info", timeout: 3000 });
      this.startedAt = Date.now();
      cx.notify();
    });
  }

  openInspect(kind, ref, name) {
    const space = spaces().find((s) => s.active);
    run("tab.new", { name: `${name} · inspect`, mod: MOD, props: { inspect: { kind, ref, name } }, ...(space ? { space: space.id } : {}) });
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  toggleSection(id, cx) {
    this.open = { ...this.open, [id]: !this.open[id] };
    try {
      localStorage.setItem("open", JSON.stringify(this.open));
    } catch {}
    if (this.open[id]) this.load(cx);
    cx.notify();
  }

  secHead(t, id, title, count, right = []) {
    const open = Boolean(this.open[id]);
    return h_flex().id(`sec-${id}`).h(ROW).flex_none().pl(4).pr(6).gap(4).items_center().cursor_pointer()
      .border_t(1).border_color(t.border).text_size(TEXT.caption).font_medium().text_color(t.foreground)
      .on_click((_e, cx) => this.toggleSection(id, cx))
      .child(Icon(open ? "chevron-down" : "chevron-right", 14).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(title.toUpperCase()))
      .when(count !== null && count !== undefined, (el) => el.child(div().text_color(t.dim).child(String(count))))
      .when(open, (el) => el.children(right.filter(Boolean)));
  }

  // A row with hover-only action buttons on the right.
  row(t, key, depth, { icon, label, detail, right, actions = [], onClick, menu, tip, selected }) {
    const hovered = this.hover === key;
    return h_flex().id(`r-${key}`).h(ROW).flex_none().pl(8 + depth * 14).pr(6).gap(6).items_center().cursor_pointer()
      .bg(selected ? t.selected : "#00000000").when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .text_size(TEXT.small).when(Boolean(tip), (el) => el.tooltip(tip))
      .on_hover((h, cx) => {
        if (h) this.hover = key;
        else if (this.hover === key) this.hover = null;
        cx.notify();
      })
      .when(Boolean(onClick), (el) => el.on_click((_e, cx) => { onClick(cx); cx.notify(); }))
      .when(Boolean(menu), (el) => el.on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(menu); }))
      .child(icon)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(Boolean(detail) && !hovered, (el) => el.child(div().flex_none().max_w(120).truncate().text_size(TEXT.caption).text_color(t.dim).child(detail)))
      .when(Boolean(right) && !hovered, (el) => el.child(right))
      .when(hovered, (el) => el.children(actions.filter(Boolean).map((a) => IconButton({ ...a, size: 18 }))));
  }

  stateColor(t, c) {
    return { running: t.ansi2, restarting: t.ansi4, paused: t.ansi3, dead: t.ansi1, removing: t.ansi1 }[c.state] ?? t.dim;
  }

  containerActions(c) {
    const busy = this.busy.has(c.id);
    const run1 = isRunning(c) || c.state === "paused";
    return [
      busy ? { id: `b-${c.id}`, icon: "refresh", label: "Working…", spinning: true, onClick: () => {} } : null,
      !busy && !run1 ? { id: `st-${c.id}`, icon: "play", label: "Start", onClick: () => post({ cmd: "start", container: c.id }) } : null,
      !busy && run1 ? { id: `sp-${c.id}`, icon: "stop", label: "Stop", onClick: () => post({ cmd: "stop", container: c.id }) } : null,
      !busy && run1 ? { id: `rs-${c.id}`, icon: "retry", label: "Restart", onClick: () => post({ cmd: "restart", container: c.id }) } : null,
      { id: `lg-${c.id}`, icon: "list", label: "Logs (follow, in the panel)", onClick: () => post({ cmd: "logs", container: c.id }) },
      isRunning(c) ? { id: `sh-${c.id}`, icon: "terminal", label: "Shell (exec, in a tab)", onClick: () => post({ cmd: "shell", container: c.id }) } : null,
    ];
  }

  containerRows(t, c, depth, rows) {
    const key = `c:${c.id}`;
    const s = this.stats[c.id] ?? this.stats[c.id.slice(0, 12)] ?? this.stats[c.name];
    const port = c.ports.find((p) => p.hostPort);
    const open = this.expanded.has(key);
    rows.push(this.row(t, key, depth, {
      icon: Dot(this.stateColor(t, c), 8),
      label: c.service && depth > 0 ? c.service : c.name,
      detail: depth > 0 ? null : c.image,
      right: isRunning(c) && s?.cpu ? div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(s.cpu) : port ? div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`:${port.hostPort}`) : null,
      actions: this.containerActions(c),
      onClick: () => (open ? this.expanded.delete(key) : this.expanded.add(key)),
      menu: { kind: "container", id: c.id, name: c.name, state: c.state, running: isRunning(c), ports: c.ports.filter((p) => p.hostPort).map((p) => p.hostPort) },
      tip: `${c.name}\n${c.image}\n${c.status}${c.ports.length ? `\n${c.ports.map(portLabel).join(", ")}` : ""}`,
      selected: open,
    }));
    if (!open) return;
    const line = (k, label, value, onClick) => h_flex().id(`d-${c.id}-${k}`).h(20).flex_none().pl(8 + (depth + 1) * 14 + 14).pr(8).gap(6).items_center().text_size(TEXT.caption)
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click(() => onClick()))
      .child(div().w(54).flex_none().text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).truncate().text_color(onClick ? t.accent : t.muted).child(value));
    rows.push(line("status", "status", c.status));
    rows.push(line("image", "image", c.image));
    if (s) rows.push(line("usage", "cpu · mem", `${s.cpu} · ${s.mem}${s.memPerc ? ` (${s.memPerc})` : ""}`));
    for (const p of c.ports) rows.push(line(`p${p.containerPort}${p.proto}`, "port", p.hostPort ? `localhost:${p.hostPort} → ${p.containerPort}/${p.proto}` : `${p.containerPort}/${p.proto} (not published)`, p.hostPort ? () => post({ cmd: "open", port: p.hostPort }) : null));
    if (c.networks.length) rows.push(line("net", "network", c.networks.join(", ")));
  }

  render() {
    if (this.confirmSpec) return ConfirmView(this);
    if (this.menu) return this.renderMenu();
    if (this.inspect) return this.renderInspect();
    if (this.runDialog) return this.renderRunDialog();
    return this.renderPanel();
  }

  renderPanel() {
    const t = theme();
    const root = v_flex().id(MOD).size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(TEXT.body).overflow_hidden();
    const head = h_flex().h(34).flex_none().px(8).gap(4).items_center()
      .child(h_flex().flex_1().min_w(0).h(24).px(8).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.filter).flex_1().h_full().text_size(TEXT.small)))
      .child(IconButton({ id: "dk-refresh", icon: "refresh", label: "Refresh", size: 22, spinning: this.loading && !this.data, onClick: (cx) => this.load(cx) }))
      .child(IconButton({ id: "dk-prune", icon: "trash", label: "Prune…", size: 22, onClick: () => this.openMenu({ kind: "prune" }) }));
    root.child(head);
    if (this.missing) return root.child(Message("The docker command isn't installed. Install Docker Desktop, OrbStack or colima."));
    if (this.down) {
      const starting = this.startedAt && Date.now() - this.startedAt < 60000;
      return root.child(v_flex().p(14).gap(10)
        .child(div().text_size(TEXT.small).text_color(t.muted).whitespace_normal().child(starting ? "Starting Docker… this view fills in when it answers." : "Docker isn't running."))
        .child(Button({ id: "dk-start", label: starting ? "Starting…" : "Start Docker", primary: true, disabled: starting, icon: "play", onClick: () => post({ cmd: "startDaemon" }) })));
    }
    if (this.error) root.child(Message(this.error, true));
    if (!this.data) return root.child(Message("Loading…"));
    const q = this.filter.value();
    const d = this.data;
    const rows = [];
    // Containers
    const containers = d.containers.filter((c) => matchesFilter(c, q));
    const { projects, loose } = groupContainers(containers);
    const running = d.containers.filter(isRunning).length;
    rows.push(this.secHead(t, "containers", "Containers", `${running}/${d.containers.length}`));
    if (this.open.containers) {
      if (!containers.length) rows.push(Message(q ? "No matching containers." : "No containers."));
      for (const g of projects) {
        const key = `p:${g.project}`;
        const open = this.expanded.has(key) || Boolean(q.trim());
        const busy = this.busy.has(`project:${g.project}`);
        rows.push(this.row(t, key, 0, {
          icon: h_flex().gap(4).items_center().child(Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim)).child(Icon("layers", 13).text_color(g.running ? t.ansi2 : t.dim)),
          label: g.project,
          right: div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`${g.running}/${g.total}`),
          actions: [
            busy ? { id: `pb-${g.project}`, icon: "refresh", label: "Working…", spinning: true, onClick: () => {} } : null,
            !busy ? { id: `pu-${g.project}`, icon: "play", label: "Compose Up (-d)", onClick: () => post({ cmd: "compose", project: g.project, verb: "up" }) } : null,
            !busy && g.running ? { id: `ps-${g.project}`, icon: "stop", label: "Compose Stop", onClick: () => post({ cmd: "compose", project: g.project, verb: "stop" }) } : null,
            !busy && g.running ? { id: `pr-${g.project}`, icon: "retry", label: "Compose Restart", onClick: () => post({ cmd: "compose", project: g.project, verb: "restart" }) } : null,
            { id: `pl-${g.project}`, icon: "list", label: "Compose Logs (follow)", onClick: () => post({ cmd: "compose", project: g.project, verb: "logs" }) },
          ],
          onClick: () => (this.expanded.has(key) ? this.expanded.delete(key) : this.expanded.add(key)),
          menu: { kind: "project", project: g.project, running: g.running, workdir: g.workdir },
          tip: `${g.project}${g.workdir ? `\n${g.workdir}` : ""}`,
        }));
        if (open) for (const c of g.containers) this.containerRows(t, c, 1, rows);
      }
      for (const c of loose) this.containerRows(t, c, 0, rows);
    }
    // Images
    const images = (d.images ?? []).filter((i) => matchesFilter(i, q));
    rows.push(this.secHead(t, "images", "Images", d.images?.length ?? null));
    if (this.open.images) {
      if (!images.length) rows.push(Message(q ? "No matching images." : "No images."));
      for (const i of images) rows.push(this.row(t, `i:${i.id}:${i.ref}`, 0, {
        icon: Icon("box", 13).text_color(i.dangling ? t.dim : t.ansi4),
        label: i.dangling ? `<none> ${i.id.slice(0, 12)}` : i.ref,
        right: div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(i.size),
        actions: [
          { id: `ir-${i.id}${i.ref}`, icon: "play", label: "Run…", onClick: () => post({ cmd: "runImage", ref: i.ref }) },
          { id: `ip-${i.id}${i.ref}`, icon: "download", label: "Pull", onClick: () => post({ cmd: "pull", ref: i.ref }) },
          { id: `ix-${i.id}${i.ref}`, icon: "trash", label: "Remove…", onClick: () => post({ cmd: "remove", kind: "image", ref: i.ref, name: i.ref }) },
        ],
        menu: { kind: "image", id: i.id, ref: i.ref, dangling: i.dangling },
        tip: `${i.ref}\n${i.id}\n${i.size} · ${i.created}`,
      }));
    }
    // Volumes
    const volumes = (d.volumes ?? []).filter((v) => matchesFilter(v, q) || v.name.toLowerCase().includes(q.trim().toLowerCase()));
    rows.push(this.secHead(t, "volumes", "Volumes", d.volumes?.length ?? null));
    if (this.open.volumes) {
      if (!volumes.length) rows.push(Message(q ? "No matching volumes." : "No volumes."));
      for (const v of volumes) rows.push(this.row(t, `v:${v.name}`, 0, {
        icon: Icon("database", 13).text_color(t.ansi5), label: v.name, detail: v.driver,
        actions: [{ id: `vx-${v.name}`, icon: "trash", label: "Remove…", onClick: () => post({ cmd: "remove", kind: "volume", ref: v.name, name: v.name }) }],
        menu: { kind: "volume", name: v.name }, tip: `${v.name}\n${v.driver}${v.mountpoint ? `\n${v.mountpoint}` : ""}`,
      }));
    }
    // Networks
    const networks = (d.networks ?? []).filter((n) => !q.trim() || n.name.toLowerCase().includes(q.trim().toLowerCase()));
    rows.push(this.secHead(t, "networks", "Networks", d.networks?.length ?? null));
    if (this.open.networks) {
      for (const n of networks) rows.push(this.row(t, `n:${n.id}`, 0, {
        icon: Icon("network", 13).text_color(t.ansi6), label: n.name, detail: n.driver,
        actions: BUILTIN_NETWORKS.has(n.name) ? [] : [{ id: `nx-${n.id}`, icon: "trash", label: "Remove…", onClick: () => post({ cmd: "remove", kind: "network", ref: n.id, name: n.name }) }],
        menu: { kind: "network", id: n.id, name: n.name, builtin: BUILTIN_NETWORKS.has(n.name) }, tip: `${n.name} · ${n.driver} · ${n.scope}`,
      }));
    }
    // Contexts
    rows.push(this.secHead(t, "contexts", "Contexts", d.contexts?.length ?? null));
    if (this.open.contexts) {
      for (const c of d.contexts ?? []) rows.push(this.row(t, `x:${c.name}`, 0, {
        icon: Icon(c.current ? "check" : "cloud", 13).text_color(c.current ? t.ansi2 : t.dim), label: c.name, detail: c.endpoint.replace(/^unix:\/\//, ""),
        onClick: c.current ? null : () => post({ cmd: "context", name: c.name }),
        tip: `${c.name}${c.current ? " (in use)" : " · click to use"}\n${c.endpoint}${c.description ? `\n${c.description}` : ""}`,
      }));
    }
    return root.child(v_flex().id("dk-rows").flex_1().min_h(0).overflow_y_scrollbar().children(rows));
  }
}

Object.assign(VxDocker.prototype, confirmMethods, menuMethods, inspectMethods);
export default VxDocker;
