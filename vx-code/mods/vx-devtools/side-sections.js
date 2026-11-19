// Collapsible side-bar sections (VS Code's Timeline, NPM Scripts): a layout block whose mod draws
// a 22 px header and, when open, its body. Collapsing resizes the block to the header
// (layout.resize), so the layout remembers it like any other click.
//   props { section: "<kind>", block: "<layout block id>" }
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run } from "herdr";
import { findNode } from "./layout-core.js";
import { Icon } from "./ui.js";

export const SECTION_HEAD = 22;
const OPEN_PX = 220;

export function sectionOpen(block) {
  const n = findNode(layout(), block);
  return Boolean(n) && (n.size?.px ?? OPEN_PX) > SECTION_HEAD + 2;
}

export function toggleSection(block) {
  const n = findNode(layout(), block);
  if (!n) return;
  if (sectionOpen(block)) {
    try {
      localStorage.setItem(`open:${block}`, String(n.size?.px ?? OPEN_PX));
    } catch {}
    run("layout.resize", { id: block, px: SECTION_HEAD });
  } else {
    let px = OPEN_PX;
    try {
      px = Number(localStorage.getItem(`open:${block}`)) || OPEN_PX;
    } catch {}
    run("layout.resize", { id: block, px });
  }
}

// The header row: chevron, TITLE, and (when open) controls on the right.
export function SectionHead(t, { block, title, open, right = [], count }) {
  return h_flex().id(`sec-${block}`).h(SECTION_HEAD).flex_none().pl(4).pr(6).gap(4).items_center().cursor_pointer()
    .border_t(1).border_color(t.border).text_size(11).font_medium().text_color(t.foreground)
    .on_click((_e, cx) => { toggleSection(block); cx.notify(); })
    .child(Icon(open ? "chevron-down" : "chevron-right", 14).text_color(t.muted))
    .child(div().flex_1().min_w(0).truncate().child(title.toUpperCase()))
    .when(count !== undefined && count !== null && !open, (el) => el.child(div().text_color(t.dim).child(String(count))))
    .when(open, (el) => el.children(right.filter(Boolean)));
}
