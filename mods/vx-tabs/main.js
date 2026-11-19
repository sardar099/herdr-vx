// vx-tabs: the tab bar.
//   tabs      icon (program, or the file's Material icon), label (italic while it's the reused
//             preview), a faint context (repo · branch, or the file's folder), a repo-colour
//             mark, status (spinner / needs-you dot), × on hover or when active. Pinned tabs
//             are icon-only on the left. Double-click a preview to keep it; double-click any
//             other tab to rename. Drag to reorder, right-click for the menu, wheel to switch.
//   ⌄         every tab in a searchable list (also the ⌘E switcher: vx-tabs.switch)
//   right     + · the package-script control · Files · Changes · CI · Graph (when the layout has
//             a right panel stack)
// props { style: "vscode" } draws VS Code's flush tabs (active: the editor's background) and its
// editor actions (split, all tabs). props { breadcrumbs: true } is the strip under the tabs:
// repo › folders › file for a file or diff tab, repo › folders for a terminal's folder.
import { View, div } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, layout, settings, notify, checking, props, shared, setShared, nextCommand, focused, home } from "herdr";
import { ctx, contextKey, repoTop, baseName, workspace, rootFor, setActive } from "./ws.js";
import { PM_ICON, findProject, pmOf, chosenOf, allScripts, runScript } from "./scripts.js";
import { Icon, FileIcon, RootIcon, TEXT } from "./ui.js";
import { showInViewer, keptTabs, viewerValue } from "./tabs.js";
import { image } from "gpui-kit";
import { describeTab, tabIcon, repoColor } from "./kinds.js";
import { popupMethods, postTabs } from "./popups.js";
import { loadIcons } from "./icons.js";

const MOD = "vx-tabs";
const PANELS = [["files", "Files", "file"], ["changes", "Changes", "branch"], ["ci", "CI", "ci"]];
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

