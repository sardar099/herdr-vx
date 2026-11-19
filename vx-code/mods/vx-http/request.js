// A request tab (props { open: { repo, file, id } } for a saved request, or { repo, request }
// for a new or imported one). Method, URL (its query two-way with Params), then Params,
// Headers, Body, Auth, Tests and Settings; Send (⌘Enter) runs curl and shows the response
// below (response.js); Save (⌘S) writes the request into its collection file.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, EditorState, Editor } from "gpui-base";
import { theme, exec, notify, shared, setShared, spaces, panes, run, home } from "herdr";
import {
  METHODS, BODY_MODES, AUTH_TYPES, TEST_SOURCES, TEST_OPS, newRequest, paramsFromUrl, urlWithParams, resolveRequest, missingVars,
  SNIPPETS, upsertItem, newId,
} from "./http-core.js";
import { loadEnvs, varsFor, editCollection, createCollection, loadCollections, rev, activeEnv, addRuntime, setActiveEnv } from "./store.js";
import { withIds, rowId } from "./kv.js";
import { openSelect, openMenu, openDialog } from "./http-ui.js";
import { syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, Button, Message, codeFont, codeSize, tint } from "./ui.js";

export const methodColor = (t, m) => ({ GET: t.ansi2, POST: t.ansi3, PUT: t.ansi4, PATCH: t.ansi5, DELETE: t.ansi1, HEAD: t.ansi6, OPTIONS: t.muted }[m] ?? t.muted);
const BODY_LABEL = { none: "None", json: "JSON", text: "Text", xml: "XML", form: "Form URL-Encoded", multipart: "Multipart Form", graphql: "GraphQL", binary: "Binary File" };
const AUTH_LABEL = { none: "No Auth", basic: "Basic", bearer: "Bearer Token", apikey: "API Key", oauth2cc: "OAuth 2.0 (Client Credentials)" };
const SRC_LABEL = { status: "Status", header: "Header", json: "JSON path", body: "Body", time: "Time (ms)" };
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// What gets saved: the request without ids the editor added to its rows (they're kept: stable
// ids make diffs of the collection file small, and the editor wants them anyway).
const snapshot = (req) => JSON.stringify(req);

function normalize(req) {
  const r = { ...newRequest(), ...JSON.parse(JSON.stringify(req ?? {})) };
  r.id ??= newId();
  r.params = withIds((r.params ?? []).length ? r.params : paramsFromUrl(r.url));
  r.headers = withIds(r.headers);
  r.body = { ...newRequest().body, ...(r.body ?? {}) };
  r.body.form = withIds(r.body.form);
  r.body.multipart = withIds(r.body.multipart).map((f) => ({ type: "text", ...f }));
  r.body.graphql = { query: "", variables: "", ...(r.body.graphql ?? {}) };
  r.auth = { type: "none", ...(r.auth ?? {}) };
  r.tests = withIds(r.tests).map((x) => ({ source: "status", op: "==", path: "", value: "", ...x }));
  r.captures = withIds(r.captures).map((x) => ({ source: "json", path: "", variable: "", ...x }));
  r.settings = { ...newRequest().settings, ...(r.settings ?? {}) };
  return r;
}

