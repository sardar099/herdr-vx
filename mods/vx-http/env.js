// An environment's tab (props { envEdit: { repo, name } }): its {{variables}}, each marked
// secret or not (secret values live in .vx/http/.secrets.json, which git ignores, and are
// masked here), plus the values captured by tests this session.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, notify, run } from "herdr";
import { loadEnvs, saveEnv, activeEnv, setActiveEnv, runtimeVars, clearRuntime, httpDir } from "./store.js";
import { rowId } from "./kv.js";
import { TEXT, Icon, Button, Message, codeFont } from "./ui.js";

export const envMethods = {
  initEnv(p, cx) {
    this.mode = "env";
    this.envRepo = p.envEdit.repo;
    this.envName = p.envEdit.name ?? "new";
    this.envRows = null;
    this.nameState = InputState.new({ placeholder: "Environment name", value: this.envName });
    this.nameState.on("change", (_e, cx) => cx.notify());
    cx.spawn(async (cx) => {
      const { envs, secrets } = await loadEnvs(this.envRepo).catch(() => ({ envs: { envs: {} }, secrets: { envs: {} } }));
      const open = envs.envs[this.envName] ?? {};
      const hidden = secrets.envs[this.envName] ?? {};
      const rows = [
        ...Object.entries(open).map(([key, value]) => ({ id: rowId(), key, value: String(value), secret: false, enabled: true })),
        ...Object.entries(hidden).map(([key, value]) => ({ id: rowId(), key, value: String(value), secret: true, enabled: true })),
      ];
      this.envRows = rows;
      this.savedEnv = JSON.stringify(rows.map(({ key, value, secret }) => [key, value, secret]));
      this.kvBuild("env", rows, { onAdd: (row) => rows.push(row), placeholders: { key: "variable", value: "value" } });
      for (const r of rows) if (r.secret) this.kvInputs.get(`env:${r.id}:value`)?.set_masked(true);
      cx.notify();
    });
  },

  envDirty() {
    if (!this.envRows) return false;
    return this.nameState.value().trim() !== this.envName || JSON.stringify(this.envRows.map(({ key, value, secret }) => [key, value, secret])) !== this.savedEnv;
  },

  saveEnvTab(cx) {
    const name = this.nameState.value().trim();
    if (!name) return notify({ title: "Give the environment a name", level: "warning" });
    cx.spawn(async (cx) => {
      try {
        const was = this.envName;
        await saveEnv(this.envRepo, name, this.envRows, { rename: was });
        if (was !== name && activeEnv(this.envRepo) === was) setActiveEnv(this.envRepo, name);
        this.envName = name;
        this.savedEnv = JSON.stringify(this.envRows.map(({ key, value, secret }) => [key, value, secret]));
        notify({ title: `Saved ${name}`, level: "success", timeout: 1500 });
      } catch (e) {
        notify({ title: "Not saved", body: String(e?.message ?? e), level: "error" });
      }
      cx.notify();
    });
  },

  renderEnv() {
    const t = theme();
    const root = v_flex().id("vx-http-env").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TEXT.body)
      .on_key_down((e, cx) => { if (e.key === "s" && e.modifiers?.platform) { cx.stop_propagation(); this.saveEnvTab(cx); } });
    const active = activeEnv(this.envRepo) === this.envName;
    root.child(h_flex().h(44).flex_none().px(12).gap(10).items_center().border_b(1).border_color(t.border)
      .child(Icon("layers", 15).text_color(t.ansi6))
      .child(h_flex().w(260).h(28).px(8).items_center().rounded(6).bg(t.chrome).border_1().border_color(t.input ?? t.border).child(Input.new(this.nameState).flex_1().h_full().text_size(TEXT.body).font_medium()))
      .child(div().text_size(TEXT.caption).text_color(t.dim).child(httpDir(this.envRepo)))
      .child(div().flex_1())
      .when(this.envDirty(), (el) => el.child(div().text_size(TEXT.caption).text_color(t.ansi3).child("● unsaved")))
      .child(Button({ id: "env-use", label: active ? "Active" : "Use", icon: active ? "check" : null, disabled: active, onClick: () => setActiveEnv(this.envRepo, this.envName) }))
      .child(Button({ id: "env-save", label: "Save ⌘S", primary: true, onClick: (cx) => this.saveEnvTab(cx) })));
    if (!this.envRows) return root.child(Message("Loading…"));
    const rows = this.envRows;
    const runtime = runtimeVars(this.envRepo);
    return root.child(v_flex().id("env-body").flex_1().min_h(0).overflow_y_scrollbar().pb(16)
      .child(div().px(14).pt(10).text_size(TEXT.small).text_color(t.muted).whitespace_normal().child("Use them as {{name}} in URLs, headers, bodies and auth. Secret values are kept in .secrets.json, which git ignores, and are hidden here."))
      .child(this.kvTable("env", rows, {
        onRemove: (row) => rows.splice(rows.indexOf(row), 1),
        extra: (row, isBlank) => div().id(`envs-${row.id}`).w(70).flex_none().h_full().flex().items_center().justify_center().gap(4).border_r(1).border_color(t.border)
          .cursor_pointer().text_size(TEXT.caption).text_color(row.secret ? t.ansi5 : t.dim).hover((s) => s.bg(t.hover)).tooltip(row.secret ? "Secret: stays out of git, masked (click to make it plain)" : "Plain: saved in environments.json (click to make it secret)")
          .on_click((_e, cx) => {
            row.secret = !row.secret;
            this.kvInputs.get(`env:${row.id}:value`)?.set_masked(row.secret);
            if (isBlank && row.key) { rows.push(row); this.kvBlank.env = null; this.kvBuild("env", rows, { onAdd: (r) => rows.push(r) }); }
            cx.notify();
          })
          .child(Icon(row.secret ? "eye" : "file", 11)).child(row.secret ? "secret" : "plain"),
      }))
      .when(Object.keys(runtime).length > 0, (el) => el
        .child(h_flex().px(14).pt(14).gap(8).items_center()
          .child(div().flex_1().text_size(TEXT.caption).font_medium().text_color(t.muted).child("CAPTURED VALUES · set by tests, override the environment, never saved to the repo"))
          .child(div().id("env-clear-rt").text_size(TEXT.caption).text_color(t.accent).cursor_pointer().on_click((_e, cx) => { clearRuntime(this.envRepo); cx.notify(); }).child("Clear")))
        .child(v_flex().mx(10).my(6).rounded(6).border_1().border_color(t.border).overflow_hidden()
          .children(Object.entries(runtime).map(([k, v]) => h_flex().h(26).px(10).gap(10).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
            .child(div().w(200).flex_none().truncate().text_color(t.ansi6).child(k))
            .child(div().flex_1().min_w(0).truncate().font_family(codeFont()).text_color(t.muted).child(String(v))))))));
  },
};
