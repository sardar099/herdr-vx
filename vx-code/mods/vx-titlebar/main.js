// vx-titlebar: VS Code's title bar, for the vx-code layout (a window_drag block).
//   left     room for the traffic lights, then the workspace's name
//   centre   ← → (back / forward through the tabs you visited) and the command center: opens
//            Go to File (⌘P, vx-titlebar.goto)
//   right    customise layout (Settings › Look), toggle the side bar, the panel, the right panel
// Quick Open is a popup copy (props { goto }): quickopen.js.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, layout, run, window, settings, openOverlay, props, nextCommand, checking, spaces, notify } from "herdr";
import { workspace, ctx } from "./ws.js";
import { quickMethods, QO_ROW, QO_ROWS, QO_HEAD } from "./quickopen.js";
import { emptyNav, navVisit, navStep } from "./nav-core.js";
import { TEXT, Icon } from "./ui.js";
import { loadIcons } from "./icons.js";

const MOD = "vx-titlebar";
const find = (n, id) => (n?.id === id ? n : (n?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null);

class VxTitlebar extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.goto) return this.initQuick(p, cx);
    this.width = 1200;
    this.nav = new Map(); // space -> { list: [tab ids], at }
    if (checking()) return;
    cx.timer.every(300, (cx) => this.track(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "goto") this.openGoto();
        if (c === "commands") this.openGoto("> ");
        if (c === "symbols") this.openGoto("@");
        if (c === "line") this.openGoto(":");
        if (c === "plans") this.openGoto("~");
        if (c === "help") this.openGoto("?");
        if (c === "chat") this.toggleChat();
        if (c === "back") this.go(-1);
        if (c === "forward") this.go(1);
        cx.notify();
      }
    });
  }

  // ── back / forward: the tabs you visited in this space, like VS Code's navigation ──────
  track(cx) {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (!space || !tab) return;
    const h = this.nav.get(space.id) ?? emptyNav();
    if (h.list[h.at] === tab) return;
    if (this.going === tab) this.going = null;
    else this.nav.set(space.id, navVisit(h, tab));
    cx.notify();
  }

  go(step) {
    const space = spaces().find((s) => s.active);
    const h = space && this.nav.get(space.id);
    const next = h && navStep(h, step, new Set((space.tabs ?? []).map((t) => t.id)));
    if (!next) return;
    this.nav.set(space.id, next);
    this.going = next.list[next.at];
    run("tab.select", { id: this.going });
  }

  canGo(step) {
    const space = spaces().find((s) => s.active);
    const h = space && this.nav.get(space.id);
    return Boolean(h && navStep(h, step, new Set((space.tabs ?? []).map((t) => t.id))));
  }

  // The chat column (vx-chat), VS Code's secondary side bar: show it and put the keyboard in
  // its box, or hide it.
  toggleChat() {
    const chat = find(layout(), "chat");
    if (!chat) return notify({ title: "No chat panel in this layout", level: "warning" });
    if (!chat.hidden) return run("layout.hide", { id: "chat" });
    run("layout.show", { id: "chat" });
    run("vx-chat.focus");
  }

  // Quick Open sits over the command center, like VS Code's.
  openGoto(query = "") {
    const width = Math.round(Math.min(720, Math.max(440, this.width * 0.42)));
    openOverlay({ mod: MOD, kind: "popup", width, height: QO_HEAD + QO_ROWS * QO_ROW + 6, at: { x: Math.round((this.width - width) / 2), y: 5 }, props: { goto: { query } } });
  }

  // ── the bar ────────────────────────────────────────────────────────────────────────────
  render() {
    if (this.quick) return this.renderQuick();
    const t = theme();
    const root = layout();
    const w = window();
    const zoom = settings().zoom || 1;
    const lights = w?.platform === "macos" && !w.fullscreen && root?.traffic_lights ? (root.traffic_lights[0] + 64) / zoom : 12;
    const stop = (_e, cx) => cx.stop_propagation();
    const ws = workspace();
    const label = ws?.name ?? (ctx().root?.name ?? "Herdr");
    const toggle = (id, icon, tip, on, action) => div().id(`tb-${id}`).size(26).flex_none().flex().items_center().justify_center().rounded(5)
      .text_color(on ? t.foreground : t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(action).child(Icon(icon, 15));
    const side = find(root, "sidebar");
    const bottom = find(root, "bottom");
    const right = find(root, "panel");
    const chat = find(root, "chat");
    const center = Math.min(520, Math.max(200, this.width * 0.34));
    return h_flex().id("vx-titlebar").size_full().items_center().bg(t.canvas ?? t.chrome).text_size(TEXT.small)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } })
      .child(h_flex().flex_1().min_w(0).h_full().pl(lights).gap(6).items_center()
        .child(div().id("tb-ws").px(6).h(24).flex().items_center().rounded(5).truncate().text_color(t.muted).font_medium()
          .hover((s) => s.bg(t.hover)).tooltip(ws?.file ? `Workspace: ${ws.file}` : "No workspace open")
          .on_mouse_down("left", stop)
          .on_click(() => { run("layout.select", { stack: "sidebar-views", child: "explorer" }); run("layout.show", { id: "sidebar" }); })
          .child(label)))
      .child(toggle("back", "back", "Go Back", false, () => this.go(-1)).when(!this.canGo(-1), (el) => el.opacity(0.4)))
      .child(toggle("fwd", "forward", "Go Forward", false, () => this.go(1)).when(!this.canGo(1), (el) => el.opacity(0.4)))
      .child(div().w(6))
      .child(h_flex().id("tb-cc").w(center).h(24).flex_none().px(8).gap(6).items_center().justify_center().rounded(6)
        .border_1().border_color(t.border).bg(t.input ?? t.background).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.muted)).tooltip("Search files by name (⌘P) · > for commands · ? for help")
        .on_mouse_down("left", stop).on_click(() => this.openGoto())
        .child(Icon("search", 12)).child(div().truncate().child(ws?.file ? `${label} (Workspace)` : label)))
      .when(Boolean(chat), (el) => el.child(h_flex().id("tb-chat").h(24).ml(6).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer()
        .bg(chat && !chat.hidden ? t.selected : "#00000000").text_color(chat && !chat.hidden ? t.foreground : t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Claude Chat (⌘⌥I)")
        .on_mouse_down("left", stop).on_click(() => this.toggleChat())
        .child(Icon("sparkles", 13).text_color(t.accent)).child(div().text_size(TEXT.small).child("Chat"))))
      .child(h_flex().flex_1().min_w(0).h_full().pr(8).gap(2).items_center().justify_end()
        .child(toggle("look", "layout", "Customize Layout (Settings › Look)", false, () => run("app.settings", { section: "look" })))
        .when(Boolean(side), (el) => el.child(toggle("side", "sidebar", "Toggle Side Bar (⌘B)", !side.hidden, () => run("layout.toggle", { id: "sidebar" }))))
        .when(Boolean(bottom), (el) => el.child(toggle("bottom", "panel", "Toggle Panel (⌘J)", !bottom.hidden, () => run("vx-activity.panel"))))
        .when(Boolean(right), (el) => el.child(toggle("right", "panel-right", "Toggle Right Panel", !right.hidden, () => run("layout.toggle", { id: "panel" }))))
        .when(Boolean(chat), (el) => el.child(toggle("chat", "panel-right", "Toggle Secondary Side Bar · Claude Chat (⌘⌥I)", !chat.hidden, () => this.toggleChat())))
        .when(Boolean(w?.buttons), (el) => el
          .child(toggle("min", "minus", "Minimize", false, () => run("window.minimize")))
          .child(toggle("max", "maximize", "Maximize", false, () => run("window.maximize")))
          .child(toggle("close", "x", "Close", false, () => run("window.close")))));
  }
}

Object.assign(VxTitlebar.prototype, quickMethods);
export default VxTitlebar;
