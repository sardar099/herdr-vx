// vx-workspace: a VS Code-style workspace in the sidebar.
//   explorer.js   one simple row per root + each root's file tree
//   menus.js      the ⋯ menu, right-click menus, Rename and New Workspace dialogs
// Workspaces are VS Code's .code-workspace files (edits are written the way VS Code writes
// them), or a plain folder of repos. The panel publishes the context every vx mod follows:
// shared("vx.workspace") (only this panel writes it) and vx.active (the picked repo).
// Popups and dialogs post commands (shared "vx.ws.cmd"); this panel runs them, so a closing
// popup never drops half an action.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, shared, setShared, run, panes, spaces, exec, watchFolder, props, pickFolder, checking, notify } from "herdr";
import {
  ctx, workspace, active, setActive, changedAt, git, findWorkspaceFile, folderRoots, loadWorkspace, rootFor,
  baseName, editWorkspaceFile, writeText,
} from "./ws.js";
import { newWorkspace, stringifyWorkspace, workspaceName, rootsFromWorkspace } from "./ws-core.js";
import { parseStatus } from "./git-core.js";
import { askConfirm, confirmMethods } from "./actions.js";
import { TEXT, Icon, IconButton, ConfirmView } from "./ui.js";
import { loadIcons } from "./icons.js";
import { showInViewer } from "./tabs.js";
import { explorerMethods } from "./explorer.js";
import { menuMethods, post } from "./menus.js";

const MOD = "vx-workspace";
const STATUS_MS = 10000;
const RECHECK_FILE_MS = 15000;
const RECENT = 10;