class VxTabs extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.menu) return void (this.menu = p.menu);
    if (p.breadcrumbs) {
      this.crumbs = true;
      // Repaint only when the crumbs would change (every repaint redraws the whole window).
      if (!checking()) cx.timer.every(400, (cx) => {
        const key = this.crumbsKey();
        if (key === this.lastCrumbs) return;
        this.lastCrumbs = key;
        cx.notify();
      });
      return;
    }
    if (p.list) {
      this.listFocus = cx.focus_handle();
      this.initList(p, cx);
      return;
    }
    // mod.open:vx-tabs (a key) opens the switcher.
    if (p.overlay) {
      this.listFocus = cx.focus_handle();
      this.initList({ list: { mode: "switch" } }, cx);
      return;
    }
    this.style = p.style === "vscode" ? "vscode" : "pill";
    this.pressed = null;
    this.project = null;
    this.scroll = ScrollHandle.new();
    this.tops = new Map();
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    try {
      this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}") ?? {};
    } catch {
      this.panels = {};
    }
    if (checking()) return;
    this.cmdSeen = shared("vx.tabs.cmd")?.id ?? null;
    cx.timer.every(400, (cx) => this.follow(cx));
    cx.timer.every(15000, (cx) => { this.scriptsKey = null; this.detectScripts(cx); });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "switch") this.openSwitcher();
        if (c === "list") this.openList();
        cx.notify();
      }
    });
  }

  // ── every 400 ms: scripts, recent-tab order, commands from the popups, a pending keep ──
  follow(cx) {
    this.detectScripts(cx);
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (space && tab) {
      const mru = shared("vx.tabs.mru") ?? {};
      if (mru[space.id]?.[0] !== tab) setShared("vx.tabs.mru", { ...mru, [space.id]: [tab, ...(mru[space.id] ?? []).filter((x) => x !== tab)].slice(0, 30) });
    }
    const cmd = shared("vx.tabs.cmd");
    if (cmd?.id && cmd.id !== this.cmdSeen) {
      this.cmdSeen = cmd.id;
      if (cmd.cmd === "keep") this.keep(cmd.tab);
      if (cmd.cmd === "pin") this.pin(cmd.tab, true);
      if (cmd.cmd === "unpin") this.pin(cmd.tab, false);
    }
    // Forget kept / pinned tabs that are gone.
    if (!this.pruneAt || Date.now() - this.pruneAt > 5000) {
      this.pruneAt = Date.now();
      const live = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
      for (const key of ["vx.tabs.kept", "vx.tabs.pinned"]) {
        const map = shared(key) ?? {};
        const kept = Object.fromEntries(Object.entries(map).filter(([id]) => live.has(id)));
        if (Object.keys(kept).length !== Object.keys(map).length) setShared(key, kept);
      }
    }
  }

  // The preview becomes a tab of its own, in place: recorded in vx.tabs.kept, which its copy
  // (vx-files / vx-changes) follows from then on; the next file you open gets a fresh preview.
  keep(tabId) {
    const space = spaces().find((s) => s.active);
    const pane = panes().find((p) => p.tab === tabId && (p.mod === "vx-files" || p.mod === "vx-changes"));
    if (!space || !pane || keptTabs()[tabId]) return;
    const value = viewerValue(pane.mod, space.id);
    if (!value) return;
    const { at: _at, opening: _o, line: _l, ...rest } = value;
    setShared("vx.tabs.kept", { ...keptTabs(), [tabId]: { mod: pane.mod, value: rest } });
  }

  pin(tabId, on) {
    const pinned = { ...(shared("vx.tabs.pinned") ?? {}) };
    if (on) {
      const count = Object.keys(pinned).length;
      pinned[tabId] = true;
      run("tab.move", { id: tabId, index: count + 1 });
    } else delete pinned[tabId];
    setShared("vx.tabs.pinned", pinned);
  }

  openSwitcher() {
    openOverlay({ mod: MOD, kind: "dialog", width: 520, height: 420, props: { list: { mode: "switch" } } });
  }

  openList() {
    openOverlay({ mod: MOD, kind: "popup", width: 420, height: 420, props: { list: { mode: "list" } } });
  }

  // ── wheel: one notch or ~25 px of swipe moves one tab ─────────────────────────────────
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next");
      return;
    }
    const s = this.swipe;
    const now = Date.now();
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    run(e.delta.y > 0 ? "tab.prev" : "tab.next");
  }

  // ── the right-panel buttons remember each space's open panel ──────────────────────────
  syncPanel(space, panel, body) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    const ids = PANELS.map((p) => p[0]);
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null;
        const want = ids.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) this.showPanel(want);
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  showPanel(id) {
    run("layout.select", { stack: "panel-body", child: id });
    run("layout.show", { id: "panel" });
  }

  openGraph(cx) {
    const c = ctx();
    if (!c.cwd) return notify({ title: "No repo to graph", body: "Pick a repo in the Explorer, or focus a terminal inside one." });
    cx.spawn(async () => {
      const top = await repoTop(this.tops, c.cwd, c.on);
      if (!top) return notify({ title: "Not a git repository", body: c.cwd });
      showInViewer("vx-graph", { root: top, on: c.on ?? null }, `Graph · ${baseName(top)}`);
    });
  }

  // ── the package-script control ─────────────────────────────────────────────────────────
  detectScripts(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key === this.scriptsKey || this.scanning) return;
    this.scriptsKey = key;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
        const start = c.source === "focus" || c.source === "repo" ? c.cwd : top ?? c.cwd;
        const project = start ? await findProject(start, c.on) : null;
        if (JSON.stringify(project) !== JSON.stringify(this.project)) {
          this.project = project;
          cx.notify();
        }
      } finally {
        this.scanning = false;
      }
    });
  }

  scriptsControl(t, stop) {
    const p = this.project;
    if (!p) return null;
    const x = chosenOf(p);
    const pm = pmOf(p);
    const rows = Math.min(16, allScripts(p).length + p.groups.length);
    return h_flex().flex_none().items_center()
      .child(h_flex().id("sc-pick").h(24).max_w(150).px(7).gap(5).items_center().rounded_l(5).border_1().border_color(t.border).bg(t.background)
        .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`${p.name}: ${allScripts(p).length} scripts · ${pm}\n${pm} run ${x.s.name}\n${x.s.cmd}`)
        .on_mouse_down("left", stop)
        .on_click(() => openOverlay({ mod: "vx-scripts", kind: "popup", width: 420, height: 112 + rows * 36, props: { menu: { project: p } } }))
        .child(image(PM_ICON(pm)).size(13).flex_none())
        .child(div().truncate().text_size(12).text_color(t.foreground).child(x.s.name))
        .child(Icon("chevron-down", 11).text_color(t.dim)))
      .child(div().id("sc-run").h(24).w(26).flex().items_center().justify_center().rounded_r(5).border_1().border_color(t.border).bg(t.background)
        .text_color(t.ansi2).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(`Run ${x.s.name} in a new tab`)
        .on_mouse_down("left", stop).on_click(() => runScript(p, x))
        .child(Icon("play", 11)));
  }

  // ── one tab ────────────────────────────────────────────────────────────────────────────
  tabEl(t, c, i, shown, active, space, stop) {
    const d = describeTab(c, space.id);
    const pinned = Boolean(shared("vx.tabs.pinned")?.[c.id]);
    const vs = this.style === "vscode";
    const hovered = this.hovered === c.id;
    const italic = (d.kind === "preview" || d.kind === "diff") && d.preview;
    const color = repoColor(d.repo, t);
    const busy = c.status === "working";
    const needs = c.status === "blocked" || c.status === "done";
    const file = d.value?.root && (d.value.rel ?? d.value.path) ? `${d.value.root}/${d.value.rel ?? d.value.path}` : null;
    const dirty = Boolean(file && shared("vx.dirty")?.[file]);
    const showClose = !pinned && (hovered || (c.active && !dirty));
    const status = busy ? Icon("spinner", 12).text_color(t.working).spin(900) : needs ? div().size(7).rounded(4).bg(t[c.status]) : null;
    const closeBtn = div().id(`close-${c.id}`).size(18).flex().items_center().justify_center().rounded(4).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
      .child(Icon("x", 12));
    const el = h_flex().id(`tab-${c.id}`).flex_none().items_center().gap(6).text_size(12.8)
      .when(i <= active, (e2) => e2.on_size_change((_s, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
      .tooltip([d.label, d.context, pinned ? "pinned" : italic ? "preview: double-click to keep" : ""].filter(Boolean).join("\n"))
      .on_hover((h, cx) => { if (h) this.hovered = c.id; else if (this.hovered === c.id) this.hovered = null; cx.notify(); })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressed = i;
        if (e.click_count === 2) {
          if (italic) postTabs({ cmd: "keep", tab: c.id });
          else run("tab.rename", { id: c.id });
        }
      })
      .on_mouse_up("left", () => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: shown.findIndex((x) => x.id === c.id) + 1 });
        else run("tab.select", { id: c.id });
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: MOD, kind: "popup", width: 240, height: 250, props: { menu: { tab: c.id, preview: italic } } }); });
    if (vs) {
      el.h_full().pl(pinned ? 10 : 10).pr(pinned ? 10 : 6).relative().border_r(1).border_color(t.border)
        .bg(c.active ? t.background : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .when(!c.active, (e2) => e2.hover((s) => s.bg(t.hover)));
    } else {
      el.h(29).px(10).rounded(7).border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome)
        .text_color(c.active ? t.foreground : t.muted).hover((s) => s.bg(t.hover));
    }
    el.when(Boolean(color) && !pinned, (e2) => e2.child(div().w(3).h(14).flex_none().rounded(2).bg(color)))
      .child(tabIcon(d, this.icons, 14));
    if (pinned) return el.when(Boolean(status), (e2) => e2.child(status));
    return el
      .child(div().max_w(170).truncate().when(italic, (e2) => e2.italic()).child(c.zoomed ? `${d.label} Z` : d.label))
      .when(Boolean(d.context) && d.context !== d.label, (e2) => e2.child(div().max_w(140).truncate().text_size(11.5).text_color(t.dim).child(d.context)))
      .child(div().w(18).flex_none().flex().items_center().justify_center()
        .child(showClose ? closeBtn : dirty ? div().size(8).rounded(4).bg(t.foreground) : status ?? div()));
  }

  // ── breadcrumbs ────────────────────────────────────────────────────────────────────────
  // What the strip shows, as a string: the active tab and what it points at.
  crumbsKey() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((x) => x.active);
    if (!tab) return "";
    const d = describeTab(tab, space.id);
    return JSON.stringify([tab.id, tab.name, d.kind, d.value?.root, d.file, d.value?.scope, d.value?.sha, d.lead?.cwd, (workspace()?.roots ?? []).map((r) => r.path)]);
  }

  renderCrumbs() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((x) => x.active);
    const bar = h_flex().id("vx-crumbs").size_full().px(12).gap(2).items_center().overflow_hidden().bg(t.background).text_size(TEXT.small).text_color(t.muted);
    if (!tab) return bar;
    const d = describeTab(tab, space.id);
    const roots = workspace()?.roots ?? [];
    let rootPath = null;
    let parts = [];
    let fileIcon = null;
    if ((d.kind === "preview" || d.kind === "diff") && d.value?.root) {
      rootPath = d.value.root;
      parts = (d.file ?? "").split("/").filter(Boolean);
      fileIcon = d.file;
    } else if (d.kind === "graph") {
      return bar.child(Icon("git-commit", 13).text_color(t.accent)).child(div().pl(4).child(tab.name));
    } else {
      const cwd = d.lead?.cwd;
      if (!cwd) return bar;
      const r = rootFor(cwd, roots);
      if (r) {
        rootPath = r.path;
        parts = cwd.slice(r.path.length).split("/").filter(Boolean);
      } else parts = cwd.replace(home(), "~").split("/").filter(Boolean);
    }
    const root = rootPath ? rootFor(rootPath, roots) ?? { name: baseName(rootPath), path: rootPath } : null;
    const sep = () => Icon("chevron-right", 12).text_color(t.dim);
    const crumb = (id, label, { icon, tip, onClick, last } = {}) => h_flex().id(id).h(20).px(3).gap(4).flex_none().items_center().rounded(4)
      .text_color(last ? t.foreground : t.muted).when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { onClick(); cx.notify(); }))
      .when(Boolean(icon), (el) => el.child(icon)).child(div().max_w(220).truncate().child(label));
    const items = [];
    if (root) items.push(crumb("cr-root", root.name, { icon: d.kind === "agent" || d.kind === "terminal" ? Icon("terminal", 13).text_color(t.dim) : RootIcon(false, 13), tip: `${root.path}\nShow in the Explorer`,
      onClick: () => { if (roots.some((r) => r.path === root.path)) setActive(root, "pick"); run("layout.select", { stack: "sidebar-views", child: "explorer" }); run("layout.show", { id: "sidebar" }); } }));
    parts.forEach((part, i) => {
      const last = i === parts.length - 1;
      if (items.length) items.push(sep());
      items.push(crumb(`cr-${i}`, part, { last, icon: last && fileIcon ? FileIcon(this.icons, fileIcon, { size: 13 }) : null }));
    });
    if (d.kind === "diff" && d.value?.scope) items.push(div().pl(6).text_size(TEXT.caption).text_color(t.dim).child(d.value.scope === "commit" ? `@ ${String(d.value.sha ?? "").slice(0, 7)}` : d.value.scope));
    return bar.children(items);
  }

  render() {
    if (this.menu) return this.renderMenu();
    if (this.crumbs) return this.renderCrumbs();
    if (this.list) return this.renderList();
    const t = theme();
    const space = spaces().find((s) => s.active);
    const shown = (space?.tabs ?? []).filter((x) => !x.settled);
    const active = shown.findIndex((x) => x.active);
    if (shown[active]?.id !== this.selected || active !== this.selectedIndex) {
      this.selected = shown[active]?.id;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const vs = this.style === "vscode";
    const button = (id, label, action, tip) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .when(Boolean(tip), (el) => el.tooltip(tip))
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop).on_click(action).child(label);
    const root = layout();
    const sidebar = find(root, "sidebar");
    const w = window();
    const lights = !vs && w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : vs ? 10 : 10;
    const panel = find(root, "panel");
    const body = find(root, "panel-body");
    this.syncPanel(space, panel, body);
    const present = new Set((body?.children ?? []).map((c) => c.id));
    const panelButton = ([id, label, icon]) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click(() => (on ? run("layout.hide", { id: "panel" }) : this.showPanel(id)))
        .child(Icon(icon, 14)).child(label);
    };
    const hasPanels = PANELS.some(([id]) => present.has(id));
    return h_flex().size_full().min_w(0).pl(lights).pr(vs ? 6 : 10).gap(vs ? 0 : 3).items_center().bg(t.chrome).when(vs, (el) => el.rounded_t(11)).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel((e) => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(vs ? 0 : 3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_s, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map((c, i) => this.tabEl(t, c, i, shown, active, space, stop))))
      .child(button("tab-new", Icon("plus", 14), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }), "New terminal or agent"))
      .when(vs, (el) => el.child(button("tab-split", Icon("split", 14), () => run("pane.split", { direction: "right" }), "Split Right")))
      .child(button("tab-list", Icon(vs ? "more" : "chevron-down", 14), () => this.openList(), `All tabs (${shown.length})`))
      .when(Boolean(this.project), (el) => el.child(div().w(6)).child(this.scriptsControl(t, stop)))
      .when(hasPanels, (el) => el
        .child(div().w(1).h(18).mx(6).flex_none().bg(t.border))
        .children(PANELS.filter(([id]) => present.has(id)).map(panelButton))
        .child(h_flex().id("graph").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12).text_color(t.muted)
          .hover((s) => s.bg(t.hover)).tooltip("Commit Graph of the repo the panels show").on_mouse_down("left", stop)
          .on_click((_e, cx) => this.openGraph(cx)).child(Icon("git-commit", 14)).child("Graph")))
      .when(Boolean(w?.buttons) && !vs, (el) => el
        .child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", Icon("x", 13), () => run("window.close"))));
  }
}

Object.assign(VxTabs.prototype, popupMethods);
export default VxTabs;
