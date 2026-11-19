// vx-panel: VS Code's bottom panel for the vx-code layout. The layout has a hidden column
// "bottom" holding this header (a block) and a "term" block whose content this header sets
// (layout.set) to what the chosen panel tab shows:
//   PROBLEMS   the workspace's trouble: merge conflicts, repos git can't read, failing pipelines,
//              branches behind their upstream; and Run checks: the context repo's typecheck /
//              lint scripts, their errors as file:line rows (shared "vx.checks", per repo)
//   TERMINAL   shells started with `hc run` (label vx.panel=1, no herdr.space/tab labels, so they
//              never become tabs); the "term" block shows the chosen one as { terminal }
//   PORTS      programs listening on TCP ports here: open in the browser, or stop (asks first)
// Copies: header (no props) · view props { view: "problems" | "ports" } or { empty } · confirm.
// ⌘J (vx-activity.panel) shows or hides the column; when it appears on TERMINAL with no shell,
// this header starts one in the context repo. When the last shell ends, the panel hides.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, layout, run, hc, exec, terminals, shared, setShared, nextCommand, notify, checking, props, home } from "herdr";
import { ctx, baseName, workspace, rootFor, setActive, repoTop } from "./ws.js";
import { findProject, pmOf, allScripts } from "./scripts.js";
import { showInViewer } from "./tabs.js";
import { withContent, findNode } from "./layout-core.js";
import { parsePorts, workspaceProblems, pickChecks, parseCheckOutput, countProblems } from "./panel-core.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, ConfirmView, FileIcon, RootIcon } from "./ui.js";
import { loadIcons } from "./icons.js";

const MOD = "vx-panel";
const KEY = "vx.panel"; // { view, shown: address | null, list: [address] }
const LABEL = "vx.panel=1";
const SIZE = 260;
const VIEWS = [["problems", "Problems"], ["terminal", "Terminal"], ["ports", "Ports"]];

const state = () => ({ view: "terminal", shown: null, list: [], ...(shared(KEY) ?? {}) });
const live = () => new Map((terminals() ?? []).filter((x) => x.labels?.["vx.panel"] === "1" && x.state === "live").map((x) => [x.address, x]));

// Workspace trouble (vx.git, vx.ci.summary); what "Run checks" found is in vx.checks.
const problems = () => workspaceProblems(workspace()?.roots ?? [], shared("vx.git") ?? {}, shared("vx.ci.summary") ?? {});
const checks = () => shared("vx.checks") ?? {};
const problemCounts = () => countProblems(problems(), checks());