export const requestMethods = {
  initRequest(p, cx) {
    this.mode = "request";
    this.owner = `req-${stamp()}`;
    this.ref = p.open?.file ? { file: p.open.file, id: p.open.id } : null;
    this.repo = p.open?.repo ?? p.repo ?? null;
    this.tab = "params";
    this.respTab = "body";
    this.resp = null;
    this.envData = null;
    this.seenRev = rev();
    this.pickSeen = shared("vx.http.pick")?.id ?? null;
    this.cmdSeen = shared("vx.http.cmd")?.id ?? null;
    this.registerTab();
    this.loadEnv(cx);
    if (p.request) this.setReq(p.request);
    else if (this.ref) this.loadSaved(cx);
    else this.setReq(newRequest());
    cx.timer.every(150, (cx) => this.takeMessages(cx));
    cx.timer.every(1000, (cx) => {
      if (rev() !== this.seenRev) {
        this.seenRev = rev();
        this.loadEnv(cx);
      }
    });
  },

  // This copy's tab (the active one when it opened), so the side bar can select it again.
  registerTab() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active)?.id;
    if (!tab || !panes().some((p) => p.tab === tab && p.mod === "vx-http")) return;
    this.myTab = tab;
    if (this.ref) setShared("vx.http.tabs", { ...(shared("vx.http.tabs") ?? {}), [tab]: `${this.ref.file}#${this.ref.id}` });
  },

  loadEnv(cx) {
    if (!this.repo) return;
    cx.spawn(async (cx) => {
      this.envData = await loadEnvs(this.repo).catch(() => ({ envs: { envs: {} }, secrets: { envs: {} } }));
      cx.notify();
    });
  },

  vars() {
    return this.repo ? varsFor(this.repo, this.envData) : {};
  },

  loadSaved(cx) {
    cx.spawn(async (cx) => {
      const cols = await loadCollections(this.repo).catch(() => []);
      const col = cols.find((c) => c.file === this.ref.file);
      let item = null;
      const walk = (items) => { for (const it of items ?? []) { if (it.id === this.ref.id) item = it; if (it.folder) walk(it.items); } };
      walk(col?.collection?.items);
      if (!item) {
        this.loadError = "This request is no longer in its collection.";
        return cx.notify();
      }
      this.collectionName = col.collection.name;
      this.setReq(item);
      cx.notify();
    });
  },

  // A request into the editor: every input made here (inputs can't be made while drawing).
  setReq(raw) {
    const req = normalize(raw);
    this.req = req;
    this.saved = this.ref ? snapshot(req) : null;
    this.kvForget?.("params");
    this.kvForget?.("headers");
    this.kvForget?.("form");
    this.kvForget?.("multipart");
    this.kvForget?.("tests");
    this.kvForget?.("captures");
    this.urlInput = InputState.new({ placeholder: "https://api.example.com/v1/items  ·  {{baseUrl}}/items", value: req.url });
    this.urlInput.on("change", (_e, cx) => { if (!this.urlSyncing) this.urlChanged(cx); });
    this.urlInput.on("submit", (_e, cx) => this.send(cx));
    this.nameInput = InputState.new({ placeholder: "Request name", value: req.name });
    this.nameInput.on("change", (_e, cx) => { this.req.name = this.nameInput.value(); cx.notify(); });
    this.buildTables();
    this.buildBody();
    this.buildAuth();
    this.timeoutInput = InputState.new({ value: String(req.settings.timeout ?? 30) });
    this.timeoutInput.on("change", (_e, cx) => { this.req.settings.timeout = Number(this.timeoutInput.value()) || 30; cx.notify(); });
  },

  buildTables() {
    const req = this.req;
    this.kvBuild("params", req.params, {
      onAdd: (row) => req.params.push(row),
      onEdit: () => this.paramsChanged(),
    });
    this.kvBuild("headers", req.headers, { onAdd: (row) => req.headers.push(row), placeholders: { key: "Header", value: "Value" } });
    this.kvBuild("form", req.body.form, { onAdd: (row) => req.body.form.push(row) });
    this.kvBuild("multipart", req.body.multipart, { onAdd: (row) => req.body.multipart.push(row), placeholders: { value: "Value, or a file path (drop a file on the row)" } });
    this.kvBuild("tests", req.tests, { fields: ["path", "value"], placeholders: { path: "path / header", value: "expected" }, onAdd: (row) => req.tests.push({ source: "status", op: "==", ...row }) });
    this.kvBuild("captures", req.captures, { fields: ["path", "variable"], placeholders: { path: "$.data.token", variable: "variable name" }, onAdd: (row) => req.captures.push({ source: "json", ...row }) });
  },

  // URL typed: Params follow it (enabled rows from the URL, disabled ones kept).
  urlChanged(cx) {
    const req = this.req;
    req.url = this.urlInput.value();
    const fromUrl = paramsFromUrl(req.url);
    const on = req.params.filter((p) => p.enabled !== false);
    const off = req.params.filter((p) => p.enabled === false);
    const next = fromUrl.map((p, i) => (on[i] ? Object.assign(on[i], { key: p.key, value: p.value }) : { ...p, id: rowId() }));
    req.params.splice(0, req.params.length, ...next, ...off);
    for (const r of next) {
      this.kvSet("params", r, "key", r.key);
      this.kvSet("params", r, "value", r.value);
    }
    this.kvBuild("params", req.params, { onAdd: (row) => req.params.push(row), onEdit: () => this.paramsChanged() });
    cx.notify();
  },

  // Params edited: the URL follows them.
  paramsChanged() {
    const req = this.req;
    req.url = urlWithParams(req.url, req.params);
    if (this.urlInput && this.urlInput.value() !== req.url) {
      this.urlSyncing = true;
      try {
        this.urlInput.set_value(req.url);
      } finally {
        this.urlSyncing = false;
      }
    }
  },

  buildBody() {
    const b = this.req.body;
    const C = syntaxColors(theme());
    const syntax = { keyword: C.keyword, string: C.string, comment: C.comment, function: C.fn, type: C.type, number: C.number, constant: C.constant };
    const ed = (language, value, onChange) => {
      const s = EditorState.new({ language, value, font_family: codeFont(), font_size: Math.max(11, codeSize() - 1), syntax, soft_wrap: true });
      s.on("change", (_e, cx) => { onChange(s.value()); cx.notify(); });
      return s;
    };
    this.bodyEditor = ed(b.mode === "xml" ? "xml" : b.mode === "json" ? "json" : undefined, b.text ?? "", (v) => { this.req.body.text = v; });
    this.gqlQuery = ed("graphql", b.graphql.query ?? "", (v) => { this.req.body.graphql.query = v; });
    this.gqlVars = ed("json", b.graphql.variables ?? "", (v) => { this.req.body.graphql.variables = v; });
    this.fileInput = InputState.new({ placeholder: "/path/to/file (or drop a file here)", value: b.file ?? "" });
    this.fileInput.on("change", (_e, cx) => { this.req.body.file = this.fileInput.value(); cx.notify(); });
  },

  setBodyMode(mode) {
    const b = this.req.body;
    b.mode = mode;
    if (mode === "json" && !b.text) {
      b.text = "{\n  \n}";
      this.bodyEditor.set_value(b.text);
    }
  },

  buildAuth() {
    const a = this.req.auth;
    const mk = (field, placeholder, masked = false) => {
      const s = InputState.new({ placeholder, value: String(a[field] ?? "") });
      if (masked) s.set_masked(true);
      s.on("change", (_e, cx) => { this.req.auth[field] = s.value(); cx.notify(); });
      return s;
    };
    this.authInputs = {
      username: mk("username", "Username"), password: mk("password", "Password", true), token: mk("token", "Token  ·  {{token}}", true),
      key: mk("key", "Key name, e.g. X-API-Key"), value: mk("value", "Value  ·  {{apiKey}}", true),
      tokenUrl: mk("tokenUrl", "Token URL"), clientId: mk("clientId", "Client ID"), clientSecret: mk("clientSecret", "Client secret", true), scope: mk("scope", "Scope (optional)"),
    };
  },

  dirty() {
    return this.saved !== null ? snapshot(this.req) !== this.saved : Boolean(this.req?.url);
  },

  // ── messages from popups (picks) and dialogs (commands) ────────────────────────────────
  takeMessages(cx) {
    const pick = shared("vx.http.pick");
    if (pick && pick.id !== this.pickSeen) {
      this.pickSeen = pick.id;
      if (pick.owner === this.owner) this.picked(pick.key, pick.value, cx);
    }
    const c = shared("vx.http.cmd");
    if (c && c.id !== this.cmdSeen) {
      this.cmdSeen = c.id;
      if (c.owner === this.owner) this.command(c, cx);
    }
  },

  picked(key, value, cx) {
    const req = this.req;
    if (key === "method") req.method = value;
    else if (key === "bodyMode") this.setBodyMode(value);
    else if (key === "authType") req.auth.type = value;
    else if (key === "http") req.settings.http = value;
    else if (key === "saveTo") {
      if (value === "__new") openDialog({ kind: "name", owner: this.owner, title: "New collection", placeholder: "Collection name", ok: "Create", then: { cmd: "saveNew" } });
      else this.saveInto(value, cx);
    } else if (key.startsWith("test:")) {
      const [, id, field] = key.split(":");
      const row = req.tests.find((x) => x.id === id) ?? (this.kvBlank?.tests?.id === id ? this.kvBlank.tests : null);
      if (row) row[field] = value;
    } else if (key.startsWith("cap:")) {
      const [, id] = key.split(":");
      const row = req.captures.find((x) => x.id === id) ?? (this.kvBlank?.captures?.id === id ? this.kvBlank.captures : null);
      if (row) row.source = value;
    } else if (key === "env") {
      if (this.repo) setActiveEnv(this.repo, value === "__none" ? null : value);
    }
    cx.notify();
  },

  command(c, cx) {
    if (c.cmd === "save") return this.save(cx);
    if (c.cmd === "ask") return openDialog({ ...c.ask, owner: this.owner });
    if (c.cmd === "rename") {
      this.req.name = c.value;
      if (this.myTab) run("tab.rename", { id: this.myTab, name: c.value });
      if (this.ref?.file) this.saveInto(this.ref.file, cx);
      return cx.notify();
    }
    if (c.cmd === "saveAs") {
      this.req.name = c.value;
      if (this.myTab) run("tab.rename", { id: this.myTab, name: c.value });
      this.pickCollection();
      return cx.notify();
    }
    if (c.cmd === "saveNew") {
      cx.spawn(async (cx) => {
        try {
          const file = await createCollection(this.repo, c.value, []);
          await this.saveInto(file, cx);
        } catch (e) {
          notify({ title: "Couldn't create the collection", body: String(e?.message ?? e), level: "error" });
        }
      });
    }
  },

  // ── save ───────────────────────────────────────────────────────────────────────────────
  save(cx) {
    if (!this.req) return;
    if (!this.repo) return notify({ title: "No repo to save into", body: "Pick a repo in the HTTP side bar first.", level: "warning" });
    if (this.ref?.file) return void this.saveInto(this.ref.file, cx);
    openDialog({ kind: "name", owner: this.owner, title: "Save request", detail: "Name it, then pick a collection.", value: this.req.name === "New Request" ? "" : this.req.name, placeholder: "e.g. List users", ok: "Next", then: { cmd: "saveAs" } });
  },

  pickCollection() {
    if (!this.repo) return;
    loadCollections(this.repo).catch(() => []).then((cols) => {
      openSelect(this.owner, "saveTo", [...cols.map((c) => ({ value: c.file, label: c.collection.name, icon: "folder" })), ...(cols.length ? [{ sep: true }] : []), { value: "__new", label: "New collection…", icon: "plus" }], null, 260);
    });
  },

  async saveInto(file, cx) {
    const req = JSON.parse(snapshot(this.req));
    try {
      const col = await editCollection(file, (c) => ({ ...c, items: upsertItem(c.items, req) }));
      this.ref = { file, id: req.id };
      this.collectionName = col.name;
      this.saved = snapshot(this.req);
      this.registerTab();
      if (this.myTab) run("tab.rename", { id: this.myTab, name: req.name || "Request" });
      notify({ title: `Saved ${req.name}`, body: col.name, level: "success", timeout: 1500 });
    } catch (e) {
      notify({ title: "Not saved", body: String(e?.message ?? e), level: "error", timeout: 6000 });
    }
    cx.notify();
  },

  // ⋯: Save, Copy as cURL, the code snippets, rename.
  moreMenu() {
    let r = null;
    try {
      r = resolveRequest(this.req, this.vars());
    } catch {}
    openMenu(this.owner, [
      { icon: "download", label: "Save  ⌘S", cmd: { cmd: "save" } },
      { icon: "pencil", label: "Rename…", cmd: { cmd: "ask", ask: { kind: "name", title: "Rename request", value: this.req.name, ok: "Rename", then: { cmd: "rename" } } } },
      { sep: true },
      ...(r ? Object.entries(SNIPPETS).map(([, [label, fn]]) => ({ icon: label === "cURL" ? "terminal" : "copy", label: `Copy as ${label}`, copy: fn(r) })) : []),
    ], 220);
  },

  chip(t, id, label, on, onClick, color) {
    return div().id(id).h(24).px(9).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.small)
      .bg(on ? t.selected : "#00000000").text_color(on ? color ?? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { onClick(cx); cx.notify(); }).child(label);
  },

  selectButton(t, id, label, onClick, color) {
    return h_flex().id(id).h(26).px(8).gap(6).items_center().rounded(6).cursor_pointer().border_1().border_color(t.border).bg(t.background)
      .hover((s) => s.bg(t.hover)).text_size(TEXT.small).text_color(color ?? t.foreground)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => onClick())
      .child(div().font_medium().child(label)).child(Icon("chevron-down", 10).text_color(t.dim));
  },

  field(t, label, input, width) {
    return v_flex().gap(4).when(Boolean(width), (el) => el.w(width)).when(!width, (el) => el.flex_1())
      .child(div().text_size(TEXT.caption).text_color(t.muted).child(label))
      .child(h_flex().h(28).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border).child(Input.new(input).flex_1().h_full().text_size(TEXT.small)));
  },

  renderRequestBar(t) {
    const req = this.req;
    const envName = this.repo ? activeEnv(this.repo) : null;
    const envs = Object.keys(this.envData?.envs?.envs ?? {});
    const miss = missingVars(`${req.url} ${req.headers.map((h) => h.value).join(" ")}`, this.vars());
    return v_flex().flex_none().px(10).py(8).gap(4).border_b(1).border_color(t.border)
      .child(h_flex().gap(6).items_center()
        .child(this.selectButton(t, "rq-method", req.method, () => openSelect(this.owner, "method", METHODS.map((m) => ({ value: m, label: m, color: methodColor(t, m) })), req.method, 140), methodColor(t, req.method)))
        .child(h_flex().flex_1().min_w(0).h(30).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
          .child(Input.new(this.urlInput).flex_1().h_full().text_size(TEXT.body).font_family(codeFont())))
        .child(Button({ id: "rq-send", label: this.sending ? "Sending…" : "Send", primary: true, disabled: this.sending, onClick: (cx) => this.send(cx) }))
        .child(this.selectButton(t, "rq-env", envName ?? "No Env", () => openSelect(this.owner, "env", [{ value: "__none", label: "No environment" }, ...(envs.length ? [{ sep: true }] : []), ...envs.map((e) => ({ value: e, label: e, icon: "layers" }))], envName ?? "__none", 220), envName ? t.ansi6 : t.muted))
        .child(IconButton({ id: "rq-more", icon: "more", label: "Save, rename, copy as cURL / code", size: 28, onClick: () => this.moreMenu() })))
      .when(this.dirty() || miss.length > 0, (el) => el.child(h_flex().gap(10).text_size(TEXT.caption)
        .when(this.dirty(), (e2) => e2.child(div().text_color(t.ansi3).child(this.ref ? "● unsaved changes · ⌘S" : "● not saved · ⌘S")))
        .when(miss.length > 0, (e2) => e2.child(div().text_color(t.ansi3).child(`undefined: ${miss.map((m) => `{{${m}}}`).join(" ")}`)))));
  },

  renderTabs(t) {
    const req = this.req;
    const n = (list) => (list ?? []).filter((x) => x.enabled !== false && (x.key || x.path || x.variable)).length;
    const tabs = [
      ["params", "Query", n(req.params)], ["headers", "Headers", n(req.headers)], ["auth", "Auth", req.auth.type !== "none" ? 1 : 0],
      ["body", "Body", req.body.mode !== "none" ? 1 : 0], ["tests", "Tests", n(req.tests) + n(req.captures)],
    ];
    return h_flex().h(32).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .children(tabs.map(([id, label, count]) => h_flex().id(`rt-${id}`).h(32).px(8).gap(4).items_center().cursor_pointer().text_size(TEXT.small)
        .border_b(2).border_color(this.tab === id ? t.accent : "#00000000").text_color(this.tab === id ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.tab = id; cx.notify(); })
        .child(label).when(count > 0, (el) => el.child(div().size(5).rounded(3).bg(t.accent)))));
  },

  renderTabBody(t) {
    const req = this.req;
    switch (this.tab) {
      case "params":
        return v_flex().child(this.kvTable("params", req.params, { onToggle: () => this.paramsChanged(), onRemove: (row) => { req.params.splice(req.params.indexOf(row), 1); this.paramsChanged(); } }));
      case "headers":
        return this.kvTable("headers", req.headers, { onRemove: (row) => req.headers.splice(req.headers.indexOf(row), 1) });
      case "body": return this.renderBody(t);
      case "auth": return this.renderAuth(t);
      case "tests": return this.renderTests(t);
    }
    return div();
  },

  renderBody(t) {
    const b = this.req.body;
    const modes = h_flex().px(10).py(6).gap(2).flex_wrap().children(BODY_MODES.map((m) => this.chip(t, `bm-${m}`, BODY_LABEL[m], b.mode === m, () => this.setBodyMode(m))));
    const out = v_flex().flex_1().min_h(0).child(modes);
    const edBox = (state, h) => div().mx(10).mb(6).when(Boolean(h), (el) => el.h(h)).when(!h, (el) => el.flex_1().min_h(120)).rounded(6).border_1().border_color(t.border).overflow_hidden().font_family(codeFont()).child(Editor.new(state).size_full());
    if (b.mode === "none") return out.child(Message("This request has no body."));
    if (["json", "text", "xml"].includes(b.mode)) {
      return out.child(edBox(this.bodyEditor))
        .when(b.mode === "json", (el) => el.child(h_flex().px(10).pb(6).gap(6)
          .child(Button({ id: "bd-pretty", label: "Format JSON", onClick: (cx) => { try { const v = JSON.stringify(JSON.parse(b.text), null, 2); b.text = v; this.bodyEditor.set_value(v); } catch (e) { notify({ title: "Not valid JSON", body: String(e.message), level: "warning" }); } cx.notify(); } }))));
    }
    if (b.mode === "form") return out.child(this.kvTable("form", b.form, { onRemove: (row) => b.form.splice(b.form.indexOf(row), 1) }));
    if (b.mode === "multipart") {
      return out.child(this.kvTable("multipart", b.multipart, {
        onRemove: (row) => b.multipart.splice(b.multipart.indexOf(row), 1),
        dropFile: (row, path, isBlank) => { row.type = "file"; row.value = path; this.kvSet("multipart", row, "value", path); if (isBlank) { if (!row.key) { row.key = "file"; this.kvSet("multipart", row, "key", "file"); } b.multipart.push(row); this.kvBlank.multipart = null; this.kvBuild("multipart", b.multipart, { onAdd: (r) => b.multipart.push(r) }); } },
        extra: (row) => div().id(`mpt-${row.id}`).w(52).flex_none().h_full().flex().items_center().justify_center().border_r(1).border_color(t.border).cursor_pointer()
          .text_size(TEXT.caption).text_color(row.type === "file" ? t.ansi4 : t.dim).hover((s) => s.bg(t.hover)).tooltip("Text or file (click to switch)")
          .on_click((_e, cx) => { row.type = row.type === "file" ? "text" : "file"; cx.notify(); }).child(row.type === "file" ? "file" : "text"),
      })).child(div().px(12).text_size(TEXT.caption).text_color(t.dim).child("Drop a file on a row to send it; the value is its path."));
    }
    if (b.mode === "graphql") {
      return out.child(div().px(12).pb(4).text_size(TEXT.caption).text_color(t.muted).child("Query")).child(edBox(this.gqlQuery))
        .child(div().px(12).pb(4).text_size(TEXT.caption).text_color(t.muted).child("Variables (JSON)")).child(edBox(this.gqlVars, 110));
    }
    if (b.mode === "binary") {
      return out.child(h_flex().mx(10).h(30).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
        .on_drop((e, cx) => { if (e.paths?.[0]) { this.fileInput.set_value(e.paths[0]); b.file = e.paths[0]; } cx.notify(); })
        .child(Icon("file", 13).text_color(t.dim)).child(Input.new(this.fileInput).flex_1().h_full().text_size(TEXT.small)));
    }
    return out;
  },

  renderAuth(t) {
    const a = this.req.auth;
    const I = this.authInputs;
    const out = v_flex().px(10).py(8).gap(10)
      .child(h_flex().gap(2).flex_wrap().children(AUTH_TYPES.map((k) => this.chip(t, `au-${k}`, AUTH_LABEL[k], a.type === k, () => { a.type = k; }))));
    if (a.type === "none") return out.child(div().text_size(TEXT.small).text_color(t.dim).child("No Authorization header is added."));
    if (a.type === "basic") return out.child(h_flex().gap(10).child(this.field(t, "Username", I.username)).child(this.field(t, "Password", I.password)));
    if (a.type === "bearer") return out.child(this.field(t, "Token (sent as Authorization: Bearer …)", I.token));
    if (a.type === "apikey") {
      return out.child(h_flex().gap(10).child(this.field(t, "Key", I.key)).child(this.field(t, "Value", I.value)))
        .child(h_flex().gap(6).items_center().child(div().text_size(TEXT.caption).text_color(t.muted).child("Add to"))
          .child(this.chip(t, "ak-h", "Header", a.in !== "query", () => { a.in = "header"; }))
          .child(this.chip(t, "ak-q", "Query params", a.in === "query", () => { a.in = "query"; })));
    }
    return out
      .child(h_flex().gap(10).child(this.field(t, "Token URL", I.tokenUrl)).child(this.field(t, "Scope", I.scope, 180)))
      .child(h_flex().gap(10).child(this.field(t, "Client ID", I.clientId)).child(this.field(t, "Client secret", I.clientSecret)))
      .child(h_flex().gap(10).items_center()
        .child(Button({ id: "oa-get", label: this.tokenBusy ? "Getting token…" : "Get New Access Token", primary: true, disabled: this.tokenBusy, onClick: (cx) => this.getToken(cx) }))
        .child(div().text_size(TEXT.caption).text_color(a.accessToken ? t.ansi2 : t.dim).child(a.accessToken ? `Token ready (${a.accessToken.slice(0, 10)}…); also in {{access_token}}` : "No token yet")));
  },

  // OAuth 2.0 client credentials: POST the token URL, keep access_token on the request and in
  // the captured variables ({{access_token}}).
  getToken(cx) {
    const a = this.req.auth;
    const v = this.vars();
    const fill = (s) => String(s ?? "").replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (all, k) => v[k] ?? all);
    if (!a.tokenUrl) return notify({ title: "Enter the token URL first", level: "warning" });
    this.tokenBusy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const args = ["-sS", "--max-time", "30", "-X", "POST", "--data-urlencode", "grant_type=client_credentials", "--data-urlencode", `client_id=${fill(a.clientId)}`, "--data-urlencode", `client_secret=${fill(a.clientSecret)}`];
      if (a.scope) args.push("--data-urlencode", `scope=${fill(a.scope)}`);
      args.push("--url", fill(a.tokenUrl));
      const r = await exec("curl", args, { timeout: 40000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      this.tokenBusy = false;
      try {
        const j = JSON.parse(r.stdout);
        if (!j.access_token) throw new Error(j.error_description || j.error || "No access_token in the reply");
        a.accessToken = j.access_token;
        addRuntime(this.repo, { access_token: j.access_token });
        notify({ title: "Got an access token", body: j.expires_in ? `Expires in ${j.expires_in}s` : undefined, level: "success", timeout: 3000 });
      } catch (e) {
        notify({ title: "No token", body: (r.stderr || String(e.message ?? e)).slice(0, 400), level: "error", timeout: 8000 });
      }
      cx.notify();
    });
  },

  renderTests(t) {
    const req = this.req;
    const row = (name, r, isBlank, kind) => {
      const inp = (field) => this.kvInputs?.get(`${name}:${r.id}:${field}`);
      const sel = (id, label, onClick, color) => div().id(id).h(26).px(8).flex_none().flex().items_center().gap(4).cursor_pointer().border_r(1).border_color(t.border)
        .text_size(TEXT.caption).text_color(color ?? t.foreground).hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => onClick())
        .child(label).child(Icon("chevron-down", 9).text_color(t.dim));
      const cell = (field, w) => h_flex().h(26).px(6).items_center().border_r(1).border_color(t.border).when(Boolean(w), (el) => el.w(w).flex_none()).when(!w, (el) => el.flex_1().min_w(0))
        .when(Boolean(inp(field)), (el) => el.child(Input.new(inp(field)).flex_1().h_full().text_size(TEXT.small)));
      return h_flex().id(`${name}-${r.id}`).h(28).flex_none().items_center().border_b(1).border_color(t.border)
        .child(div().id(`${name}c-${r.id}`).w(28).flex_none().h_full().flex().items_center().justify_center().border_r(1).border_color(t.border)
          .when(!isBlank, (el) => el.cursor_pointer().on_click((_e, cx) => { r.enabled = r.enabled === false; cx.notify(); })
            .child(div().size(13).rounded(3).border_1().border_color(r.enabled === false ? t.border : t.accent).bg(r.enabled === false ? "#00000000" : t.accent))))
        .child(sel(`${name}s-${r.id}`, SRC_LABEL[r.source] ?? r.source, () => openSelect(this.owner, `${kind}:${r.id}:source`, TEST_SOURCES.map((s) => ({ value: s, label: SRC_LABEL[s] })), r.source, 160)))
        .child(cell("path"))
        .when(kind === "test", (el) => el
          .child(sel(`${name}o-${r.id}`, r.op, () => openSelect(this.owner, `test:${r.id}:op`, TEST_OPS.map((o) => ({ value: o, label: o })), r.op, 150), t.accent))
          .child(cell("value")))
        .when(kind === "cap", (el) => el.child(div().px(6).text_size(TEXT.caption).text_color(t.dim).child("→")).child(cell("variable", 160)))
        .child(div().id(`${name}x-${r.id}`).w(28).flex_none().h_full().flex().items_center().justify_center()
          .when(!isBlank, (el) => el.cursor_pointer().text_color(t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { const list = kind === "test" ? req.tests : req.captures; list.splice(list.indexOf(r), 1); cx.notify(); }).child(Icon("x", 12))));
    };
    const table = (name, list, kind) => v_flex().flex_none().mx(10).my(4).rounded(6).border_1().border_color(t.border).overflow_hidden()
      .children(list.map((r) => row(name, r, false, kind)))
      .when(Boolean(this.kvBlank?.[name]), (el) => el.child(row(name, this.kvBlank[name], true, kind)));
    return v_flex().pb(8)
      .child(div().px(12).pt(8).text_size(TEXT.caption).font_medium().text_color(t.muted).child("TESTS"))
      .child(table("tests", req.tests, "test"))
      .child(div().px(12).pt(10).text_size(TEXT.caption).font_medium().text_color(t.muted).child("SET ENV VARIABLE · from the response, for the next requests"))
      .child(table("captures", req.captures, "cap"));
  },


};
