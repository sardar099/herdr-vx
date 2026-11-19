// The HTTP side bar (activity bar ⌘⌥R): the active repo's collections (.vx/http), its
// environments (pick the active one), and your history. It's also where file changes happen:
// popups and dialogs post commands with owner "side" (shared vx.http.cmd).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, notify, shared, spaces, run, home, readTextFile, exec } from "herdr";
import {
  newRequest, parseCurl, fromPostman, toPostman, findItem, upsertItem, removeItem, newId, resolveRequest, toCurl, slugify,
} from "./http-core.js";
import {
  loadCollections, loadEnvs, loadHistory, clearHistory, createCollection, editCollection, deleteCollection, saveEnv, deleteEnv,
  activeEnv, setActiveEnv, varsFor, rev, httpDir,
} from "./store.js";
import { ctx, repoTop, contextKey } from "./ws.js";
import { writeText } from "./ws.js";
import { RepoButton } from "./repo-picker.js";
import { openMenu, openDialog, openSelect, postCmd } from "./http-ui.js";
import { methodColor } from "./request.js";
import { timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, Message } from "./ui.js";

const ROW = 22;
const OWNER = "side";

export function openRequestTab(repo, file, id, name) {
  const key = `${file}#${id}`;
  const space = spaces().find((s) => s.active);
  const tabs = shared("vx.http.tabs") ?? {};
  const live = new Set((space?.tabs ?? []).map((t) => t.id));
  const hit = Object.entries(tabs).find(([tab, k]) => k === key && live.has(tab));
  if (hit) return run("tab.select", { id: hit[0] });
  run("tab.new", { name: name || "Request", mod: "vx-http", props: { open: { repo, file, id } }, ...(space ? { space: space.id } : {}) });
}

export function openScratchTab(repo, request, name) {
  const space = spaces().find((s) => s.active);
  run("tab.new", { name: name || request?.name || "New Request", mod: "vx-http", props: { repo, request }, ...(space ? { space: space.id } : {}) });
}

export function openEnvTab(repo, name) {
  const space = spaces().find((s) => s.active);
  run("tab.new", { name: name ? `env: ${name}` : "New environment", mod: "vx-http", props: { envEdit: { repo, name: name ?? null } }, ...(space ? { space: space.id } : {}) });
}

