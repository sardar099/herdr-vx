// The vx look: Herdr's own sizes and colours as small components. Values in, callbacks out.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, settings } from "herdr";
import { iconFor, isLight } from "./icons-core.js";

export const TEXT = { tiny: 10, caption: 11, small: 12, body: 13, title: 14 };
export const SPIN_MS = 900;
export const UI = (name) => `mods/vx-icons/ui/${name}.svg`;
export const codeFont = () => settings().font_family ?? "JetBrains Mono";
export const codeSize = () => settings().font_size ?? 14;
export const tint = (color, alpha = "26") => (/^#[0-9a-f]{6}/i.test(color ?? "") ? `${color.slice(0, 7)}${alpha}` : color);

export const Icon = (name, size = 14) => svg(UI(name)).size(size).flex_none();

// A workspace root, as the Material Icon Theme draws one in VS Code: a ring, dotted when closed.
export const RootIcon = (open = false, size = 14) => image(`mods/vx-icons/icons/folder-root${open ? "-open" : ""}.svg`).size(size).flex_none();

// A file or folder picture from vx-icons' table; the plain icon when the table isn't loaded.
export function FileIcon(table, path, { dir = false, open = false, size = 14, color } = {}) {
  const t = theme();
  const pic = iconFor(table, path, { dir, open, light: isLight(t.background) });
  return pic ? image(pic).size(size).flex_none() : Icon(dir ? "folder" : "file", size).text_color(color ?? t.muted);
}

export function Panel(id) {
  const t = theme();
  return v_flex().id(id).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body);
}

export function Header() {
  const t = theme();
  return h_flex().h(40).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border);
}

export function Badge(text, color) {
  const t = theme();
  return div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(TEXT.tiny).text_color(color ?? t.muted).child(String(text));
}

export function IconButton({ id, icon, label, onClick, spinning = false, active = false, size = 24, disabled = false }) {
  const t = theme();
  return div()
    .id(id).size(size).flex_none().flex().items_center().justify_center().rounded(6)
    .text_color(active ? t.foreground : t.dim)
    .when(active, (el) => el.bg(t.selected))
    .accessibility_label(label).tooltip(label)
    .when(!disabled, (el) =>
      el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((e, cx) => { cx.stop_propagation(); onClick(cx, e); }))
    .child(spinning ? Icon("spinner", 14).spin(SPIN_MS) : Icon(icon, 14));
}

export function Button({ id, label, onClick, primary = false, danger = false, disabled = false, icon }) {
  const t = theme();
  const solid = (primary || danger) && !disabled;
  const bg = danger ? t.ansi1 : t.solid;
  return h_flex()
    .id(id).h(30).flex_none().px(14).gap(6).items_center().justify_center().rounded(8).text_size(TEXT.small)
    .bg(solid ? bg : t.raised).text_color(solid ? t.solid_foreground ?? t.background : disabled ? t.dim : t.foreground)
    .border_1().border_color(solid ? bg : t.border)
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => (solid ? s.opacity(0.88) : s.bg(t.hover))).on_click((_e, cx) => onClick(cx)))
    .when(Boolean(icon), (el) => el.child(Icon(icon, 13)))
    .child(label);
}

export function Message(text, error = false) {
  const t = theme();
  return div().flex_none().px(12).py(8).text_size(TEXT.small).whitespace_normal().text_color(error ? t.ansi1 : t.dim).child(text);
}

export function SectionHead(label, count, right) {
  const t = theme();
  return h_flex().h(26).flex_none().px(12).gap(6).items_center().text_size(TEXT.caption).font_medium().text_color(t.muted)
    .child(div().child(label.toUpperCase()))
    .when(count !== undefined && count !== null, (el) => el.child(Badge(count)))
    .child(div().flex_1())
    .when(Boolean(right), (el) => el.child(right));
}

export const Dot = (color, size = 7) => div().size(size).flex_none().rounded(size / 2).bg(color);

// A git letter's colour: green new, red gone or conflict, yellow edited.
export function markColor(mark, t = theme()) {
  if (!mark) return null;
  if (mark === "A" || mark === "?") return t.ansi2;
  if (mark === "D" || mark === "U") return t.ansi1;
  return t.ansi3;
}

// A CI state's colour and glyph.
export function stateLook(kind, t = theme()) {
  return {
    success: { color: t.ansi2, glyph: "✓" },
    failure: { color: t.ansi1, glyph: "✕" },
    running: { color: t.ansi4, glyph: "●" },
    queued: { color: t.dim, glyph: "○" },
    manual: { color: t.ansi5, glyph: "▸" },
    canceled: { color: t.dim, glyph: "–" },
    skipped: { color: t.dim, glyph: "–" },
    warning: { color: t.ansi3, glyph: "!" },
  }[kind] ?? { color: t.dim, glyph: "·" };
}

// The confirm dialog, drawn by a copy opened with props().confirm (see actions.js).
export function ConfirmView(view) {
  const t = theme();
  const s = view.confirmSpec;
  return v_flex()
    .id("vx-confirm").size_full().p(18).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
    .track_focus(view.confirmFocus)
    .on_key_down((e, cx) => {
      if (e.key === "enter") { cx.stop_propagation(); view.confirmYes(cx); }
      if (e.key === "escape") { cx.stop_propagation(); view.confirmNo(); }
    })
    .child(div().text_size(TEXT.title).font_semibold().child(s.title))
    .when(Boolean(s.detail), (el) => el.child(div().text_size(TEXT.small).text_color(t.muted).whitespace_normal().child(s.detail)))
    .children((s.action.steps ?? [s.action]).map((step) => div().px(8).py(5).rounded(6).bg(t.raised).text_size(TEXT.caption).font_family(codeFont()).text_color(t.dim).truncate()
      .child([step.cmd, ...step.args.filter((a) => !String(a).startsWith("--no-optional") && a !== "-c" && !/^(core|diff)\./.test(a))].join(" "))))
    .child(div().flex_1())
    .child(h_flex().gap(8).justify_end()
      .child(Button({ id: "vx-confirm-no", label: "Cancel", onClick: () => view.confirmNo(), disabled: view.confirmBusy }))
      .child(Button({ id: "vx-confirm-yes", label: view.confirmBusy ? `${s.action.doing ?? "Working"}…` : s.label ?? "OK", primary: !s.danger, danger: Boolean(s.danger), disabled: view.confirmBusy, onClick: (cx) => view.confirmYes(cx) })));
}
