// vx-devtools: every small developer tool in one place.
//   tab    props {} | { tool, input, options }   the tool list on the left, the chosen tool on the right
//   popup  opened by mod.open:vx-devtools (⌘⌥T)  paste anything: it guesses what it is (JWT, timestamp,
//                                                base64, colour, cron…) and shows the answers; Enter
//                                                copies, ⌘Enter opens the tool in the tab
// The tools themselves are data in shared/devtools-core.js. A few run a program (ruby for YAML,
// jq, htpasswd for bcrypt, dig, date for time zones); everything else runs here.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, EditorState, Editor, TextView } from "gpui-base";
import { theme, props, exec, notify, closeOverlay, shared, setShared, spaces, panes, run, checking } from "herdr";
import { TOOLS, GROUPS, toolById, defaultOptions, searchTools, detect } from "./devtools-core.js";
import { syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, Button, Message, codeFont, codeSize } from "./ui.js";

const MOD = "vx-devtools";
const OPEN = "vx.devtools.open";
const stamp = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

// Opens a tool in the Dev Tools tab (reusing it when there is one in this space).
export function openTool(tool, input, options) {
  const space = spaces().find((s) => s.active);
  const tabId = shared("vx.devtools.tab");
  const live = space?.tabs?.some((t) => t.id === tabId) && panes().some((p) => p.tab === tabId && p.mod === MOD);
  setShared(OPEN, { tool, input: input ?? {}, options: options ?? {}, n: stamp() });
  if (live) return run("tab.select", { id: tabId });
  run("tab.new", { name: "Dev Tools", mod: MOD, props: { tool, input: input ?? {}, options: options ?? {} }, ...(space ? { space: space.id } : {}) });
}