export const sideMethods = {
  initSide(cx) {
    this.mode = "side";
    this.tops = new Map();
    this.repo = null;
    this.cols = null;
    this.envData = null;
    this.history = [];
    this.openSet = new Set(JSON.parse(localStorage.getItem("open") ?? "[]"));
    this.filter = InputState.new({ placeholder: "Filter requests" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.cmdSeen = shared("vx.http.cmd")?.id ?? null;
    this.pickSeen = shared("vx.http.pick")?.id ?? null;
    this.seenRev = rev();
    this.seenHist = shared("vx.http.history") ?? 0;
    cx.timer.every(500, (cx) => this.followRepo(cx));
    cx.timer.every(150, (cx) => this.sideMessages(cx));
    cx.timer.every(1000, (cx) => {
      if (rev() !== this.seenRev) {
        this.seenRev = rev();
        this.reload(cx);
      }
      if ((shared("vx.http.history") ?? 0) !== this.seenHist) {
        this.seenHist = shared("vx.http.history") ?? 0;
        this.loadHist(cx);
      }
    });
    cx.timer.every(30000, (cx) => this.reload(cx));
    this.loadHist(cx);
  },

  followRepo(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key === this.ctxKey) return;
    this.ctxKey = key;
    cx.spawn(async (cx) => {
      const top = c.cwd && !c.on ? await repoTop(this.tops, c.cwd, null) : null;
      const repo = top ?? c.root?.path ?? c.cwd ?? null;
      if (repo === this.repo) return;
      this.repo = repo;
      this.cols = null;
      this.envData = null;
      this.reload(cx);
    });
  },

  reload(cx) {
    const repo = this.repo;
    if (!repo || this.loadingSide) return;
    this.loadingSide = true;
    cx.spawn(async (cx) => {
      try {
        const [cols, envData] = await Promise.all([loadCollections(repo).catch(() => []), loadEnvs(repo).catch((e) => ({ envs: { envs: {} }, secrets: { envs: {} }, error: String(e.message ?? e) }))]);
        if (repo !== this.repo) return;
        this.cols = cols;
        this.envData = envData;
      } finally {
        this.loadingSide = false;
        cx.notify();
      }
    });
  },

  loadHist(cx) {
    cx.spawn(async (cx) => {
      this.history = await loadHistory();
      cx.notify();
    });
  },

  saveOpenSet() {
    try {
      localStorage.setItem("open", JSON.stringify([...this.openSet].slice(-300)));
    } catch {}
  },

  // ── commands (owner "side") ─────────────────────────────────────────────────────────────
  sideMessages(cx) {
    const pick = shared("vx.http.pick");
    if (pick && pick.id !== this.pickSeen) {
      this.pickSeen = pick.id;
      if (pick.owner === OWNER && pick.key === "env" && this.repo) setActiveEnv(this.repo, pick.value === "__none" ? null : pick.value);
      cx.notify();
    }
    const c = shared("vx.http.cmd");
    if (!c || c.id === this.cmdSeen) return;
    this.cmdSeen = c.id;
    if (c.owner !== OWNER) return;
    cx.spawn(async (cx) => {
      try {
        await this.sideCommand(c);
      } catch (e) {
        notify({ title: "That didn't work", body: String(e?.message ?? e), level: "error", timeout: 7000 });
      }
      this.reload(cx);
      cx.notify();
    });
  },

  async sideCommand(c) {
    const repo = this.repo;
    if (!repo && c.cmd !== "clearHistory") throw new Error("No repo: pick one first.");
    const firstCollection = async () => this.cols?.[0]?.file ?? createCollection(repo, "Requests");
    switch (c.cmd) {
      case "ask":
        return openDialog({ ...c.ask, owner: OWNER });
      case "newScratch":
        return openScratchTab(repo, newRequest(), "New Request");
      case "open":
        return openRequestTab(repo, c.file, c.itemId, c.name);
      case "useEnv":
        return setActiveEnv(repo, c.name);
      case "editEnv":
        return openEnvTab(repo, c.name);
      case "newCollection":
        return void (await createCollection(repo, c.value));
      case "newRequest": {
        const file = c.file ?? (await firstCollection());
        const req = newRequest({ name: "New Request" });
        await editCollection(file, (col) => {
          if (c.folder) {
            const add = (items) => items.map((it) => (it.id === c.folder ? { ...it, items: [...(it.items ?? []), req] } : it.folder ? { ...it, items: add(it.items ?? []) } : it));
            return { ...col, items: add(col.items) };
          }
          return { ...col, items: [...col.items, req] };
        });
        if (c.folder) this.openSet.add(`${file}#${c.folder}`);
        this.openSet.add(file);
        this.saveOpenSet();
        return openRequestTab(repo, file, req.id, req.name);
      }
      case "newFolder": {
        const folder = { id: newId(), folder: true, name: c.value, items: [] };
        await editCollection(c.file, (col) => ({ ...col, items: [...col.items, folder] }));
        this.openSet.add(c.file);
        return this.saveOpenSet();
      }
      case "renameCollection":
        return void (await editCollection(c.file, (col) => ({ ...col, name: c.value })));
      case "deleteCollection":
        return void (await deleteCollection(c.file));
      case "renameItem":
        return void (await editCollection(c.file, (col) => {
          const it = findItem(col.items, c.itemId);
          return it ? { ...col, items: upsertItem(col.items, { ...it, name: c.value }) } : col;
        }));
      case "deleteItem":
        return void (await editCollection(c.file, (col) => ({ ...col, items: removeItem(col.items, c.itemId) })));
      case "duplicateItem": {
        let copy = null;
        await editCollection(c.file, (col) => {
          const it = findItem(col.items, c.itemId);
          if (!it || it.folder) return col;
          copy = { ...JSON.parse(JSON.stringify(it)), id: newId(), name: `${it.name} copy` };
          return { ...col, items: [...col.items, copy] };
        });
        return copy ? openRequestTab(repo, c.file, copy.id, copy.name) : null;
      }
      case "importCurl": {
        const req = parseCurl(c.value);
        const file = await firstCollection();
        await editCollection(file, (col) => ({ ...col, items: [...col.items, req] }));
        this.openSet.add(file);
        this.saveOpenSet();
        return openRequestTab(repo, file, req.id, req.name);
      }
      case "importPostman": {
        const path = c.value.replace(/^~(?=\/)/, home());
        const text = await readTextFile(path);
        if (text === null) throw new Error(`Can't read ${path}`);
        const { collection, variables } = fromPostman(text);
        const file = await createCollection(repo, collection.name, collection.items);
        if (Object.keys(variables).length) {
          const name = slugify(collection.name);
          await saveEnv(repo, name, Object.entries(variables).map(([key, value]) => ({ key, value, secret: false })));
          notify({ title: `Imported ${collection.name}`, body: `Its variables became the environment "${name}".`, level: "success", timeout: 5000 });
        } else notify({ title: `Imported ${collection.name}`, level: "success", timeout: 3000 });
        this.openSet.add(file);
        return this.saveOpenSet();
      }
      case "exportPostman": {
        const col = this.cols?.find((x) => x.file === c.file)?.collection;
        if (!col) return;
        const dest = `${home()}/Downloads/${slugify(col.name)}.postman_collection.json`;
        await writeText(dest, `${JSON.stringify(toPostman(col), null, 2)}\n`);
        notify({ title: "Exported for Postman", body: dest, level: "success", timeout: 5000 });
        return void exec("open", ["-R", dest]).catch(() => {});
      }
      case "newEnv":
        await saveEnv(repo, c.value, []);
        setActiveEnv(repo, c.value);
        return openEnvTab(repo, c.value);
      case "deleteEnv":
        return void (await deleteEnv(repo, c.name));
      case "clearHistory":
        return void (await clearHistory());
    }
  },

  // ── menus ──────────────────────────────────────────────────────────────────────────────
  collectionMenu(col) {
    openMenu(OWNER, [
      { icon: "plus", label: "New Request", cmd: { cmd: "newRequest", file: col.file } },
      { icon: "folder", label: "New Folder…", cmd: { cmd: "ask", ask: { kind: "name", title: "New folder", placeholder: "Folder name", ok: "Create", then: { cmd: "newFolder", file: col.file } } } },
      { sep: true },
      { icon: "pencil", label: "Rename…", cmd: { cmd: "ask", ask: { kind: "name", title: "Rename collection", value: col.collection.name, ok: "Rename", then: { cmd: "renameCollection", file: col.file } } } },
      { icon: "cloud-upload", label: "Export for Postman", cmd: { cmd: "exportPostman", file: col.file } },
      { icon: "copy", label: "Copy File Path", copy: col.file },
      { sep: true },
      { icon: "trash", label: "Delete Collection…", danger: true, cmd: { cmd: "ask", ask: { kind: "confirm", title: `Delete "${col.collection.name}"?`, detail: "The collection file goes to the Trash.", ok: "Delete", danger: true, then: { cmd: "deleteCollection", file: col.file } } } },
    ]);
  },

  itemMenu(col, it) {
    if (it.folder) {
      return openMenu(OWNER, [
        { icon: "plus", label: "New Request", cmd: { cmd: "newRequest", file: col.file, folder: it.id } },
        { icon: "pencil", label: "Rename…", cmd: { cmd: "ask", ask: { kind: "name", title: "Rename folder", value: it.name, ok: "Rename", then: { cmd: "renameItem", file: col.file, itemId: it.id } } } },
        { sep: true },
        { icon: "trash", label: "Delete Folder…", danger: true, cmd: { cmd: "ask", ask: { kind: "confirm", title: `Delete the folder "${it.name}"?`, detail: "Its requests go with it.", ok: "Delete", danger: true, then: { cmd: "deleteItem", file: col.file, itemId: it.id } } } },
      ]);
    }
    let curl = "";
    try {
      curl = toCurl(resolveRequest(it, varsFor(this.repo, this.envData)));
    } catch {}
    openMenu(OWNER, [
      { icon: "eye", label: "Open", cmd: { cmd: "open", file: col.file, itemId: it.id, name: it.name } },
      { icon: "copy", label: "Duplicate", cmd: { cmd: "duplicateItem", file: col.file, itemId: it.id } },
      { icon: "pencil", label: "Rename…", cmd: { cmd: "ask", ask: { kind: "name", title: "Rename request", value: it.name, ok: "Rename", then: { cmd: "renameItem", file: col.file, itemId: it.id } } } },
      { icon: "terminal", label: "Copy as cURL", copy: curl },
      { sep: true },
      { icon: "trash", label: "Delete…", danger: true, cmd: { cmd: "ask", ask: { kind: "confirm", title: `Delete "${it.name}"?`, ok: "Delete", danger: true, then: { cmd: "deleteItem", file: col.file, itemId: it.id } } } },
    ]);
  },

  importMenu() {
    openMenu(OWNER, [
      { icon: "terminal", label: "Paste cURL…", cmd: { cmd: "ask", ask: { kind: "curl", title: "Import a cURL command", detail: "Paste one (Chrome's and Firefox's \"Copy as cURL\" work). It's added to the first collection.", ok: "Import", then: { cmd: "importCurl" } } } },
      { icon: "download", label: "Postman Collection (v2.1)…", cmd: { cmd: "ask", ask: { kind: "postman", title: "Import a Postman collection", detail: "The exported .json file (Collection v2.1). Its variables become an environment.", ok: "Import", then: { cmd: "importPostman" } } } },
      { sep: true },
      { icon: "folder", label: "New Collection…", cmd: { cmd: "ask", ask: { kind: "name", title: "New collection", placeholder: "Collection name", ok: "Create", then: { cmd: "newCollection" } } } },
    ], 250);
  },

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  methodBadge(t, m) {
    return div().w(38).flex_none().text_size(TEXT.tiny).font_semibold().text_color(methodColor(t, m)).child(m === "DELETE" ? "DEL" : m === "OPTIONS" ? "OPT" : m);
  },

  setSideTab(id, cx) {
    this.sideTab = id;
    try {
      localStorage.setItem("tab", id);
    } catch {}
    cx.notify();
  },

  // Thunder Client's side bar: New Request, then Activity · Collections · Env.
  renderSide() {
    const t = theme();
    this.sideTab ??= (() => { try { return localStorage.getItem("tab") || "collections"; } catch { return "collections"; } })();
    const root = v_flex().id("vx-http-side").size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(TEXT.body).overflow_hidden();
    root.child(v_flex().flex_none().px(8).pt(8).gap(6)
      .child(h_flex().id("hs-new").h(30).flex_none().gap(6).items_center().justify_center().rounded(6).cursor_pointer()
        .bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground).text_size(TEXT.small).font_medium().hover((s) => s.opacity(0.9))
        .on_click(() => (this.repo ? this.postSide({ cmd: "newScratch" }) : null))
        .child(Icon("plus", 13)).child("New Request"))
      .child(h_flex().gap(4).items_center().child(div().min_w(0).flex_1().child(RepoButton(this, "vx-http", this.repo)))));
    if (!this.repo) return root.child(Message("Pick a repo (Explorer, or the switcher above) to see its requests."));
    const tabs = [["activity", "Activity"], ["collections", "Collections"], ["env", "Env"]];
    root.child(h_flex().h(30).flex_none().px(6).gap(2).items_center().border_b(1).border_color(t.border)
      .children(tabs.map(([id, label]) => h_flex().id(`hst-${id}`).h(30).px(8).items_center().cursor_pointer().text_size(TEXT.small)
        .border_b(2).border_color(this.sideTab === id ? t.accent : "#00000000").text_color(this.sideTab === id ? t.foreground : t.muted)
        .hover((st) => st.text_color(t.foreground)).on_click((_e, cx) => this.setSideTab(id, cx)).child(label)))
      .child(div().flex_1())
      .when(this.sideTab === "collections", (el) => el
        .child(IconButton({ id: "hs-newcol", icon: "plus", label: "New Collection", size: 20, onClick: () => this.postSide({ cmd: "ask", ask: { kind: "name", title: "New collection", placeholder: "Collection name", ok: "Create", then: { cmd: "newCollection" } } }) }))
        .child(IconButton({ id: "hs-import", icon: "download", label: "Import cURL or a Postman collection", size: 20, onClick: () => this.importMenu() })))
      .when(this.sideTab === "env", (el) => el.child(IconButton({ id: "hs-newenv", icon: "plus", label: "New Environment", size: 20, onClick: () => this.postSide({ cmd: "ask", ask: { kind: "name", title: "New environment", placeholder: "e.g. local, staging, prod", ok: "Create", then: { cmd: "newEnv" } } }) })))
      .when(this.sideTab === "activity" && (this.history ?? []).some((h) => h.repo === this.repo), (el) => el.child(IconButton({ id: "hs-clearh", icon: "trash", label: "Clear Activity", size: 20, onClick: () => this.postSide({ cmd: "ask", ask: { kind: "confirm", title: "Clear your request activity?", detail: "Collections stay.", ok: "Clear", danger: true, then: { cmd: "clearHistory" } } }) }))));
    if (this.sideTab !== "env") root.child(h_flex().h(26).flex_none().mx(8).my(6).px(8).gap(6).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
      .child(Icon("search", 12).text_color(t.dim)).child(Input.new(this.filter).flex_1().h_full().text_size(TEXT.small)));
    const q = this.filter.value().trim().toLowerCase();
    const rows = this.sideTab === "activity" ? this.activityRows(t, q) : this.sideTab === "env" ? this.envRowsList(t) : this.collectionRows(t, q);
    return root.child(v_flex().id("hs-rows").flex_1().min_h(0).overflow_y_scrollbar().pt(this.sideTab === "env" ? 4 : 0).children(rows));
  },

  activityRows(t, q) {
    const hist = (this.history ?? []).filter((h) => h.repo === this.repo && (!q || `${h.name} ${h.method} ${h.url}`.toLowerCase().includes(q)));
    if (!hist.length) return [div().px(14).py(8).text_size(TEXT.small).text_color(t.dim).child("Requests you send show up here.")];
    return hist.slice(0, 60).map((h, i) => {
      let path = h.url;
      try {
        const u = new URL(h.url);
        path = `${u.host}${u.pathname}`;
      } catch {}
      const sc = !h.status ? t.ansi1 : h.status < 300 ? t.ansi2 : h.status < 400 ? t.ansi4 : h.status < 500 ? t.ansi3 : t.ansi1;
      return h_flex().id(`hh-${i}-${h.at}`).h(ROW + 4).flex_none().pl(10).pr(8).gap(4).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
        .tooltip(`${h.method} ${h.url}\n${h.status || "no response"} · ${h.time ?? "?"} ms`)
        .on_click(() => (h.ref?.file ? openRequestTab(this.repo, h.ref.file, h.ref.id, h.name) : openScratchTab(this.repo, { ...h.request, id: newId() }, h.name)))
        .child(this.methodBadge(t, h.method))
        .child(div().flex_1().min_w(0).truncate().child(path))
        .child(div().text_size(TEXT.caption).text_color(sc).child(String(h.status || "—")))
        .child(div().w(28).flex_none().text_right().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(h.at)));
    });
  },

  collectionRows(t, q) {
    const rows = [];
    if (!this.cols) return [Message("Loading…")];
    if (!this.cols.length) {
      return [v_flex().px(14).py(8).gap(8).text_size(TEXT.small).text_color(t.dim)
        .child(div().whitespace_normal().child("No collections yet. Save a request into one, or import."))
        .child(div().id("hs-first-import").text_color(t.accent).cursor_pointer().on_click(() => this.importMenu()).child("Import cURL or a Postman collection"))];
    }
    for (const col of this.cols) {
      const open = this.openSet.has(col.file) || Boolean(q);
      rows.push(h_flex().id(`hc-${col.file}`).h(ROW + 2).flex_none().pl(6).pr(6).gap(5).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
        .tooltip(`${col.collection.name}\n${col.file.replace(home(), "~")}${col.error ? `\n${col.error}` : ""}\nRight-click for more`)
        .on_click((_e, cx) => { if (this.openSet.has(col.file)) this.openSet.delete(col.file); else this.openSet.add(col.file); this.saveOpenSet(); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.collectionMenu(col); })
        .child(Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim))
        .child(Icon("folder", 13).text_color(col.error ? t.ansi1 : t.ansi3))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(col.collection.name)));
      if (!open) continue;
      const walk = (items, depth) => {
        for (const it of items ?? []) {
          if (it.folder) {
            const k = `${col.file}#${it.id}`;
            const fopen = this.openSet.has(k) || Boolean(q);
            const before = rows.length;
            rows.push(h_flex().id(`hf-${k}`).h(ROW + 2).flex_none().pl(6 + depth * 12).pr(6).gap(5).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
              .on_click((_e, cx) => { if (this.openSet.has(k)) this.openSet.delete(k); else this.openSet.add(k); this.saveOpenSet(); cx.notify(); })
              .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.itemMenu(col, it); })
              .child(Icon(fopen ? "chevron-down" : "chevron-right", 12).text_color(t.dim)).child(Icon("folder", 12).text_color(t.dim))
              .child(div().flex_1().min_w(0).truncate().child(it.name)));
            if (fopen) walk(it.items, depth + 1);
            if (q && rows.length === before + 1) rows.pop();
            continue;
          }
          if (q && !`${it.name} ${it.method} ${it.url}`.toLowerCase().includes(q)) continue;
          rows.push(h_flex().id(`hr-${col.file}-${it.id}`).h(ROW + 2).flex_none().pl(14 + depth * 12).pr(6).gap(4).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
            .tooltip(`${it.method} ${it.url}`)
            .on_click(() => openRequestTab(this.repo, col.file, it.id, it.name))
            .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.itemMenu(col, it); })
            .child(this.methodBadge(t, it.method))
            .child(div().flex_1().min_w(0).truncate().child(it.name)));
        }
      };
      walk(col.collection.items, 1);
    }
    return rows;
  },

  // Env: click to use one (or none); the pencil edits it.
  envRowsList(t) {
    const envName = activeEnv(this.repo);
    const names = Object.keys(this.envData?.envs?.envs ?? {});
    const rows = [];
    if (this.envData?.error) rows.push(Message(this.envData.error, true));
    const line = (key, label, on, onClick, edit) => h_flex().id(`he-${key}`).h(ROW + 4).flex_none().pl(10).pr(6).gap(8).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.small)
      .on_click(() => onClick())
      .child(div().size(12).flex_none().rounded(6).border_1().border_color(on ? t.accent : t.border).flex().items_center().justify_center().when(on, (el) => el.child(div().size(6).rounded(3).bg(t.accent))))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(label))
      .when(Boolean(edit), (el) => el.child(IconButton({ id: `hee-${key}`, icon: "pencil", label: "Edit variables", size: 20, onClick: () => edit() })));
    rows.push(line("__none", "No Environment", !envName, () => setActiveEnv(this.repo, null), null));
    for (const name of names) {
      rows.push(line(name, name, name === envName, () => setActiveEnv(this.repo, name), () => openEnvTab(this.repo, name))
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          openMenu(OWNER, [
            { icon: "pencil", label: "Edit", cmd: { cmd: "editEnv", name } },
            { icon: "trash", label: "Delete…", danger: true, cmd: { cmd: "ask", ask: { kind: "confirm", title: `Delete the environment "${name}"?`, detail: "Its values (and secrets) are removed.", ok: "Delete", danger: true, then: { cmd: "deleteEnv", name } } } },
          ]);
        }));
    }
    rows.push(div().px(12).pt(10).text_size(TEXT.caption).text_color(t.dim).whitespace_normal().child("Use {{name}} in a request. Secret values stay out of git."));
    return rows;
  },

  // Some commands just open a dialog or a tab (no file work): handled here, not posted.
  postSide(c) {
    if (c.cmd === "ask") return openDialog({ ...c.ask, owner: OWNER });
    postCmd({ ...c, owner: OWNER });
  },
};
