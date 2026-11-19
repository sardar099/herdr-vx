// The explorer: one simple row per root (VS Code style), and each root's file tree right under
// it. Click a root: make it the active repo (every vx panel follows) and fold it open/closed.
// Click a file: preview it. Drag a root onto another to reorder. Right-click: a menu.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, shared } from "herdr";
import { active, setActive, git } from "./ws.js";
import { TEXT, Icon, FileIcon, RootIcon, markColor, stateLook } from "./ui.js";
import { showInViewer } from "./tabs.js";

const ROW = 22;
const INDENT = 12;
const MAX_ROWS = 2500;
const HIDDEN = new Set([".git", ".DS_Store"]);
// "d|f", name pairs, null-separated; the folder is $1, never part of the script text.
const LIST = 'cd -- "$1" || exit 2; n=0; for p in * .[!.]* ..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; if [ -d "$p" ]; then printf "d\\0%s\\0" "$p"; else printf "f\\0%s\\0" "$p"; fi; n=$((n+1)); [ $n -ge 2000 ] && break; done; exit 0';

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

export const explorerMethods = {
  initExplorer() {
    this.entries = new Map(); // "root\0rel" -> [{ name, dir }]
    this.open = new Set(); // "root\0rel" folded open ("" rel = the root itself)
    this.selected = null;
    this.ignored = new Map(); // root path -> Set of git-ignored relative paths (dimmed)
    this.index = new Map(); // root path -> every file (tracked + new, not ignored), for the filter
    this.showDots = localStorage.getItem("dots") !== "0";
  },

  // git's own ignore rules: ignored folders show dimmed, like VS Code.
  async loadIgnored(root) {
    const r = await git(["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"], { cwd: root }).catch(() => null);
    this.ignored.set(root, new Set((r?.code === 0 ? r.stdout.split("\0") : []).filter(Boolean).slice(0, 5000).map((p) => p.replace(/\/$/, ""))));
  },

  isIgnored(root, rel) {
    const set = this.ignored.get(root);
    if (!set?.size) return false;
    if (set.has(rel)) return true;
    for (let i = rel.indexOf("/"); i > 0; i = rel.indexOf("/", i + 1)) if (set.has(rel.slice(0, i))) return true;
    return false;
  },

  toggleDots(cx) {
    this.showDots = !this.showDots;
    localStorage.setItem("dots", this.showDots ? "1" : "0");
    cx.notify();
  },

  // ── filter: every file of every root, by name first ───────────────────────────────────
  buildIndex(cx) {
    const roots = this.ws?.roots ?? [];
    const missing = roots.filter((r) => !this.index.has(r.path));
    if (!missing.length || this.indexing) return;
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        for (const r of missing) {
          const out = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: r.path }).catch(() => null);
          this.index.set(r.path, out?.code === 0 ? out.stdout.split("\0").filter(Boolean) : []);
        }
      } finally {
        this.indexing = false;
        cx.notify();
      }
    });
  },

  filterRows(t, query) {
    const q = query.toLowerCase();
    const hits = [];
    for (const root of this.ws?.roots ?? []) {
      for (const rel of this.index.get(root.path) ?? []) {
        const low = rel.toLowerCase();
        const name = low.slice(low.lastIndexOf("/") + 1);
        const score = name.startsWith(q) ? 3 : name.includes(q) ? 2 : low.includes(q) ? 1 : 0;
        if (score) hits.push({ root, rel, score });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
    const rows = [];
    let last = null;
    for (const h of hits.slice(0, 300)) {
      if (h.root !== last) {
        last = h.root;
        rows.push(div().id(`fh-${h.root.path}`).h(22).px(10).flex().items_center().text_size(TEXT.caption).text_color(t.dim).child(h.root.name.toUpperCase()));
      }
      const name = h.rel.slice(h.rel.lastIndexOf("/") + 1);
      const dir = h.rel.includes("/") ? h.rel.slice(0, h.rel.lastIndexOf("/")) : "";
      rows.push(h_flex().id(`fr-${h.root.path}-${h.rel}`).h(ROW).flex_none().pl(14).pr(8).gap(6).items_center().cursor_pointer().hover((st) => st.bg(t.hover)).text_size(TEXT.body)
        .drag_paths([`${h.root.path}/${h.rel}`])
        .on_click(() => { setActive(h.root, "pick"); showInViewer("vx-files", { root: h.root.path, on: null, rel: h.rel }, name); })
        .child(FileIcon(this.icons, `${h.root.path}/${h.rel}`, { size: 14 }))
        .child(div().flex_none().max_w(200).truncate().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.caption).text_color(t.dim).child(dir)));
    }
    if (!rows.length) rows.push(div().px(12).py(6).text_size(TEXT.small).text_color(t.dim).child(this.indexing ? "Indexing…" : "No matching files."));
    else if (hits.length > 300) rows.push(div().px(12).py(4).text_size(TEXT.caption).text_color(t.dim).child(`Showing 300 of ${hits.length}. Type more to narrow it.`));
    return rows;
  },

  restoreOpen() {
    try {
      this.open = new Set(JSON.parse(localStorage.getItem(`open:${this.ws?.file ?? this.ws?.dir}`) ?? "[]"));
    } catch {
      this.open = new Set();
    }
  },

  saveOpen() {
    localStorage.setItem(`open:${this.ws?.file ?? this.ws?.dir}`, JSON.stringify([...this.open]));
  },

  async loadDir(root, rel) {
    const dir = rel ? `${root}/${rel}` : root;
    const r = await exec("sh", ["-c", LIST, "vx-ws", dir]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || `Can't list ${dir}`);
    const f = r.stdout.split("\0");
    const list = [];
    for (let i = 0; i + 1 < f.length; i += 2) if (!HIDDEN.has(f[i + 1])) list.push({ name: f[i + 1], dir: f[i] === "d" });
    list.sort((a, b) => Number(b.dir) - Number(a.dir) || natural(a.name, b.name));
    this.entries.set(`${root}\0${rel}`, list);
    if (!rel) await this.loadIgnored(root);
  },

  // Rereads every open folder (after a change, or on the timer).
  reloadOpen(cx) {
    const keys = [...this.open];
    cx.spawn(async (cx) => {
      for (const key of keys) {
        const [root, rel] = key.split("\0");
        await this.loadDir(root, rel).catch(() => this.open.delete(key));
      }
      cx.notify();
    });
  },

  toggle(root, rel, cx) {
    const key = `${root}\0${rel}`;
    if (this.open.has(key)) this.open.delete(key);
    else {
      this.open.add(key);
      if (!this.entries.has(key)) cx.spawn(async (cx) => {
        await this.loadDir(root, rel).catch(() => {});
        cx.notify();
      });
    }
    this.saveOpen();
    cx.notify();
  },

  collapseAll(cx) {
    this.open = new Set();
    this.saveOpen();
    cx.notify();
  },

  // git marks of a root's files (from the status the panel already reads), by relative path.
  marksOf(root) {
    const s = this.status.get(root.path);
    if (!s?.files) return null;
    const m = {};
    for (const f of s.files) m[f.path.replace(/\/$/, "")] = f.mark;
    return m;
  },

  // ── rows ───────────────────────────────────────────────────────────────────────────────
  rootRow(t, root, index) {
    const s = this.status.get(root.path);
    const ci = (shared("vx.ci.summary") ?? {})[root.path];
    const isActive = active()?.root === root.path;
    const open = this.open.has(`${root.path}\0`);
    // One dot says the most important thing: failing CI, running CI, conflicts, changes.
    const dot = ci?.kind === "failure" ? t.ansi1 : s?.conflicts ? t.ansi1 : ci?.kind === "running" ? t.ansi4 : s?.changed ? t.ansi3 : null;
    const detail = [
      s?.branch ? `${s.branch}${s.upstream ? ` → ${s.upstream}` : ""}` : s?.error ? s.error : "",
      s?.ahead || s?.behind ? `↑${s.ahead} ↓${s.behind}` : "",
      s?.changed ? `${s.changed} changed${s.conflicts ? `, ${s.conflicts} conflicts` : ""}` : s?.branch ? "clean" : "",
      ci ? `CI ${ci.label}${ci.number ? ` #${ci.number}` : ""}` : "",
    ].filter(Boolean).join("\n");
    // Dragging a root drops its path into a terminal, like any row; reordering is the
    // right-click menu's Move Up / Move Down.
    return h_flex()
      .id(`root-${root.path}`).h(ROW + 2).flex_none().pl(4).pr(8).gap(4).items_center()
      .bg(isActive ? t.selected : "#00000000").when(!isActive, (el) => el.hover((st) => st.bg(t.hover)))
      .cursor_pointer().text_size(TEXT.body)
      .tooltip(`${root.path}\n${detail}`)
      .drag_paths([root.path])
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.click_count === 2) this.command({ cmd: "terminal", path: root.path });
      })
      .on_click((_e, cx) => {
        setActive(root, "pick");
        this.toggle(root.path, "", cx);
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu({ kind: "root", root, index, count: this.ws.roots.length }); })
      .child(Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim))
      .child(RootIcon(open, 15))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(isActive ? t.foreground : t.muted).child(root.name))
      .when(Boolean(s?.branch), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(TEXT.caption).text_color(t.dim).child(s.branch)))
      .child(div().w(7).flex_none().h(7).rounded(4).when(Boolean(dot), (el) => el.bg(dot)));
  },

  entryRow(t, root, rel, e, depth, marks) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    const key = `${root.path}\0${path}`;
    const open = e.dir && this.open.has(key);
    const mark = marks?.[path];
    const below = e.dir && !mark && marks && Object.keys(marks).some((p) => p.startsWith(`${path}/`));
    const ignored = !mark && this.isIgnored(root.path, path);
    const color = mark ? markColor(mark, t) : below ? t.ansi3 : ignored ? t.dim : t.foreground;
    const sel = this.selected === key;
    return h_flex()
      .id(`e-${key}`).h(ROW).flex_none().pl(4 + depth * INDENT).pr(8).gap(4).items_center()
      .bg(sel ? t.selected : "#00000000").when(!sel, (el) => el.hover((st) => st.bg(t.hover)))
      .cursor_pointer().text_size(TEXT.body)
      .drag_paths([`${root.path}/${path}`])
      .on_click((_e, cx) => {
        this.selected = key;
        if (e.dir) this.toggle(root.path, path, cx);
        else {
          setActive(root, "pick");
          showInViewer("vx-files", { root: root.path, on: null, rel: path }, e.name);
          cx.notify();
        }
      })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.selected = key; this.openMenu({ kind: "entry", root, rel: path, dir: e.dir }); cx.notify(); })
      .child(e.dir ? Icon(open ? "chevron-down" : "chevron-right", 12).text_color(t.dim) : div().w(12).flex_none())
      .child(FileIcon(this.icons, `${root.path}/${path}`, { dir: e.dir, open, size: 14 }))
      .child(div().flex_1().min_w(0).truncate().text_color(color).child(e.name))
      .when(Boolean(mark), (el) => el.child(div().w(10).flex_none().text_size(TEXT.caption).text_color(color).child(mark)))
      .when(Boolean(below), (el) => el.child(div().size(5).flex_none().rounded(3).bg(t.ansi3)));
  },

  explorerRows(t) {
    const rows = [];
    (this.ws?.roots ?? []).forEach((root, index) => {
      rows.push(this.rootRow(t, root, index));
      if (!this.open.has(`${root.path}\0`)) return;
      const marks = this.marksOf(root);
      const walk = (rel, depth) => {
        const list = this.entries.get(`${root.path}\0${rel}`);
        if (!list) return void rows.push(div().h(ROW).pl(4 + depth * INDENT + 16).text_size(TEXT.caption).text_color(t.dim).child("Loading…"));
        for (const e of list) {
          if (rows.length >= MAX_ROWS) return;
          if (!this.showDots && e.name.startsWith(".")) continue;
          rows.push(this.entryRow(t, root, rel, e, depth, marks));
          const path = rel ? `${rel}/${e.name}` : e.name;
          if (e.dir && this.open.has(`${root.path}\0${path}`)) walk(path, depth + 1);
        }
      };
      walk("", 1);
    });
    if (rows.length >= MAX_ROWS) rows.push(div().px(12).py(4).text_size(TEXT.caption).text_color(t.dim).child("Collapse some folders to see more."));
    return rows;
  },
};
