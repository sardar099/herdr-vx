// vx-http's popups. They only ask; the work happens in a long-lived copy, reached by posting:
//   select  props { select: { owner, key, options, current } }  -> shared vx.http.pick
//   menu    props { menu: { owner, items } }                     -> shared vx.http.cmd
//   dialog  props { dialog: { owner, kind, … } }                 -> shared vx.http.cmd
// owner "side" is the side bar (files, collections, environments); any other owner is a
// request tab's own id.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, setShared } from "herdr";
import { TEXT, Icon, Button } from "./ui.js";

const MOD = "vx-http";
const ITEM = 26;
const SEP = 9;
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const postCmd = (cmd) => setShared("vx.http.cmd", { ...cmd, id: stamp() });
export const postPick = (owner, key, value) => setShared("vx.http.pick", { owner, key, value, id: stamp() });

// options: [{ value, label, color?, icon?, sep? }]
export function openSelect(owner, key, options, current, width = 200) {
  const items = options.filter((o) => !o.sep).length;
  const seps = options.filter((o) => o.sep).length;
  openOverlay({ mod: MOD, kind: "popup", width, height: Math.min(14, items) * ITEM + seps * SEP + 12, props: { select: { owner, key, options, current } } });
}

// items: [{ icon, label, cmd, danger?, copy? } | { sep: true }]
export function openMenu(owner, items, width = 230) {
  const list = items.filter(Boolean);
  const seps = list.filter((i) => i.sep).length;
  openOverlay({ mod: MOD, kind: "popup", width, height: (list.length - seps) * ITEM + seps * SEP + 12, props: { menu: { owner, items: list } } });
}

const DIALOG_SIZE = { curl: [560, 330], postman: [520, 210], name: [420, 170], confirm: [420, 160], jq: [420, 170] };
export function openDialog(dialog) {
  const [width, height] = DIALOG_SIZE[dialog.kind] ?? [420, 180];
  openOverlay({ mod: MOD, kind: "dialog", width, height, props: { dialog } });
}

const close = (overlay) => closeOverlay(props()?.overlay ?? overlay);

export const popupMethods = {
  initPopup(p) {
    this.popup = p.select ? "select" : p.menu ? "menu" : "dialog";
    this.select = p.select;
    this.menu = p.menu;
    this.dialog = p.dialog;
    this.overlayId = p.overlay;
    if (p.dialog) {
      const d = p.dialog;
      if (d.kind === "curl") {
        this.dlgText = TextareaState.new({ placeholder: "curl 'https://api.example.com/v1/items' -H 'Authorization: Bearer …'", rows: 8 });
        this.dlgText.focus();
      } else if (d.kind === "postman") {
        this.dlgInput = InputState.new({ placeholder: "/path/to/collection.json (or drop the file here)", value: d.value ?? "" });
        this.dlgInput.focus();
      } else if (d.kind === "name" || d.kind === "jq") {
        this.dlgInput = InputState.new({ placeholder: d.placeholder ?? "", value: d.value ?? "" });
        this.dlgInput.on("submit", (_e, cx) => this.dialogOk(cx));
        this.dlgInput.focus();
      }
    }
  },

  dialogOk() {
    const d = this.dialog;
    const value = d.kind === "curl" ? this.dlgText.value() : this.dlgInput?.value() ?? "";
    if (d.kind !== "confirm" && !value.trim()) return;
    postCmd({ ...(d.then ?? {}), owner: d.owner, value: value.trim() });
    close(this.overlayId);
  },

  renderPopup() {
    const t = theme();
    if (this.popup === "select") {
      const s = this.select;
      return v_flex().id("http-select").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small).overflow_y_scrollbar()
        .children(s.options.map((o, i) => o.sep
          ? div().h(SEP).flex_none().flex().items_center().child(div().h(1).w_full().bg(t.border))
          : h_flex().id(`sel-${i}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer()
            .bg(o.value === s.current ? t.selected : "#00000000").hover((st) => st.bg(t.hover))
            .on_click(() => { postPick(s.owner, s.key, o.value); close(this.overlayId); })
            .when(Boolean(o.icon), (el) => el.child(Icon(o.icon, 13).text_color(o.color ?? t.dim)))
            .child(div().flex_1().truncate().font_medium().text_color(o.color ?? t.foreground).child(o.label))
            .when(o.value === s.current, (el) => el.child(Icon("check", 12).text_color(t.accent)))));
    }
    if (this.popup === "menu") {
      const m = this.menu;
      return v_flex().id("http-menu").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
        .children(m.items.map((it, i) => it.sep
          ? div().h(SEP).flex_none().flex().items_center().child(div().h(1).w_full().bg(t.border))
          : h_flex().id(`mi-${i}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer().hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => {
              if (it.copy !== undefined) cx.write_to_clipboard(it.copy);
              else postCmd({ ...it.cmd, owner: it.cmd.owner ?? m.owner });
              close(this.overlayId);
            })
            .child(Icon(it.icon ?? "file", 13).text_color(it.danger ? t.ansi1 : t.dim))
            .child(div().truncate().text_color(it.danger ? t.ansi1 : t.foreground).child(it.label))));
    }
    const d = this.dialog;
    const root = v_flex().id("http-dialog").size_full().p(16).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); close(this.overlayId); }
        if (e.key === "enter" && (e.modifiers?.platform || d.kind === "confirm" || d.kind === "postman")) { cx.stop_propagation(); this.dialogOk(cx); }
      })
      .child(div().text_size(TEXT.title).font_semibold().child(d.title ?? ""))
      .when(Boolean(d.detail), (el) => el.child(div().text_size(TEXT.small).text_color(t.muted).whitespace_normal().child(d.detail)));
    const box = (child, h = 30) => h_flex().h(h).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border).child(child);
    if (d.kind === "curl") root.child(div().flex_1().min_h(0).p(6).rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border).child(Textarea.new(this.dlgText).size_full().text_size(TEXT.small).font_family("monospace")));
    if (d.kind === "postman") root.child(box(Input.new(this.dlgInput).flex_1().h_full().text_size(TEXT.small)).on_drop((e, cx) => { if (e.paths?.[0]) this.dlgInput.set_value(e.paths[0]); cx.notify(); }));
    if (d.kind === "name" || d.kind === "jq") root.child(box(Input.new(this.dlgInput).flex_1().h_full().text_size(TEXT.small)));
    if (d.kind !== "curl") root.child(div().flex_1());
    return root.child(h_flex().gap(8).justify_end()
      .when(d.kind === "curl", (el) => el.child(div().flex_1().text_size(TEXT.caption).text_color(t.dim).child("⌘Enter to import")))
      .child(Button({ id: "dlg-cancel", label: "Cancel", onClick: () => close(this.overlayId) }))
      .child(Button({ id: "dlg-ok", label: d.ok ?? "OK", primary: !d.danger, danger: Boolean(d.danger), onClick: (cx) => this.dialogOk(cx) })));
  },
};