class VxPanel extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.view || p.empty) {
      this.view = p.view ?? "empty";
      if (checking()) return;
      if (this.view === "ports") {
        this.cwds = new Map();
        this.loadPorts(cx);
        cx.timer.every(3000, (cx) => this.loadPorts(cx));
      }
      if (this.view === "problems") cx.timer.every(1500, (cx) => {
        const key = JSON.stringify([problems(), checks(), ctx().root?.name ?? ctx().cwd ?? null]);
        if (key === this.lastProblems) return;
        this.lastProblems = key;
        cx.notify();
      });
      return;
    }
    if (checking()) return;
    this.tops = new Map();
    cx.timer.every(1000, (cx) => this.tidy(cx));
    cx.timer.every(10000, (cx) => this.countPorts(cx));
    this.countPorts(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") await this.add(cx);
        if (c === "checks") this.runChecks(cx);
        if (VIEWS.some(([id]) => id === c)) this.pick(c);
        cx.notify();
      }
    });
  }

  bottom() {
    return findNode(layout(), "bottom");
  }

  // ── what the "term" block shows ────────────────────────────────────────────────────────
  want(s) {
    if (s.view === "problems" || s.view === "ports") return { mod: MOD, props: { view: s.view } };
    return s.shown ? { terminal: s.shown } : { mod: MOD, props: { empty: true } };
  }

  apply(s = state()) {
    const tree = layout();
    const term = findNode(tree, "term");
    if (!term) return;
    const content = this.want(s);
    if (JSON.stringify(term.content) === JSON.stringify(content)) return;
    const next = withContent(tree, "term", content);
    if (next) run("layout.set", { layout: next });
  }

  pick(view) {
    const s = { ...state(), view };
    setShared(KEY, s);
    this.apply(s);
    if (view === "terminal" && s.shown) run("pane.focus", { terminal: s.shown });
    if (view === "terminal" && !s.shown) this.autostart = true;
  }

  // Forget shells that ended; start one when TERMINAL shows with none.
  tidy(cx) {
    const b = this.bottom();
    const visible = Boolean(b && !b.hidden);
    const appeared = visible && !this.wasVisible;
    this.wasVisible = visible;
    const lv = live();
    const s = state();
    const list = s.list.filter((a) => lv.has(a));
    for (const a of lv.keys()) if (!list.includes(a)) list.push(a);
    const shown = lv.has(s.shown) ? s.shown : list[list.length - 1] ?? null;
    const next = { ...s, shown, list };
    if (list.join() !== s.list.join() || shown !== s.shown) {
      setShared(KEY, next);
      if (s.list.length && !list.length && visible && s.view === "terminal") run("layout.hide", { id: "bottom" });
    }
    this.apply(next);
    const start = (appeared || this.autostart) && visible && s.view === "terminal" && !list.length;
    this.autostart = false;
    if (start && !this.starting) {
      this.starting = true;
      cx.spawn(async (cx) => {
        try {
          await this.add(cx);
        } finally {
          this.starting = false;
          cx.notify();
        }
      });
    }
    // Repaint only when the header would change (the tidy tick runs every second).
    const cur = lv.get(shown);
    const key = JSON.stringify([visible, next.view, shown, list, cur?.agent ?? null, cur?.cwd ?? null]);
    if (key !== this.lastTidy) {
      this.lastTidy = key;
      cx.notify();
    }
  }

  async start() {
    const c = ctx();
    const cwd = c.root?.path ?? c.cwd ?? home();
    const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--outlive-parent", "--no-notify", "--label", LABEL, "--cwd", cwd];
    if (c.on) args.push("--on", c.on);
    const r = await hc(args);
    if (r.code !== 0) {
      notify({ title: "Couldn't start a panel terminal", body: (r.stderr || r.stdout).trim(), level: "error" });
      return null;
    }
    try {
      return JSON.parse(r.stdout).address ?? null;
    } catch {
      return null;
    }
  }

  async add(_cx) {
    const address = await this.start();
    if (!address) return;
    const s = state();
    const next = { ...s, view: "terminal", shown: address, list: [...s.list.filter((a) => a !== address), address] };
    setShared(KEY, next);
    this.apply(next);
    run("layout.show", { id: "bottom" });
    run("pane.focus", { terminal: address });
  }

  show(address) {
    const next = { ...state(), view: "terminal", shown: address };
    setShared(KEY, next);
    this.apply(next);
    run("pane.focus", { terminal: address });
  }

  kill() {
    const s = state();
    if (!s.shown) return;
    run("terminal.kill", { terminal: s.shown });
    const list = s.list.filter((a) => a !== s.shown);
    const next = { ...s, shown: list[list.length - 1] ?? null, list };
    setShared(KEY, next);
    this.apply(next);
    if (!next.shown) run("layout.hide", { id: "bottom" });
  }

  maximize() {
    const b = this.bottom();
    const big = (b?.size?.px ?? SIZE) > SIZE + 40;
    run("layout.resize", { id: "bottom", px: big ? SIZE : 2000 });
  }

  // ── Run checks: the context repo's typecheck / lint scripts ───────────────────────────
  runChecks(cx) {
    if (this.checking) return;
    const c = ctx();
    if (!c.cwd) return notify({ title: "No repo to check", body: "Pick a repo in the Explorer, or focus a terminal inside one." });
    this.checking = true;
    cx.spawn(async (cx) => {
      let top = null;
      try {
        top = (await repoTop(this.tops, c.cwd, c.on)) ?? c.cwd;
        const p = await findProject(c.root?.path ?? top, c.on);
        const scripts = p ? pickChecks(p.groups[0]?.scripts ?? []) : [];
        if (!p || !scripts.length) {
          setShared("vx.checks", { ...checks(), [top]: { at: Date.now(), scripts: [], items: [], note: "No typecheck or lint script in package.json." } });
          return;
        }
        const pm = pmOf(p);
        setShared("vx.checks", { ...checks(), [top]: { ...(checks()[top] ?? {}), running: scripts, at: Date.now() } });
        const items = [];
        const failed = [];
        for (const name of scripts) {
          const r = await exec("sh", ["-lc", `${pm} run ${name} 2>&1`], { cwd: p.root, on: c.on, timeout: 600000 }).catch((e) => ({ code: -1, stdout: String(e?.message ?? e), stderr: "" }));
          const found = parseCheckOutput(`${r.stdout}\n${r.stderr}`, { root: top, dir: p.root }).map((i) => ({ ...i, script: name }));
          items.push(...found);
          if (r.code !== 0 && !found.length) failed.push(`${name} exited ${r.code} with nothing parsed: ${(r.stdout || r.stderr).trim().split("\n").slice(-2).join(" ")}`);
        }
        setShared("vx.checks", { ...checks(), [top]: { at: Date.now(), scripts, items, pm, note: failed.join("\n") || null } });
        const e = items.filter((i) => i.level === "error").length;
        notify({ title: `Checks done in ${baseName(top)}`, body: `${scripts.join(" + ")}: ${e} error${e === 1 ? "" : "s"}, ${items.length - e} warning${items.length - e === 1 ? "" : "s"}`, level: e ? "error" : "success", timeout: 4000 });
      } finally {
        this.checking = false;
        if (top && checks()[top]?.running) setShared("vx.checks", { ...checks(), [top]: { ...checks()[top], running: null } });
        cx.notify();
      }
    });
  }

  // Listening ports, counted for the status bar (vx.ports).
  countPorts(cx) {
    cx.spawn(async () => {
      const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).catch(() => null);
      const n = parsePorts(r?.stdout).length;
      if (shared("vx.ports") !== n) setShared("vx.ports", n);
    });
  }

  // ── PORTS ──────────────────────────────────────────────────────────────────────────────
  loadPorts(cx) {
    if (this.loadingPorts) return;
    this.loadingPorts = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"]).catch(() => null);
        const ports = parsePorts(r?.stdout);
        for (const p of ports) {
          if (this.cwds.has(p.pid)) continue;
          const c = await exec("lsof", ["-a", "-p", String(p.pid), "-d", "cwd", "-Fn"]).catch(() => null);
          this.cwds.set(p.pid, (c?.stdout ?? "").split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null);
        }
        this.ports = ports;
      } finally {
        this.loadingPorts = false;
        cx.notify();
      }
    });
  }

  renderPorts(t) {
    const roots = workspace()?.roots ?? [];
    const list = this.ports;
    const body = v_flex().id("vp-ports").size_full().bg(t.background).text_size(TEXT.small).text_color(t.foreground)
      .child(h_flex().h(24).flex_none().px(12).gap(8).items_center().text_size(TEXT.caption).text_color(t.dim).border_b(1).border_color(t.border)
        .child(div().w(70).child("PORT")).child(div().w(150).child("ADDRESS")).child(div().w(180).child("PROCESS")).child(div().flex_1().child("FOLDER")));
    if (!list) return body.child(div().p(12).text_color(t.dim).child("Looking for listening ports…"));
    if (!list.length) return body.child(div().p(12).text_color(t.dim).child("Nothing is listening on a TCP port here."));
    return body.child(v_flex().id("vp-port-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(list.map((p) => {
        const cwd = this.cwds.get(p.pid);
        const r = cwd ? rootFor(cwd, roots) : null;
        const folder = r ? `${r.name}${cwd.slice(r.path.length)}` : cwd ? cwd.replace(home(), "~") : "";
        const url = `http://localhost:${p.port}`;
        const local = [...p.hosts].every((h) => h === "127.0.0.1" || h === "[::1]" || h === "localhost");
        return h_flex().id(`port-${p.port}`).h(26).flex_none().px(12).gap(8).items_center().hover((s) => s.bg(t.hover))
          .child(h_flex().w(70).gap(5).items_center().child(Icon("plug", 12).text_color(r ? t.accent : t.dim)).child(String(p.port)))
          .child(div().w(150).truncate().text_color(t.muted).tooltip(local ? "Only this machine can reach it" : "Reachable from the network").child([...p.hosts].join(", ")))
          .child(div().w(180).truncate().text_color(t.muted).child(`${p.cmd} (${p.pid})`))
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).tooltip(cwd ?? "").child(folder))
          .child(div().id(`port-open-${p.port}`).size(22).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip(`Open ${url}`)
            .on_click(() => exec("open", [url]).catch(() => {})).child(Icon("globe", 13)))
          .child(div().id(`port-stop-${p.port}`).size(22).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
            .hover((s) => s.bg(t.raised).text_color(t.ansi1)).tooltip(`Stop ${p.cmd} (pid ${p.pid})…`)
            .on_click(() => askConfirm(MOD, { title: `Stop ${p.cmd} on port ${p.port}?`, detail: `Sends SIGTERM to pid ${p.pid}${folder ? ` (running in ${folder})` : ""}.`, label: "Stop", danger: true,
              action: { cmd: "kill", args: [String(p.pid)], doing: "Stopping", done: `Stopped ${p.cmd}` } }))
            .child(Icon("stop", 13)));
      })));
  }

  // ── PROBLEMS ──────────────────────────────────────────────────────────────────────────
  renderProblems(t) {
    const roots = workspace()?.roots ?? [];
    const ws = problems();
    const ch = checks();
    const c = ctx();
    const running = Object.entries(ch).find(([, v]) => v.running);
    const body = v_flex().id("vp-problems").size_full().bg(t.background).text_size(TEXT.small).text_color(t.foreground);
    const target = c.root?.name ?? (c.cwd ? baseName(c.cwd) : null);
    body.child(h_flex().h(28).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().id("vp-run-checks").h(22).px(8).gap(5).flex().items_center().rounded(5).cursor_pointer()
        .bg(running ? t.raised : t.solid ?? t.accent).text_color(running ? t.muted : t.solid_foreground ?? t.accent_foreground)
        .tooltip(target ? `Run the typecheck and lint scripts of ${target}` : "Pick a repo first")
        .on_click(() => run("vx-panel.checks"))
        .child(Icon(running ? "spinner" : "play", 11)).child(running ? `Running ${running[1].running.join(" + ")} in ${baseName(running[0])}…` : `Run checks${target ? ` · ${target}` : ""}`))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim)
        .child(Object.entries(ch).filter(([, v]) => v.at && !v.running && v.scripts?.length).map(([root, v]) => `${baseName(root)}: ${v.scripts?.length ? `${v.scripts.join(" + ")}, ${v.items.length} found` : v.note ?? "nothing to run"}`).join(" · "))));
    const rows = [];
    const rootRow = (key, name, n) => h_flex().id(`pr-h-${key}`).h(22).flex_none().px(10).gap(6).items_center().text_color(t.muted)
      .child(RootIcon(true, 13)).child(name).child(div().text_size(TEXT.caption).text_color(t.dim).child(String(n)));
    const glyph = (level) => div().w(14).flex_none().text_color(level === "error" ? t.ansi1 : t.ansi3).child(level === "error" ? "✕" : "!");
    // Workspace trouble, per repo.
    const byRoot = new Map();
    for (const p of ws) byRoot.set(p.root.path, [...(byRoot.get(p.root.path) ?? []), p]);
    for (const items of byRoot.values()) {
      rows.push(rootRow(items[0].root.path, items[0].root.name, items.length));
      for (const p of items) rows.push(h_flex().id(`pr-${p.id}`).h(22).flex_none().pl(28).pr(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(() => { setActive(p.root, "pick"); run("layout.select", { stack: "sidebar-views", child: p.view }); run("layout.show", { id: "sidebar" }); })
        .child(glyph(p.level)).child(div().flex_1().min_w(0).truncate().child(p.text)));
    }
    // Check results, per repo and file.
    for (const [rootPath, v] of Object.entries(ch)) {
      if (!v.items?.length && !v.note) continue;
      const r = rootFor(rootPath, roots) ?? { name: baseName(rootPath), path: rootPath };
      rows.push(rootRow(`ck-${rootPath}`, `${r.name} · ${(v.scripts ?? []).join(" + ") || "checks"}`, v.items?.length ?? 0));
      if (v.note) rows.push(div().id(`ck-note-${rootPath}`).pl(28).pr(10).py(2).text_size(TEXT.caption).text_color(t.dim).child(v.note));
      const byFile = new Map();
      for (const i of v.items ?? []) byFile.set(i.rel, [...(byFile.get(i.rel) ?? []), i]);
      for (const [rel, items] of byFile) {
        rows.push(h_flex().id(`ck-f-${rootPath}-${rel}`).h(22).flex_none().pl(24).pr(10).gap(6).items_center().text_color(t.foreground)
          .child(FileIcon(this.icons, rel, { size: 13 })).child(div().flex_none().max_w(260).truncate().child(baseName(rel)))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ""))
          .child(div().text_size(TEXT.caption).text_color(t.dim).child(String(items.length))));
        for (const [k, i] of items.entries()) rows.push(h_flex().id(`ck-${rootPath}-${rel}-${k}`).h(22).flex_none().pl(44).pr(10).gap(6).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
          .tooltip(`${rel}:${i.line}:${i.col}${i.rule ? ` · ${i.rule}` : ""}`)
          .on_click(() => showInViewer("vx-files", { root: rootPath, on: null, rel, line: i.line }, baseName(rel)))
          .child(glyph(i.level)).child(div().flex_1().min_w(0).truncate().child(i.message))
          .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(`${i.rule ? `${i.rule}  ` : ""}[Ln ${i.line}, Col ${i.col}]`)));
      }
    }
    if (!rows.length) return body.child(div().p(12).text_color(t.dim).child("No problems in the workspace: no conflicts, no failing pipelines, nothing behind. Run checks to type-check and lint the repo you're in."));
    return body.child(v_flex().id("vp-problem-rows").flex_1().min_h(0).overflow_y_scrollbar().py(4).children(rows));
  }

  // ── the header ─────────────────────────────────────────────────────────────────────────
  render() {
    if (this.confirmSpec) return ConfirmView(this);
    const t = theme();
    if (this.view === "ports") return this.renderPorts(t);
    if (this.view === "problems") return this.renderProblems(t);
    if (this.view === "empty") {
      return v_flex().size_full().items_center().justify_center().gap(6).bg(t.background).text_color(t.dim).text_size(TEXT.small)
        .child(Icon("terminal", 22)).child("No terminal yet. Press ⌘J, or + above.");
    }
    const s = state();
    const lv = live();
    const cur = lv.get(s.shown);
    const stop = (_e, cx) => cx.stop_propagation();
    const btn = (id, icon, tip, action) => div().id(`vp-${id}`).size(22).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(t.dim).hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click((_e, cx) => { action(cx); cx.notify(); }).child(Icon(icon, 14));
    const b = this.bottom();
    const big = (b?.size?.px ?? SIZE) > SIZE + 40;
    const pc = problemCounts();
    const counts = { problems: pc.errors + pc.warnings, ports: shared("vx.ports") || null };
    const tabEl = ([id, label]) => {
      const on = s.view === id;
      return h_flex().id(`vp-tab-${id}`).h_full().px(8).gap(5).flex_none().items_center().cursor_pointer()
        .text_color(on ? t.foreground : t.muted).hover((st) => st.text_color(t.foreground))
        .on_mouse_down("left", stop).on_click((_e, cx) => { this.pick(id); cx.notify(); })
        .child(div().h_full().flex().items_center().border_b(1).border_color(on ? t.foreground : "#00000000").child(label))
        .when(Boolean(counts[id]), (el) => el.child(div().h(15).min_w(15).px(4).rounded(8).flex().items_center().justify_center()
          .bg(t.raised).text_size(10).text_color(t.foreground).child(String(counts[id]))));
    };
    const shells = s.list.filter((a) => lv.has(a));
    const where = cur?.cwd ? (cur.cwd === home() ? "~" : baseName(cur.cwd)) : "";
    return h_flex().id("vx-panel").size_full().pl(4).pr(8).gap(2).items_center().bg(t.background).text_size(TEXT.small)
      .children(VIEWS.map(tabEl))
      .child(div().flex_1())
      .when(s.view === "terminal", (el) => el
        .when(shells.length > 1, (e2) => e2.children(shells.map((a, i) => div().id(`vp-t-${a}`).h(20).px(6).flex_none().flex().items_center().rounded(4).cursor_pointer()
          .bg(a === s.shown ? t.selected : "#00000000").text_color(a === s.shown ? t.foreground : t.muted).hover((st) => st.bg(t.hover))
          .tooltip(lv.get(a)?.cwd ?? a).on_mouse_down("left", stop).on_click((_e, cx) => { this.show(a); cx.notify(); })
          .child(`${i + 1}`))))
        .when(Boolean(cur), (e2) => e2.child(h_flex().h(20).px(6).gap(5).flex_none().items_center().text_color(t.muted).tooltip(cur?.cwd ?? "")
          .child(Icon("terminal", 12)).child(div().max_w(220).truncate().child(`${cur?.agent ?? "shell"} - ${where}`))))
        .child(btn("new", "plus", "New Terminal in the context repo", (cx) => cx.spawn(async (cx) => { await this.add(cx); cx.notify(); })))
        .child(btn("kill", "trash", "Kill Terminal", () => this.kill())))
      .child(btn("max", big ? "chevron-down" : "maximize", big ? "Restore Panel Size" : "Maximize Panel Size", () => this.maximize()))
      .child(btn("hide", "x", "Hide Panel (⌘J)", () => run("layout.hide", { id: "bottom" })));
  }
}

Object.assign(VxPanel.prototype, confirmMethods);
export default VxPanel;
