// vx-activity: VS Code's activity bar, for the vx-code layout. One icon per side-bar view
// (layout stack "sidebar-views"): Explorer, Source Control (changed files across the workspace),
// CI (a dot when a repo's latest pipeline failed or runs), Spaces, Agents (agents waiting on you).
// The shown view gets an accent bar; clicking it again hides the side bar, like VS Code.
// Below: Graph (the vx-graph tab of the context repo) and Settings.
// props { title: true }: the side bar's title row (EXPLORER, SOURCE CONTROL, …) above the views.
// Docker shows how many containers run. Keys: vx-activity.explorer / scm / ci / docker / spaces / agents show that view; vx-activity.panel
// shows or hides the bottom panel (⌘J).
import { View, div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme, layout, run, shared, setShared, agents, nextCommand, notify, checking, props, spaces, panes } from "herdr";
import { ctx, repoTop, baseName, workspace } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { Icon } from "./ui.js";

const STACK = "sidebar-views";
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

const VIEWS = [
  { id: "explorer", icon: "files", title: "Explorer (⌘⇧E)", name: "Explorer" },
  { id: "search", icon: "search", title: "Search (⌘⇧F)", name: "Search" },
  { id: "scm", icon: "branch", title: "Source Control (⌘⇧G)", name: "Source Control" },
  { id: "ci", icon: "ci", title: "CI / CD", name: "CI / CD" },
  { id: "docker", icon: "container", title: "Docker (⌘⌥D)", name: "Docker" },
  { id: "http", icon: "globe", title: "HTTP Client (⌘⌥R)", name: "HTTP Client" },
  { id: "spaces", icon: "layers", title: "Spaces", name: "Spaces" },
  { id: "agents", icon: "bot", title: "Agents", name: "Agents" },
];

class VxActivity extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    this.tops = new Map();
    if (p.title) {
      this.title = true;
      if (!checking()) cx.timer.every(300, (cx) => cx.notify());
      return;
    }
    if (checking()) return;
    cx.timer.every(1500, (cx) => cx.notify());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (VIEWS.some((v) => v.id === c)) this.show(c);
        if (c === "panel") this.togglePanel();
        // The bottom panel's tabs and actions, from anywhere (its header only hears keys while shown).
        if (["problems", "terminal", "ports"].includes(c)) this.panelView(c);
        if (c === "checks") this.panelView("problems", "vx-panel.checks", cx);
        if (c === "newterm") this.panelView("terminal", "vx-panel.new", cx);
        if (c === "devtools") this.openDevtools();
        cx.notify();
      }
    });
  }

  shown() {
    const root = layout();
    const side = find(root, "sidebar");
    if (!side || side.hidden) return null;
    return find(root, STACK)?.active ?? null;
  }

  show(id) {
    run("layout.select", { stack: STACK, child: id });
    run("layout.show", { id: "sidebar" });
    if (id === "search") run("vx-search.focus");
  }

  click(id) {
    if (this.shown() === id) run("layout.hide", { id: "sidebar" });
    else this.show(id);
  }

  // ⌘J: the bottom panel (vx-panel starts a shell when it appears with none).
  togglePanel() {
    const b = find(layout(), "bottom");
    if (!b) return notify({ title: "No bottom panel in this layout" });
    if (!b.hidden) return run("layout.hide", { id: "bottom" });
    run("layout.show", { id: "bottom" });
    const s = shared("vx.panel");
    if (s?.shown) run("pane.focus", { terminal: s.shown });
  }

  panelView(view, then, cx) {
    setShared("vx.panel", { ...(shared("vx.panel") ?? {}), view });
    run("layout.show", { id: "bottom" });
    if (then) cx.timer.after(600, () => run(then));
  }

  // The Dev Tools tab: the one already open in this space, or a new one.
  openDevtools() {
    const space = spaces().find((s) => s.active);
    const tab = shared("vx.devtools.tab");
    if (tab && space?.tabs?.some((t) => t.id === tab) && panes().some((p) => p.tab === tab && p.mod === "vx-devtools")) return run("tab.select", { id: tab });
    run("tab.new", { name: "Dev Tools", mod: "vx-devtools", props: {}, ...(space ? { space: space.id } : {}) });
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

  badges(t) {
    const roots = workspace()?.roots ?? [];
    const g = shared("vx.git") ?? {};
    const changed = roots.reduce((n, r) => n + (g[r.path]?.changed ?? 0), 0);
    const ci = shared("vx.ci.summary") ?? {};
    const kinds = roots.map((r) => ci[r.path]?.kind).filter(Boolean);
    const ciDot = kinds.includes("failure") ? t.ansi1 : kinds.includes("running") ? t.ansi4 : null;
    const waiting = (agents() ?? []).filter((a) => a.status === "blocked" || a.status === "done").length;
    const dk = shared("vx.docker.summary");
    return { scm: changed ? String(changed > 999 ? "999+" : changed) : null, ci: ciDot, agents: waiting ? String(waiting) : null, docker: dk?.running ? String(dk.running) : null };
  }

  item(t, id, icon, title, on, onClick, badge) {
    const fg = t.accent_foreground ?? "#ffffff";
    return div().id(`act-${id}`).w_full().h(48).flex_none().relative().flex().items_center().justify_center().cursor_pointer()
      .text_color(on ? t.foreground : t.dim).hover((s) => s.text_color(t.foreground)).tooltip(title)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { onClick(cx); cx.notify(); })
      .child(Icon(icon, 22))
      .when(typeof badge === "string" && !badge.startsWith("#"), (el) => el.child(div().absolute().right(6).bottom(8).h(15).min_w(15).px(4).rounded(8)
        .flex().items_center().justify_center().bg(t.accent).text_color(fg).text_size(9.5).font_medium().child(badge)))
      .when(typeof badge === "string" && badge.startsWith("#"), (el) => el.child(div().absolute().right(10).bottom(11).size(8).rounded(4).bg(badge)));
  }

  renderTitle() {
    const t = theme();
    const v = VIEWS.find((x) => x.id === find(layout(), STACK)?.active);
    return div().id("vx-side-title").size_full().pl(20).pr(8).flex().items_center().bg(t.chrome)
      .text_size(11).font_medium().text_color(t.foreground).child((v?.name ?? "").toUpperCase());
  }

  render() {
    if (this.title) return this.renderTitle();
    const t = theme();
    const root = layout();
    const stack = find(root, STACK);
    const present = new Set((stack?.children ?? []).map((c) => c.id));
    const on = this.shown();
    const b = this.badges(t);
    return v_flex().id("vx-activity").size_full().items_center().bg(t.canvas ?? t.chrome)
      .children(VIEWS.filter((v) => present.has(v.id)).map((v) => this.item(t, v.id, v.icon, v.title, on === v.id, () => this.click(v.id), b[v.id] ?? null)))
      .child(div().flex_1())
      .child(this.item(t, "devtools", "wrench", "Dev Tools (⌘⌥T for the quick popup)", false, () => this.openDevtools(), null))
      .child(this.item(t, "graph", "git-commit", "Commit Graph of the context repo", false, (cx) => this.openGraph(cx), null))
      .child(this.item(t, "settings", "gear", "Settings", false, () => run("app.settings"), null));
  }
}

export default VxActivity;
