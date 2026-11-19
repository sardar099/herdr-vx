// The Files panel: a lazy tree of the context repo (see ws.js ctx()), git marks, a filter that
// searches the whole repo, and a right-click menu. Reads only; never writes to the repo.
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, v_virtual_list, Scrollbar } from "gpui-base";
import { theme, exec, watchFolder, openOverlay, closeOverlay, props, notify, hc, panes, focused, run } from "herdr";
import { ctx, contextKey, git, repoTop, changedAt, baseName } from "./ws.js";
import { parseStatus } from "./git-core.js";
import { TEXT, Icon, IconButton, Badge, FileIcon, Message, markColor } from "./ui.js";
import { showInViewer } from "./tabs.js";

const MOD = "vx-files";
const ROW = 24;
const INDENT = 12;
const PER_FOLDER = 2000;
const MAX_ROWS = 8000;
const MATCHES = 300;

// Null-separated "d|f", name pairs; the folder is $1, never part of the script text.
const LIST = `cd -- "$1" || exit 2; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; [ "$p" = .git ] && continue; if [ -d "$p" ]; then printf 'd\\0%s\\0' "$p"; else printf 'f\\0%s\\0' "$p"; fi; n=$((n+1)); [ $n -ge ${PER_FOLDER} ] && break; done; exit 0`;
// Without git: every file below, skipping the usual heavy folders.
const FIND = `cd -- "$1" && find . -maxdepth 8 \\( -name .git -o -name node_modules -o -name .next -o -name dist -o -name build -o -name target -o -name .venv \\) -prune -o -type f -print 2>/dev/null | head -n 40000`;

// a1 < a2 < a10, case-insensitively.
function natural(a, b) {
  const re = /(\d+)|(\D+)/g;
  const xa = a.toLowerCase().match(re) ?? [];
  const xb = b.toLowerCase().match(re) ?? [];
  for (let i = 0; i < Math.min(xa.length, xb.length); i++) {
    if (xa[i] === xb[i]) continue;
    const na = /^\d/.test(xa[i]);
    const nb = /^\d/.test(xb[i]);
    if (na && nb) return Number(xa[i]) - Number(xb[i]);
    return xa[i] < xb[i] ? -1 : 1;
  }
  return xa.length - xb.length;
}

// Subsequence match with a score: consecutive letters and name hits weigh more.
function score(path, query) {
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (name.includes(query)) return 1000 - name.length + (name.startsWith(query) ? 200 : 0);
  if (p.includes(query)) return 500 - p.length;
  let at = -1;
  let s = 0;
  for (const ch of query) {
    const next = p.indexOf(ch, at + 1);
    if (next < 0) return -1;
    s += next === at + 1 ? 5 : 1;
    at = next;
  }
  return s;
}

const shellQuote = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