class VxDevtools extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.overlay) return this.initPopup(p, cx);
    this.tab = true;
    this.search = InputState.new({ placeholder: "Search tools" });
    this.search.on("change", (_e, cx) => cx.notify());
    this.openSeen = shared(OPEN)?.n ?? null;
    this.state = {};
    try {
      this.state = JSON.parse(localStorage.getItem("state") ?? "{}");
    } catch {}
    const first = toolById(p.tool) ?? toolById(this.state.tool) ?? TOOLS[0];
    this.select(first, cx, p.tool ? p.input : null, p.tool ? p.options : null);
    if (checking()) return;
    this.registerTab();
    cx.timer.every(200, (cx) => {
      const o = shared(OPEN);
      if (o && o.n !== this.openSeen) {
        this.openSeen = o.n;
        const t = toolById(o.tool);
        if (t) this.select(t, cx, o.input, o.options);
      }
    });
  }

  registerTab() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (tab && panes().some((p) => p.tab === tab && p.mod === MOD)) setShared("vx.devtools.tab", tab);
  }

  remember() {
    try {
      localStorage.setItem("state", JSON.stringify(this.state));
    } catch {}
  }

  // A tool into the right half: inputs made here (never while drawing), last values restored.
  select(tool, cx, input, options) {
    this.tool = tool;
    this.state.tool = tool.id;
    const saved = this.state[tool.id] ?? {};
    this.opts = { ...defaultOptions(tool), ...(saved.opts ?? {}), ...(options ?? {}) };
    this.inputs = {};
    for (const f of tool.inputs ?? []) {
      const value = String(input?.[f.id] ?? saved.in?.[f.id] ?? "");
      const st = f.multi ? TextareaState.new({ placeholder: f.placeholder ?? "Paste or type here", value, rows: 8 }) : InputState.new({ placeholder: f.placeholder ?? "", value });
      st.on("change", (_e, cx) => this.changed(cx));
      this.inputs[f.id] = st;
    }
    this.result = null;
    this.remember();
    this.compute(cx);
    cx.notify();
  }

  values() {
    return Object.fromEntries(Object.entries(this.inputs).map(([k, st]) => [k, st.value()]));
  }

  changed(cx) {
    const t = this.tool;
    this.state[t.id] = { in: this.values(), opts: this.opts };
    this.remember();
    // Programs run a moment after typing stops; the rest run at once.
    if (t.exec) {
      this.execGen = (this.execGen ?? 0) + 1;
      const gen = this.execGen;
      cx.timer.after(450, (cx) => { if (gen === this.execGen) this.compute(cx); });
    } else this.compute(cx);
    cx.notify();
  }

  setOpt(id, value, cx) {
    this.opts = { ...this.opts, [id]: value };
    this.changed(cx);
  }

  compute(cx) {
    const t = this.tool;
    const input = this.values();
    const gen = (this.runGen = (this.runGen ?? 0) + 1);
    const empty = (t.inputs ?? []).length > 0 && !t.noInput && Object.values(input).every((v) => !String(v).trim());
    if (empty) {
      this.setResult(null);
      return cx.notify();
    }
    cx.spawn(async (cx) => {
      let r;
      try {
        if (t.exec) {
          const e = t.exec(input, this.opts);
          this.busy = true;
          cx.notify();
          const x = await exec(e.cmd, e.args, { timeout: 20000 }).catch((err) => ({ code: -1, stdout: "", stderr: String(err?.message ?? err) }));
          r = e.parse(x.stdout ?? "", x.stderr ?? "", x.code);
        } else r = await t.run(input, this.opts);
      } catch (err) {
        r = { error: String(err?.message ?? err) };
      }
      this.busy = false;
      if (gen !== this.runGen) return;
      this.setResult(r);
      cx.notify();
    });
  }

  // Text results show in a read-only code view (selectable, highlighted for JSON / YAML / TS…).
  setResult(r) {
    this.result = r;
    if (r?.text !== undefined) {
      if (this.out && this.outLang === (this.tool.language ?? null)) this.out.set_value(r.text);
      else {
        this.out?.release?.();
        const C = syntaxColors(theme());
        this.out = EditorState.new({ language: this.tool.language ?? undefined, value: r.text, readonly: true, soft_wrap: true, line_numbers: false, folding: false,
          font_family: codeFont(), font_size: Math.max(11, codeSize() - 1), syntax: { keyword: C.keyword, string: C.string, comment: C.comment, function: C.fn, type: C.type, number: C.number, constant: C.constant } });
        this.outLang = this.tool.language ?? null;
      }
    }
  }

  copyAll(cx) {
    const r = this.result;
    if (!r) return;
    const text = r.text ?? r.rows?.map((x) => (x.label ? `${x.label}: ${x.value}` : x.value)).join("\n") ?? r.markdown ?? r.diff?.map((d) => `${d.op}${d.text}`).join("\n") ?? "";
    cx.write_to_clipboard(text);
    notify({ title: "Copied", level: "success", timeout: 1200 });
  }

  // ── drawing the tab ────────────────────────────────────────────────────────────────────
  renderList(t) {
    const q = this.search.value();
    const list = searchTools(q);
    const rows = [];
    for (const g of GROUPS) {
      const items = list.filter((x) => x.group === g);
      if (!items.length) continue;
      rows.push(div().px(12).pt(10).pb(3).text_size(TEXT.tiny).font_semibold().text_color(t.dim).child(g.toUpperCase()));
      for (const x of items) {
        const on = x.id === this.tool.id;
        rows.push(div().id(`dt-${x.id}`).h(26).flex_none().mx(6).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.small)
          .bg(on ? t.selected : "#00000000").text_color(on ? t.foreground : t.muted).when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => this.select(x, cx)).child(div().truncate().child(x.name)));
      }
    }
    return v_flex().w(230).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().h(30).flex_none().m(8).px(8).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
        .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.search).flex_1().h_full().text_size(TEXT.small)))
      .child(v_flex().id("dt-list").flex_1().min_h(0).overflow_y_scrollbar().pb(10).children(rows.length ? rows : [Message("No tool matches.")]));
  }

  renderOptions(t) {
    const opts = this.tool.options ?? [];
    if (!opts.length) return null;
    return h_flex().flex_wrap().gap(14).px(16).pt(10)
      .children(opts.map((o) => h_flex().gap(4).items_center()
        .child(div().pr(2).text_size(TEXT.caption).text_color(t.dim).child(o.label))
        .children(o.choices.map((c) => div().id(`op-${o.id}-${c}`).h(24).px(8).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.small)
          .bg(this.opts[o.id] === c ? t.selected : "#00000000").text_color(this.opts[o.id] === c ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.setOpt(o.id, c, cx)).child(c)))));
  }

  renderInputs(t) {
    return v_flex().gap(8).px(16).pt(10)
      .children((this.tool.inputs ?? []).map((f) => v_flex().gap(4)
        .child(div().text_size(TEXT.caption).text_color(t.muted).child(f.label))
        .child(f.multi
          ? div().h(this.tool.id === "diff" ? 150 : 130).p(6).rounded(6).bg(t.chrome).border_1().border_color(t.input ?? t.border).child(Textarea.new(this.inputs[f.id]).size_full().text_size(TEXT.small).font_family(codeFont()))
          : h_flex().h(30).px(8).items_center().rounded(6).bg(t.chrome).border_1().border_color(t.input ?? t.border).child(Input.new(this.inputs[f.id]).flex_1().h_full().text_size(TEXT.small).font_family(codeFont())))));
  }

  renderResult(t) {
    const r = this.result;
    const head = h_flex().h(30).flex_none().px(16).gap(8).items_center()
      .child(div().text_size(TEXT.caption).font_medium().text_color(t.muted).child("RESULT"))
      .when(this.busy, (el) => el.child(Icon("spinner", 12).spin(900).text_color(t.dim)))
      .when(Boolean(r?.swatch), (el) => el.child(div().w(48).h(16).rounded(4).border_1().border_color(t.border).bg(r.swatch)))
      .child(div().flex_1())
      .when(Boolean(this.tool.noInput), (el) => el.child(Button({ id: "dt-again", label: "Generate again", icon: "refresh", onClick: (cx) => this.compute(cx) })))
      .when(Boolean(r) && !r.error, (el) => el.child(IconButton({ id: "dt-copy", icon: "copy", label: "Copy the result", size: 24, onClick: (cx) => this.copyAll(cx) })));
    const box = v_flex().flex_1().min_h(0).mx(16).mb(14).rounded(6).border_1().border_color(t.border).bg(t.chrome).overflow_hidden();
    let body;
    if (!r) body = box.child(Message((this.tool.inputs ?? []).length ? "Type or paste something above." : "…"));
    else if (r.error) body = box.border_color(t.ansi1).child(div().p(12).text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(r.error));
    else if (r.text !== undefined && this.out) body = box.child(div().size_full().px(4).font_family(codeFont()).child(Editor.new(this.out).size_full()));
    else if (r.markdown !== undefined) body = box.child(div().id("dt-md").size_full().overflow_y_scrollbar().px(16).py(10).child(TextView.markdown("dt-md-text", r.markdown || "*Nothing yet*").w_full().selectable(true).scrollable(false)));
    else if (r.diff) {
      const color = { "+": t.ansi2, "-": t.ansi1, " ": t.muted };
      const added = r.diff.filter((d) => d.op === "+").length, removed = r.diff.filter((d) => d.op === "-").length;
      body = box.child(v_flex().id("dt-diff").size_full().overflow_y_scrollbar().py(6).font_family(codeFont()).text_size(TEXT.small)
        .child(div().px(10).pb(4).text_size(TEXT.caption).text_color(t.dim).child(added || removed ? `+${added} −${removed} lines` : "No differences"))
        .children(r.diff.slice(0, 3000).map((d, i) => h_flex().id(`df-${i}`).px(10).gap(8).bg(d.op === "+" ? `${t.ansi2}1f` : d.op === "-" ? `${t.ansi1}1f` : "#00000000")
          .child(div().w(10).flex_none().text_color(color[d.op]).child(d.op))
          .child(div().flex_1().min_w(0).whitespace_normal().text_color(d.op === " " ? t.muted : t.foreground).child(d.text || " ")))));
    } else if (r.rows) {
      body = box.child(v_flex().id("dt-rows").size_full().overflow_y_scrollbar().py(4)
        .children(r.rows.map((x, i) => h_flex().id(`dr-${i}`).px(12).py(5).gap(12).items_start().border_b(1).border_color(t.border).text_size(TEXT.small)
          .child(div().w(150).flex_none().truncate().text_color(t.dim).child(x.label))
          .child(v_flex().flex_1().min_w(0).font_family(codeFont()).children(String(x.value).split("\n").slice(0, 200).map((l) => div().whitespace_normal().child(l || " "))))
          .child(IconButton({ id: `drc-${i}`, icon: "copy", label: "Copy", size: 20, onClick: (cx) => { cx.write_to_clipboard(String(x.value)); notify({ title: "Copied", body: String(x.value).slice(0, 80), level: "success", timeout: 1200 }); } })))));
    } else body = box.child(Message("Nothing to show."));
    return v_flex().flex_1().min_h(0).pt(10).child(head).child(body);
  }

  renderTab() {
    const t = theme();
    const tool = this.tool;
    return h_flex().id(MOD).size_full().min_h(0).items_start().bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .child(this.renderList(t))
      .child(v_flex().flex_1().h_full().min_w(0).min_h(0)
        .child(h_flex().h(44).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
          .child(div().text_size(TEXT.title).font_semibold().child(tool.name))
          .child(div().text_size(TEXT.caption).text_color(t.dim).child(tool.group))
          .when(Boolean(tool.exec), (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child("· runs a program"))))
        .child(v_flex().flex_none().child(this.renderOptions(t) ?? div()).child(this.renderInputs(t)))
        .child(this.renderResult(t)));
  }

  // ── the popup ──────────────────────────────────────────────────────────────────────────
  initPopup(p, cx) {
    this.popup = true;
    this.overlayId = p.overlay;
    this.query = InputState.new({ placeholder: "Paste a JWT, timestamp, base64, colour, cron, URL… or search a tool" });
    this.query.on("change", (_e, cx) => this.refreshPopup(cx));
    this.query.on("submit", (e, cx) => this.choosePopup(cx, Boolean(e?.secondary)));
    this.query.focus();
    this.cursor = 0;
    this.items = [];
    this.refreshPopup(cx);
  }

  refreshPopup(cx) {
    const s = this.query.value();
    const gen = (this.popGen = (this.popGen ?? 0) + 1);
    this.cursor = 0;
    const found = detect(s);
    const named = s.trim() ? searchTools(s).slice(0, 8) : TOOLS.slice(0, 12);
    // Tools named by the text first when nothing was recognised; recognised values first otherwise.
    this.items = [
      ...found.map((d) => ({ kind: "value", tool: toolById(d.tool), input: d.input, options: d.options, result: null })),
      ...named.filter((t) => !found.some((d) => d.tool === t.id)).map((t) => ({ kind: "tool", tool: t })),
    ].filter((x) => x.tool);
    cx.notify();
    cx.spawn(async (cx) => {
      for (const it of this.items.filter((x) => x.kind === "value")) {
        if (!it.tool.run) continue;
        const r = await Promise.resolve(it.tool.run(it.input, { ...defaultOptions(it.tool), ...it.options })).catch((e) => ({ error: String(e?.message ?? e) }));
        if (gen !== this.popGen) return;
        it.result = r;
        cx.notify();
      }
    });
  }

  summary(r) {
    if (!r) return "";
    if (r.error) return r.error;
    if (r.text !== undefined) return r.text.split("\n").slice(0, 2).join("  ").slice(0, 160);
    if (r.rows) return r.rows.slice(0, 3).map((x) => `${x.label}: ${String(x.value).replace(/\s+/g, " ")}`).join("   ").slice(0, 200);
    return "";
  }

  copyText(r) {
    if (!r || r.error) return null;
    if (r.text !== undefined) return r.text;
    if (r.rows?.length) return r.rows.length === 1 ? r.rows[0].value : r.rows.map((x) => `${x.label}: ${x.value}`).join("\n");
    return null;
  }

  choosePopup(cx, open) {
    const it = this.items[this.cursor];
    if (!it) return;
    const text = it.kind === "value" ? this.copyText(it.result) : null;
    if (!open && text !== null) {
      cx.write_to_clipboard(text);
      notify({ title: "Copied", body: text.slice(0, 100), level: "success", timeout: 1500 });
    } else openTool(it.tool.id, it.kind === "value" ? it.input : {}, it.kind === "value" ? it.options : {});
    closeOverlay(props()?.overlay ?? this.overlayId);
  }

  renderPopup() {
    const t = theme();
    return v_flex().id("dt-pop").size_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "down" || e.key === "up") {
          cx.stop_propagation();
          const n = this.items.length;
          if (n) this.cursor = (this.cursor + (e.key === "down" ? 1 : n - 1)) % n;
          cx.notify();
        }
        if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay ?? this.overlayId); }
      })
      .child(h_flex().h(44).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(Icon("sparkles", 15).text_color(t.accent)).child(Input.new(this.query).flex_1().h_full().text_size(TEXT.body)))
      // A popup sizes to its content: the list says how tall it is (470 - head 44 - foot 26).
      .child(v_flex().id("dt-pop-list").h(398).flex_none().overflow_y_scrollbar().p(6).gap(1)
        .children(this.items.map((it, i) => h_flex().id(`dp-${i}`).min_h(34).flex_none().px(10).py(4).gap(10).items_center().rounded(6).cursor_pointer()
          .bg(i === this.cursor ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.cursor = i; this.choosePopup(cx, it.kind === "tool"); })
          .child(v_flex().flex_1().min_w(0).gap(1)
            .child(h_flex().gap(8).items_center().child(div().text_size(TEXT.small).font_medium().child(it.tool.name)).child(div().text_size(TEXT.tiny).text_color(t.dim).child(it.tool.group.toUpperCase())))
            .when(it.kind === "value", (el) => el.child(div().truncate().text_size(TEXT.caption).font_family(codeFont()).text_color(it.result?.error ? t.ansi1 : t.muted).child(it.result ? this.summary(it.result) || "…" : it.tool.exec ? "Enter to open" : "…"))))
          .when(Boolean(it.result?.swatch), (el) => el.child(div().size(16).rounded(4).bg(it.result.swatch)))
          .child(div().text_size(TEXT.tiny).text_color(t.dim).child(it.kind === "value" && this.copyText(it.result) !== null ? "↵ copy · ⌘↵ open" : "↵ open")))))
      .child(h_flex().h(26).flex_none().px(12).items_center().border_t(1).border_color(t.border).text_size(TEXT.tiny).text_color(t.dim)
        .child(`${TOOLS.length} tools · ↑↓ to move · Enter copies the answer · ⌘Enter opens the tool · Esc closes`));
  }

  render() {
    if (this.popup) return this.renderPopup();
    return this.renderTab();
  }
}

export default VxDevtools;
