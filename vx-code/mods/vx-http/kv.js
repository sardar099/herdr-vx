// Key / value tables (Params, Headers, form and multipart bodies, environments): a checkbox,
// two inputs and a remove button per row, and an empty row at the end that becomes a real one as
// you type. Inputs are made outside render (InputState in a handler or init) and kept per row id.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme } from "herdr";
import { TEXT, Icon } from "./ui.js";

let seq = 0;
export const rowId = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;
export const withIds = (rows) => (rows ?? []).map((r) => (r.id ? r : { ...r, id: rowId() }));

export const kvMethods = {
  // Makes inputs for every row of a table (and its trailing empty row). onEdit(row, field) runs
  // after a change; onAdd(row) when the empty row gets text and joins the table.
  kvBuild(name, rows, { onEdit, onAdd, fields = ["key", "value"], placeholders = {} }) {
    this.kvInputs ??= new Map();
    this.kvBlank ??= {};
    const make = (row, field, isBlank) => {
      const k = `${name}:${row.id}:${field}`;
      if (this.kvInputs.has(k)) return;
      const st = InputState.new({ placeholder: placeholders[field] ?? (field === "key" ? "Key" : "Value"), value: String(row[field] ?? "") });
      st.on("change", (_e, cx) => {
        if (this.kvSyncing) return;
        row[field] = st.value();
        if (isBlank && this.kvBlank[name] === row && row[field] !== "") {
          this.kvBlank[name] = null;
          onAdd?.(row);
          this.kvBuild(name, rows, { onEdit, onAdd, fields, placeholders });
        }
        onEdit?.(row, field);
        cx.notify();
      });
      this.kvInputs.set(k, st);
    };
    for (const r of rows) for (const f of fields) make(r, f, false);
    if (!this.kvBlank[name]) this.kvBlank[name] = { id: rowId(), key: "", value: "", enabled: true, ...(fields.includes("type") ? { type: "text" } : {}) };
    for (const f of fields) make(this.kvBlank[name], f, true);
  },

  // Sets a row's input from code (e.g. params from the URL) without echoing a change.
  kvSet(name, row, field, value) {
    const st = this.kvInputs?.get(`${name}:${row.id}:${field}`);
    if (!st || st.value() === String(value ?? "")) return;
    this.kvSyncing = true;
    try {
      st.set_value(String(value ?? ""));
    } finally {
      this.kvSyncing = false;
    }
  },

  kvForget(name) {
    for (const k of [...(this.kvInputs?.keys() ?? [])]) if (k.startsWith(`${name}:`)) this.kvInputs.delete(k);
    if (this.kvBlank) this.kvBlank[name] = null;
  },

  // The table. extra(row) draws per-row controls between the value and the remove button.
  kvTable(name, rows, { onToggle, onRemove, extra, fields = ["key", "value"], valueFlex = 2, dropFile } = {}) {
    const t = theme();
    const blank = this.kvBlank?.[name];
    const cell = (row, field, flex) => {
      const st = this.kvInputs?.get(`${name}:${row.id}:${field}`);
      return h_flex().flex_1().flex_grow(flex).min_w(0).h(26).px(6).items_center().border_r(1).border_color(t.border)
        .when(Boolean(st), (el) => el.child(Input.new(st).flex_1().h_full().text_size(TEXT.small)));
    };
    const line = (row, isBlank) => h_flex().id(`kv-${name}-${row.id}`).h(28).flex_none().items_center().border_b(1).border_color(t.border)
      .when(Boolean(dropFile), (el) => el.on_drop((e, cx) => { if (e.paths?.[0]) dropFile(row, e.paths[0], isBlank); cx.notify(); }))
      .child(div().id(`kvc-${name}-${row.id}`).w(28).flex_none().h_full().flex().items_center().justify_center().border_r(1).border_color(t.border)
        .when(!isBlank, (el) => el.cursor_pointer().on_click((_e, cx) => { row.enabled = row.enabled === false; onToggle?.(row); cx.notify(); })
          .child(div().size(13).rounded(3).border_1().border_color(row.enabled === false ? t.border : t.accent).bg(row.enabled === false ? "#00000000" : t.accent)
            .flex().items_center().justify_center().when(row.enabled !== false, (e2) => e2.child(Icon("check", 10).text_color(t.accent_foreground ?? "#ffffff"))))))
      .child(cell(row, fields[0], 1))
      .child(cell(row, fields[1], valueFlex))
      .when(Boolean(extra), (el) => el.child(extra(row, isBlank) ?? div()))
      .child(div().id(`kvx-${name}-${row.id}`).w(28).flex_none().h_full().flex().items_center().justify_center()
        .when(!isBlank, (el) => el.cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground)).tooltip("Remove")
          .on_click((_e, cx) => { onRemove?.(row); cx.notify(); }).child(Icon("x", 12))));
    return v_flex().flex_none().mx(10).my(6).rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(rows.map((r) => line(r, false)))
      .when(Boolean(blank), (el) => el.child(line(blank, true)));
  },
};