class VxWorkspace extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    loadIcons(this, cx);
    if (p.confirm) {
      this.confirmSpec = p.confirm;
      this.confirmOverlay = p.overlay;
      this.confirmFocus = cx.focus_handle();
      this.confirmFocus.focus();
      return;
    }
    if (p.menu) return void (this.menu = p.menu);
    // mod.open:vx-workspace (a key) opens the workspace menu.
    if (p.overlay) return void (this.menu = { kind: "header" });
    if (p.dialog) {
      this.initDialog(p.dialog);
      cx.timer.every(250, (cx) => this.takeReply(cx));
      return;
    }
    this.status = new Map();
    this.width = 240;
    this.initExplorer();
    this.filter = "";
    this.filterState = InputState.new({ placeholder: "Filter files in the workspace" });
    this.filterState.on("change", (_e, cx) => {
      this.filter = this.filterState.value().trim();
      if (this.filter) this.buildIndex(cx);
      cx.notify();
    });
    if (checking()) return;
    this.start(cx);
  }

  // ── workspace ──────────────────────────────────────────────────────────────────────────
  start(cx) {
    this.recent = [];
    try {
      this.recent = JSON.parse(localStorage.getItem("recent") ?? "[]");
    } catch {}
    setShared("vx.ws.recent", this.recent);
    this.cmdSeen = shared("vx.ws.cmd")?.id ?? null;
    cx.spawn(async (cx) => {
      if (localStorage.getItem("closed") === "1") return cx.notify();
      const saved = localStorage.getItem("file");
      const ws = workspace();
      if (ws?.roots?.length) this.adopt(ws, cx);
      else if (saved) await this.openFile(saved, cx);
      if (!this.ws) await this.discover(cx);
    });
    cx.timer.every(400, (cx) => this.follow(cx));
    cx.timer.every(STATUS_MS, (cx) => { this.refreshAll(cx); this.reloadOpen(cx); });
    cx.timer.every(RECHECK_FILE_MS, (cx) => this.ws?.file && this.openFile(this.ws.file, cx, { quiet: true }));
  }

  // Shows a workspace and makes it the one every vx mod uses.
  adopt(ws, cx) {
    const changed = JSON.stringify(ws) !== JSON.stringify(this.ws);
    const switched = (ws?.file ?? ws?.dir) !== (this.ws?.file ?? this.ws?.dir);
    this.ws = ws;
    setShared("vx.workspace", ws);
    if (ws.file) localStorage.setItem("file", ws.file);
    localStorage.removeItem("closed");
    if (switched) {
      this.entries = new Map();
      this.index = new Map();
      this.restoreOpen();
      this.reloadOpen(cx);
      this.status = new Map();
      this.remember(ws);
      // The active repo belongs to the workspace you left.
      if (active()?.root && !rootFor(active().root, ws.roots)) setShared("vx.active", null);
    }
    if (changed) this.refreshAll(cx);
    cx.notify();
  }

  remember(ws) {
    const key = ws.file ?? ws.dir;
    this.recent = [{ file: ws.file ?? null, dir: ws.file ? null : ws.dir, name: ws.name }, ...this.recent.filter((r) => (r.file ?? r.dir) !== key)].slice(0, RECENT);
    localStorage.setItem("recent", JSON.stringify(this.recent));
    setShared("vx.ws.recent", this.recent);
  }

  async openFile(file, cx, { quiet = false } = {}) {
    try {
      const ws = await loadWorkspace(file);
      if (!quiet || JSON.stringify(ws) !== JSON.stringify(this.ws)) this.adopt(ws, cx);
      this.error = null;
    } catch (e) {
      if (!quiet) this.error = String(e?.message ?? e);
      cx.notify();
    }
  }

  async openDir(dir, cx) {
    const file = await findWorkspaceFile(dir);
    if (file && file.startsWith(`${dir}/`)) return this.openFile(file, cx);
    const roots = await folderRoots(dir);
    if (!roots.length) return notify({ title: "No workspace there", body: "That folder has no .code-workspace file and no git repos.", level: "warning" });
    this.adopt({ file: null, name: baseName(dir), dir, roots }, cx);
  }

  // At start: a .code-workspace at or above the focused folder, else its git subfolders.
  async discover(cx) {
    const dir = ctx().focus.cwd ?? ctx().focus.space?.folder;
    if (!dir) return;
    const file = await findWorkspaceFile(dir);
    if (file) return this.openFile(file, cx);
    const roots = await folderRoots(dir);
    if (roots.length) this.adopt({ file: null, name: baseName(dir), dir, roots }, cx);
  }

  // ── following focus and commands ───────────────────────────────────────────────────────
  follow(cx) {
    // Focus moved to a terminal (or the terminal changed folder): a pick hands over to it.
    const f = ctx().focus;
    const fkey = `${f.terminal ?? ""}|${f.cwd ?? ""}`;
    if (fkey !== this.focusKey) {
      const first = this.focusKey === undefined;
      this.focusKey = fkey;
      const a = active();
      if (!first && f.terminal && a?.by === "pick") setShared("vx.active", { ...a, by: "click" });
    }
    const c = ctx();
    if (c.source === "root" && active()?.root !== c.root.path) setActive(c.root, "focus");
    if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.index = new Map();
      this.refreshAll(cx);
      this.reloadOpen(cx);
    }
    const cmd = shared("vx.ws.cmd");
    if (cmd?.id && cmd.id !== this.cmdSeen) {
      this.cmdSeen = cmd.id;
      this.runCommand(cmd, cx);
    }
    const a = active()?.root ?? null;
    if (a !== this.watching) this.watch(a, cx);
  }

  async edit(op, cx) {
    if (!this.ws?.file) return notify({ title: "Save the workspace first", body: "This is a folder of repos, not a .code-workspace file: use Save Workspace As… in the ⋯ menu.", level: "warning" });
    try {
      const { ws, lostComments } = await editWorkspaceFile(this.ws.file, op);
      this.adopt(ws, cx);
      if (lostComments) notify({ title: "Workspace saved", body: "Comments in the .code-workspace file were not kept.", level: "warning" });
    } catch (e) {
      notify({ title: "Couldn't change the workspace", body: String(e?.message ?? e), level: "error" });
    }
  }

  runCommand(c, cx) {
    cx.spawn(async (cx) => {
      switch (c.cmd) {
        case "addFolder": {
          const dir = await pickFolder({ prompt: "Add Folder to Workspace" });
          if (dir) await this.edit({ type: "add", paths: [dir] }, cx);
          break;
        }
        case "remove":
          await this.edit({ type: "remove", path: c.path }, cx);
          if (active()?.root === c.path) setShared("vx.active", null);
          break;
        case "rename":
          await this.edit({ type: "rename", path: c.path, name: c.name }, cx);
          break;
        case "move":
          if (c.to >= 0 && c.to < (this.ws?.roots.length ?? 0)) await this.edit({ type: "move", path: c.path, to: c.to }, cx);
          break;
        case "pickOpen": {
          const dir = await pickFolder({ prompt: "Open a folder holding a .code-workspace file, or a folder of repos" });
          if (dir) await this.openDir(dir, cx);
          break;
        }
        case "open":
          if (c.file) await this.openFile(c.file, cx);
          else if (c.dir) await this.openDir(c.dir, cx);
          break;
        case "close":
          this.ws = null;
          setShared("vx.workspace", null);
          setShared("vx.active", null);
          localStorage.setItem("closed", "1");
          cx.notify();
          break;
        case "create":
          try {
            const exists = await exec("test", ["-e", c.file]);
            if (exists.code === 0) throw new Error(`${c.file} already exists`);
            const dir = c.file.replace(/\/[^/]+$/, "");
            await writeText(c.file, stringifyWorkspace(newWorkspace(dir, c.paths)));
            await this.openFile(c.file, cx);
            notify({ title: `Created ${workspaceName(c.file)}`, body: c.file, level: "success", timeout: 3000 });
          } catch (e) {
            notify({ title: "Couldn't create the workspace", body: String(e?.message ?? e), level: "error" });
          }
          break;
        case "pickDir": {
          const dir = await pickFolder({ prompt: "Where to save the .code-workspace file" });
          if (dir) setShared("vx.ws.reply", { id: c.id, dialog: c.dialog, dir });
          break;
        }
        case "pickNewFolder": {
          const folder = await pickFolder({ prompt: "Add a folder to the new workspace" });
          if (folder) setShared("vx.ws.reply", { id: c.id, dialog: c.dialog, folder });
          break;
        }
        case "terminal":
          this.openTerminal(c.path);
          break;
        case "preview":
          showInViewer("vx-files", { root: c.root, on: null, rel: c.rel }, baseName(c.rel));
          break;
        case "finder":
          exec("open", c.reveal ? ["-R", c.path] : [c.path]).catch(() => {});
          break;
        case "fetch":
          askConfirm(MOD, {
            title: `Fetch ${c.name}?`,
            detail: "Downloads new commits and branches from the remote. Your files and branches don't change.",
            label: "Fetch",
            action: { cmd: "git", args: ["fetch", "--prune"], cwd: c.path, doing: "Fetching", done: `Fetched ${c.name}`, root: c.path },
          });
          break;
      }
    });
  }

  // A terminal already in that folder (its tab selected), else a new tab there.
  openTerminal(path) {
    const inside = (p) => p.terminal && p.cwd && (p.cwd === path || p.cwd.startsWith(`${path}/`));
    const pane = panes().find(inside);
    if (pane) {
      run("tab.select", { id: pane.tab });
      run("pane.focus", { pane: pane.pane });
    } else run("tab.new", { folder: path, name: baseName(path), space: spaces().find((s) => s.active)?.id });
  }

  // Only the active repo is watched (recursive watches on eight node_modules-heavy repos wake
  // on every install); the rest refresh on the timer.
  watch(root, cx) {
    this.watcher?.cancel?.();
    this.watching = root;
    if (!root) return;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.watching !== root) return;
        try {
          this.watcher = watchFolder(root);
          const paths = await this.watcher;
          if (paths.length && paths.every((p) => /\/(\.git|node_modules|\.next|dist)(\/|$)/.test(p))) continue;
        } catch {
          return;
        }
        if (this.watching !== root) return;
        this.index.delete(root);
        this.refreshOne(root, cx);
        this.reloadOpen(cx);
      }
    });
  }

  // ── git ────────────────────────────────────────────────────────────────────────────────
  refreshAll(cx) {
    for (const root of this.ws?.roots ?? []) this.refreshOne(root.path, cx);
  }

  refreshOne(path, cx) {
    this.loading ??= new Set();
    if (this.loading.has(path)) return;
    this.loading.add(path);
    cx.spawn(async (cx) => {
      let next;
      try {
        const r = await git(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=normal"], { cwd: path });
        next = r.code === 0 ? parseStatus(r.stdout) : { error: /not a git repository/i.test(r.stderr) ? "not a git repo" : (r.stderr || "git failed").trim() };
      } catch (e) {
        next = { error: String(e?.message ?? e) };
      } finally {
        this.loading.delete(path);
      }
      if (JSON.stringify(this.status.get(path)) !== JSON.stringify(next)) {
        this.status.set(path, next);
        this.publishSummary();
        cx.notify();
      }
    });
  }

  // A small summary other mods may show (vx-status, vx-ci).
  publishSummary() {
    const sum = {};
    for (const [path, s] of this.status) sum[path] = s.error ? { error: s.error } : { branch: s.branch, ahead: s.ahead, behind: s.behind, changed: s.changed, conflicts: s.conflicts };
    setShared("vx.git", sum);
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────────
  renderPanel() {
    const t = theme();
    const narrow = this.width < 160;
    const ws = this.ws;
    const root = v_flex().id(MOD).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 4) { this.width = size.width; cx.notify(); } });
    const head = h_flex().id("ws-head").h(36).flex_none().pl(narrow ? 0 : 12).pr(narrow ? 0 : 6).gap(2).items_center().border_b(1).border_color(t.border)
      .when(narrow, (el) => el.justify_center().child(Icon("layers", 13)))
      .when(!narrow, (el) => el
        .child(Icon("layers", 13).text_color(t.dim))
        .child(div().flex_1().min_w(0).pl(6).truncate().font_medium().text_size(TEXT.body).child(ws ? (ws.file ? `${ws.name} (Workspace)` : ws.name) : "Workspace"))
        .when(Boolean(ws), (e2) => e2
          .child(IconButton({ id: "ws-add", icon: "plus", label: "Add Folder to Workspace…", size: 22, onClick: () => post({ cmd: "addFolder" }) }))
          .child(IconButton({ id: "ws-dots", icon: "dot-files", label: this.showDots ? "Hide dotfiles" : "Show dotfiles", active: !this.showDots, size: 22, onClick: (cx) => this.toggleDots(cx) }))
          .child(IconButton({ id: "ws-collapse", icon: "collapse", label: "Collapse Folders", size: 22, onClick: (cx) => this.collapseAll(cx) }))
          .child(IconButton({ id: "ws-refresh", icon: "refresh", label: "Refresh", size: 22, spinning: (this.loading?.size ?? 0) > 0, onClick: (cx) => { this.index = new Map(); this.refreshAll(cx); this.reloadOpen(cx); } })))
        .child(IconButton({ id: "ws-more", icon: "more", label: "Workspace…", size: 22, onClick: () => this.openMenu({ kind: "header" }) })));
    root.child(head);
    if (ws && !narrow)
      root.child(h_flex().h(34).flex_none().px(8).items_center()
        .child(h_flex().flex_1().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
          .child(Icon("search", 12).text_color(t.dim))
          .child(Input.new(this.filterState).flex_1().h(24).text_size(TEXT.small))));
    const body = v_flex().id("ws-body").flex_1().min_h(0).overflow_y_scrollbar().pb(6);
    if (this.error) body.child(div().px(16).py(6).text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(this.error));
    if (!ws) {
      if (!narrow) {
        const recent = (this.recent ?? []).slice(0, 5);
        body.child(v_flex().px(12).py(6).gap(6)
          .child(div().text_size(TEXT.small).text_color(t.dim).whitespace_normal().child("No workspace open."))
          .child(h_flex().id("ws-open").h(26).px(8).gap(6).items_center().rounded(6).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small)
            .on_click(() => post({ cmd: "pickOpen" })).child(Icon("folder", 13)).child("Open Workspace…"))
          .child(h_flex().id("ws-new").h(26).px(8).gap(6).items_center().rounded(6).bg(t.raised).cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small)
            .on_click(() => this.openDialog({ kind: "new" })).child(Icon("layers", 13)).child("New Workspace…"))
          .when(recent.length > 0, (el) => el.child(div().pt(4).text_size(TEXT.caption).text_color(t.dim).child("RECENT")))
          .children(recent.map((r) => h_flex().id(`rc-${r.file ?? r.dir}`).h(24).px(8).gap(6).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
            .text_size(TEXT.small).tooltip(r.file ?? r.dir).on_click(() => post({ cmd: "open", file: r.file, dir: r.dir }))
            .child(Icon("history", 12).text_color(t.dim)).child(div().truncate().child(r.name)))));
      }
    } else if (narrow) {
      body.children(ws.roots.map((r) => div().id(`n-${r.path}`).h(30).flex().items_center().justify_center().cursor_pointer()
        .bg(active()?.root === r.path ? t.selected : "#00000000").tooltip(r.name).on_click((_e, cx) => { setActive(r, "pick"); cx.notify(); })
        .child(Icon("folder", 15).text_color(t.muted))));
    } else {
      if (!ws.roots.length) body.child(div().px(16).py(6).text_size(TEXT.small).text_color(t.dim).child("No folders. Use + to add one."));
      body.children(this.filter ? this.filterRows(t, this.filter) : this.explorerRows(t));
    }
    return root.child(body);
  }

  render(cx) {
    if (this.confirmSpec) return ConfirmView(this);
    if (this.menu) return this.renderMenu();
    if (this.dlg) return this.renderDialog(cx);
    return this.renderPanel();
  }
}

Object.assign(VxWorkspace.prototype, confirmMethods, explorerMethods, menuMethods);
export default VxWorkspace;