export const treeMethods = {
  initTree(cx) {
    this.tops = new Map();
    this.entries = new Map();
    this.openDirs = new Set();
    this.marks = {};
    this.ignored = new Set();
    this.filter = "";
    this.index = null;
    this.showDots = localStorage.getItem("dots") !== "0";
    this.filterState.on("change", (_e, cx) => {
      this.filter = this.filterState.value().trim().toLowerCase();
      if (this.filter && !this.index && !this.indexing) this.buildIndex(cx);
      cx.notify();
    });
  },

  // Called every 400 ms: a new context starts over, a change elsewhere rereads.
  followTree(cx) {
    const c = ctx();
    const key = contextKey(c);
    if (key !== this.key) {
      this.key = key;
      this.switchTo(c, cx);
    } else if (changedAt() !== this.seenChange) {
      this.seenChange = changedAt();
      this.reload(cx);
    }
  },

  switchTo(c, cx) {
    const key = this.key;
    cx.spawn(async (cx) => {
      const top = c.cwd ? await repoTop(this.tops, c.cwd, c.on) : null;
      if (this.key !== key) return;
      if (this.root) localStorage.setItem(`open:${this.root}`, JSON.stringify([...this.openDirs]));
      this.root = top ?? c.cwd;
      this.isRepo = Boolean(top);
      this.on = c.on;
      this.source = c.source;
      this.entries = new Map();
      this.marks = {};
      this.ignored = new Set();
      this.index = null;
      this.error = null;
      try {
        this.openDirs = new Set(JSON.parse(localStorage.getItem(`open:${this.root}`) ?? "[]"));
      } catch {
        this.openDirs = new Set();
      }
      this.reload(cx);
      this.watchRoot(cx);
    });
  },

  reload(cx) {
    if (!this.root || this.reloading) return;
    this.reloading = true;
    const root = this.root;
    cx.spawn(async (cx) => {
      try {
        for (const rel of ["", ...this.openDirs]) {
          if (this.root !== root) return;
          await this.loadDir(rel).catch((e) => {
            if (!rel) throw e;
            this.openDirs.delete(rel);
          });
        }
        if (this.isRepo) await this.loadGit();
        this.error = null;
      } catch (e) {
        if (this.root === root) this.error = String(e?.message ?? e);
      } finally {
        this.reloading = false;
        cx.notify();
      }
    });
  },

  async loadDir(rel) {
    const dir = rel ? `${this.root}/${rel}` : this.root;
    const r = await exec("sh", ["-c", LIST, "vx-files", dir], { on: this.on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `Cannot list ${dir}`);
    const f = r.stdout.split("\0");
    const list = [];
    for (let i = 0; i + 1 < f.length; i += 2) list.push({ name: f[i + 1], dir: f[i] === "d" });
    list.sort((a, b) => Number(b.dir) - Number(a.dir) || natural(a.name, b.name));
    this.entries.set(rel, list);
  },

  async loadGit() {
    const root = this.root;
    const [st, ign] = await Promise.all([
      git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd: root, on: this.on }),
      git(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: root, on: this.on }).catch(() => null),
    ]);
    if (this.root !== root) return;
    const marks = {};
    if (st.code === 0) for (const f of parseStatus(st.stdout).files) marks[f.path] = f.mark;
    this.marks = marks;
    this.ignored = new Set((ign?.code === 0 ? ign.stdout.split("\0") : []).filter(Boolean).slice(0, 5000).map((p) => p.replace(/\/$/, "")));
  },

  // Local folders tell us when they change; another machine's are read on the timer.
  watchRoot(cx) {
    this.watcher?.cancel?.();
    const root = this.root;
    if (this.on || !root) return;
    cx.spawn(async (cx) => {
      for (;;) {
        if (this.root !== root) return;
        try {
          this.watcher = watchFolder(root);
          const paths = await this.watcher;
          if (this.root !== root) return;
          // Ignore churn under .git and the heavy ignored folders.
          if (paths.length && paths.every((p) => /\/(\.git|node_modules|\.next|dist)(\/|$)/.test(p))) continue;
        } catch {
          return;
        }
        this.index = null;
        this.reload(cx);
      }
    });
  },

  toggleDir(rel, cx) {
    if (this.openDirs.has(rel)) this.openDirs.delete(rel);
    else {
      this.openDirs.add(rel);
      if (!this.entries.has(rel)) cx.spawn(async (cx) => {
        await this.loadDir(rel).catch((e) => { this.error = String(e?.message ?? e); });
        cx.notify();
      });
    }
    localStorage.setItem(`open:${this.root}`, JSON.stringify([...this.openDirs]));
    cx.notify();
  },

  collapseAll(cx) {
    this.openDirs = new Set();
    localStorage.setItem(`open:${this.root}`, "[]");
    cx.notify();
  },

  // Every file in the repo (tracked and new, not ignored), for the filter.
  buildIndex(cx) {
    const root = this.root;
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        const r = this.isRepo
          ? await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, on: this.on })
          : await exec("sh", ["-c", FIND, "vx-files", root], { on: this.on });
        if (this.root !== root) return;
        this.index = (this.isRepo ? r.stdout.split("\0") : r.stdout.split("\n").map((p) => p.replace(/^\.\//, ""))).filter(Boolean);
      } catch {
        this.index = [];
      } finally {
        this.indexing = false;
        cx.notify();
      }
    });
  },

  // ── rows ───────────────────────────────────────────────────────────────────────────────
  hasChangeBelow(rel) {
    const prefix = `${rel}/`;
    for (const p in this.marks) if (p.startsWith(prefix)) return true;
    return false;
  },

  treeRows() {
    const out = [];
    const walk = (rel, depth) => {
      for (const e of this.entries.get(rel) ?? []) {
        if (out.length >= MAX_ROWS) return;
        if (!this.showDots && e.name.startsWith(".")) continue;
        const path = rel ? `${rel}/${e.name}` : e.name;
        out.push({ key: path, rel: path, name: e.name, dir: e.dir, depth, open: e.dir && this.openDirs.has(path) });
        if (e.dir && this.openDirs.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  },

  filterRows() {
    if (!this.index) return [];
    const q = this.filter;
    return this.index
      .map((p) => ({ p, s: score(p, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s || a.p.length - b.p.length)
      .slice(0, MATCHES)
      .map(({ p }) => ({ key: `f:${p}`, rel: p, name: baseName(p), dir: false, depth: 0, folder: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "" }));
  },

  row(t, r) {
    const mark = r.dir ? null : this.marks[r.rel];
    const below = r.dir && this.hasChangeBelow(r.rel);
    const ignored = this.ignored.has(r.rel) || [...this.ignored].some((i) => r.rel.startsWith(`${i}/`));
    const color = mark ? markColor(mark, t) : below ? t.ansi3 : ignored ? t.dim : t.foreground;
    const selected = this.selected === r.rel;
    return h_flex()
      .id(`row-${r.key}`).h(ROW).w_full().pl(8 + r.depth * INDENT).pr(8).gap(5).items_center().rounded(5)
      .bg(selected ? t.selected : "#00000000").text_size(TEXT.body).cursor_pointer()
      .child(r.dir ? Icon(r.open ? "chevron-down" : "chevron-right", 12).text_color(t.dim) : div().w(12).flex_none())
      .child(FileIcon(this.icons, `${this.root}/${r.rel}`, { dir: r.dir, open: r.open, size: 14 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).when(ignored && !mark, (el) => el.opacity(0.6)).child(r.name))
      .when(Boolean(r.folder), (el) => el.child(div().max_w(140).truncate().text_size(TEXT.caption).text_color(t.dim).child(r.folder)))
      .when(Boolean(mark), (el) => el.child(div().w(12).flex_none().text_size(TEXT.caption).text_color(color).child(mark)))
      .when(below && !mark, (el) => el.child(div().size(5).flex_none().rounded(3).bg(t.ansi3)));
  },

  // ── actions ────────────────────────────────────────────────────────────────────────────
  press(key, cx) {
    const r = (this.lastRows ?? []).find((x) => x.key === key);
    if (!r) return;
    this.selected = r.rel;
    if (r.dir) this.toggleDir(r.rel, cx);
    else this.preview(r.rel);
    cx.notify();
  },

  preview(rel) {
    showInViewer(MOD, { root: this.root, on: this.on ?? null, rel }, baseName(rel));
  },

  // The agents in the focused tab, for "Insert @path".
  tabAgents() {
    const tab = focused()?.tab;
    return panes().filter((p) => p.tab === tab && p.terminal && (p.app || p.status));
  },

  openMenu(key) {
    const r = (this.lastRows ?? []).find((x) => x.key === key);
    if (!r) return;
    this.selected = r.rel;
    const agents = this.tabAgents().map((p) => ({ terminal: p.terminal, name: p.title || p.app || p.terminal }));
    const items = 5 + agents.length;
    openOverlay({ mod: MOD, kind: "popup", width: 250, height: items * 28 + 14, props: { menu: { root: this.root, on: this.on ?? null, rel: r.rel, dir: r.dir, agents } } });
  },

  menuItems(m) {
    if (m.plan) return this.planMenuItems(m);
    const abs = `${m.root}/${m.rel}`;
    const local = !m.on;
    const items = [];
    if (!m.dir) items.push({ id: "preview", icon: "eye", label: "Preview", run: () => showInViewer(MOD, { root: m.root, on: m.on, rel: m.rel }, baseName(m.rel)) });
    if (local) {
      items.push({ id: "open", icon: "external", label: m.dir ? "Open in Finder" : "Open in default app", run: () => exec("open", ["--", abs]).catch(() => {}) });
      items.push({ id: "reveal", icon: "folder", label: "Reveal in Finder", run: () => exec("open", ["-R", "--", abs]).catch(() => {}) });
    }
    items.push({ id: "rel", icon: "copy", label: "Copy relative path", run: (cx) => cx.write_to_clipboard(m.rel) });
    items.push({ id: "abs", icon: "copy", label: "Copy full path", run: (cx) => cx.write_to_clipboard(abs) });
    for (const a of m.agents ?? [])
      items.push({ id: `agent-${a.terminal}`, icon: "terminal", label: `Insert @${baseName(m.rel)} into ${a.name}`, run: () => this.sendToAgent(a.terminal, abs) });
    return items;
  },

  // Types "@path " into the agent's prompt (no Enter): the agent decides what to do with it.
  sendToAgent(terminal, abs) {
    hc(["send", terminal, `@${shellQuote(abs)} `])
      .then((r) => {
        if (r.code !== 0) notify({ title: "Couldn't reach the agent", body: r.stderr.trim(), level: "error" });
        else run("pane.focus", { terminal });
      })
      .catch((e) => notify({ title: "Couldn't reach the agent", body: String(e?.message ?? e), level: "error" }));
  },

  renderMenu() {
    const t = theme();
    return v_flex().id("vx-files-menu").size_full().p(6).gap(1).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(this.menuItems(this.menu).map((item) =>
        h_flex().id(`m-${item.id}`).h(28).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { item.run(cx); closeOverlay(props()?.overlay); })
          .child(Icon(item.icon, 13).text_color(t.dim)).child(div().truncate().child(item.label))));
  },

  renderTree() {
    const t = theme();
    const name = this.root ? baseName(this.root) : "Files";
    const changed = Object.keys(this.marks).length;
    const head = h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
      .child(FileIcon(this.icons, this.root ?? "folder", { dir: true, open: true, size: 15 }))
      .child(div().flex_1().min_w(0).truncate().font_medium().child(name))
      .when(this.source === "active", (el) => el.child(Badge("workspace", t.accent)))
      .when(changed > 0, (el) => el.child(Badge(`${changed}`, t.ansi3)))
      .child(IconButton({ id: "f-dots", icon: "dot-files", label: this.showDots ? "Hide dotfiles" : "Show dotfiles", active: !this.showDots, onClick: (cx) => { this.showDots = !this.showDots; localStorage.setItem("dots", this.showDots ? "1" : "0"); cx.notify(); }, size: 22 }))
      .child(IconButton({ id: "f-collapse", icon: "collapse", label: "Collapse all", onClick: (cx) => this.collapseAll(cx), size: 22 }))
      .child(IconButton({ id: "f-refresh", icon: "refresh", label: "Refresh", spinning: Boolean(this.reloading), onClick: (cx) => { this.index = null; this.reload(cx); }, size: 22 }));
    const search = h_flex().h(34).flex_none().px(8).items_center()
      .child(h_flex().flex_1().h(26).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.border).bg(t.input ?? t.background)
        .child(Icon("search", 12).text_color(t.dim))
        .child(Input.new(this.filterState).flex_1().h(24).text_size(TEXT.small)));
    const body = v_flex().id("f-body").flex_1().min_h(0).relative();
    if (!this.root) body.child(Message("Pick a repo in Workspace, or focus a terminal in a folder."));
    else if (this.error) body.child(Message(this.error, true));
    else {
      const rows = this.filter ? this.filterRows() : this.treeRows();
      this.lastRows = rows;
      if (this.filter && !this.index) body.child(Message("Indexing…"));
      else if (!rows.length) body.child(Message(this.filter ? "No matches." : this.reloading ? "Loading…" : "Empty folder."));
      else {
        const listId = `f-list-${this.root}-${this.filter ? "q" : "t"}`;
        body
          .child(v_virtual_list(listId, rows.length, ROW, (i) => rows[i].key, (range) => rows.slice(range.start, range.end).map((r) => this.row(t, r)))
            .on_item_click((key, cx) => this.press(key, cx))
            .on_item_secondary_click((key, _e, cx) => { this.openMenu(key); cx.notify(); })
            .size_full().px(4))
          .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
      }
    }
    return v_flex().id(MOD).size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(head).child(search).child(body)
      .child(h_flex().h(22).flex_none().px(10).items_center().border_t(1).border_color(t.border).text_size(TEXT.caption).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.selected ?? (this.isRepo ? "git repo" : this.root ? "not a git repo" : ""))));
  },
};
