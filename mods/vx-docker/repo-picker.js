// The "repo ▾" switcher in the Changes, CI and Graph headers. Choosing a repo makes it the
// active one for every vx panel (a pick: it wins over the focused terminal until focus moves).
// The list is a popup copy of the same mod opened with props { repoMenu: { current } }.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, shared } from "herdr";
import { workspace, setActive, baseName } from "./ws.js";
import { TEXT, Icon, FileIcon } from "./ui.js";

const ROW = 30;

export function RepoButton(view, mod, current) {
  const t = theme();
  const roots = workspace()?.roots ?? [];
  const root = roots.find((r) => r.path === current);
  const label = root?.name ?? (current ? baseName(current) : "Pick a repo");
  return h_flex()
    .id(`${mod}-repo`).h(26).min_w(0).px(6).gap(6).items_center().rounded(6).cursor_pointer()
    .hover((s) => s.bg(t.hover)).tooltip(current ? `${current}\nSwitch repo` : "Switch repo")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click(() => {
      if (!roots.length) return;
      openOverlay({ mod, kind: "popup", width: 280, height: Math.min(12, roots.length) * ROW + 40, props: { repoMenu: { current } } });
    })
    .child(FileIcon(view.icons, label, { dir: true, open: true, size: 15 }))
    .child(div().min_w(0).truncate().font_medium().text_size(TEXT.body).text_color(t.foreground).child(label))
    .child(Icon("chevron-down", 11).text_color(t.dim));
}

export function RepoMenu(view) {
  const t = theme();
  const ws = workspace();
  const git = shared("vx.git") ?? {};
  const current = view.repoMenu?.current;
  return v_flex().id("repo-menu").size_full().p(6).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground)
    .child(div().h(22).px(8).flex().items_center().text_size(TEXT.caption).text_color(t.dim).child((ws?.name ?? "Workspace").toUpperCase()))
    // A popup sizes to its content, so the list says how tall it is (it scrolls past 12 rows).
    .child(v_flex().id("repo-list").flex_none().h(Math.max(ROW, Math.min(12, ws?.roots?.length ?? 0) * (ROW + 1))).overflow_y_scrollbar().gap(1)
      .children((ws?.roots ?? []).map((r) => h_flex().id(`rp-${r.path}`).h(ROW).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .bg(r.path === current ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
        .on_click(() => { setActive(r, "pick"); closeOverlay(props()?.overlay); })
        .child(FileIcon(view.icons, r.name, { dir: true, size: 15 }))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(r.name))
        .child(div().max_w(100).truncate().text_size(TEXT.caption).text_color(t.dim).child(git[r.path]?.branch ?? ""))
        .child(div().w(14).flex_none().when(r.path === current, (el) => el.child(Icon("check", 12).text_color(t.accent)))))));
}
