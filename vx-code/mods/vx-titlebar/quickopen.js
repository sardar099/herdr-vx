// Quick Open (⌘P), VS Code's: a popup over the command center. One box, modes by prefix:
//   (none)   files of every workspace root, fuzzy, matched letters highlighted; "recently opened"
//            first, then "file results". `name:42` opens at line 42.
//   :        go to a line of the file in the active tab        @   go to a symbol in it
//   >        Herdr's and vx's commands with their keys          %   search text in every root
//   ~        Claude Code's plans (~/.claude/plans), by title; they also join file results
//   ?        what the prefixes do
// ↑↓ (wrapping), PageUp / PageDown, Enter opens, ⌘Enter opens to the side, Esc closes. The
// selected row offers Open to the Side and, for a recent file, Remove from Recently Opened.
// Speed: rows are worked out when the query or the data changes (never while drawing), files are
// ranked in slices between frames, and only the 18 visible rows are drawn: a window this view
// scrolls itself (a virtual list's rows can't carry click / hover handlers, which these need).
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState } from "gpui-base";
import { theme, run, closeOverlay, props, shared, setShared, spaces, readTextFile, commands, keys, window, exec, home } from "herdr";
import { workspace, git, baseName, ctx, rootFor } from "./ws.js";
import { showInViewer } from "./tabs.js";
import { describeTab } from "./kinds.js";
import { rankFiles, matchPath, runsOf, parseQuery, symbolsOf, commandLabel, keyLabel, actionToRun, prepareFiles, scoreSlice, topFiles, queryWords } from "./quickopen-core.js";
import { grepArgs, parseGrep, matchSnippet } from "./search-core.js";
import { LIST_PLANS, parsePlanList, planTitle } from "./plans-core.js";
import { timeAgo } from "./git-core.js";
import { TEXT, Icon, FileIcon, tint } from "./ui.js";

export const QO_ROW = 24;
export const QO_ROWS = 18;
export const QO_HEAD = 38;
const RECENT_KEY = "vx.goto.recent";
const CMD_RECENT_KEY = "vx.cmd.recent";
const PLACEHOLDER = "Search files by name (append : to go to line or @ to go to symbol)";

// vx's own commands (mods' commands aren't in commands()).
const VX_COMMANDS = [
  ["vx-titlebar.goto", "Go to File…"],
  ["vx-activity.explorer", "View: Show Explorer"],
  ["vx-activity.search", "View: Show Search"],
  ["vx-activity.scm", "View: Show Source Control"],
  ["vx-activity.ci", "View: Show CI / CD"],
  ["vx-activity.docker", "View: Show Docker"],
  ["vx-docker.refresh", "Docker: Refresh"],
  ["vx-activity.http", "View: Show HTTP Client"],
  ["vx-http.new", "HTTP: New Request"],
  ["vx-http.import", "HTTP: Import cURL or Postman…"],
  ["vx-http.send", "HTTP: Send Request"],
  ["vx-activity.devtools", "Dev Tools: Open"],
  ["mod.open:vx-devtools", "Dev Tools: Quick Tool… (paste anything)"],
  ["vx-titlebar.chat", "Claude: Toggle Chat"],
  ["vx-chat.new", "Claude: New Chat"],
  ["vx-chat.scope", "Claude: Choose Folder (repo, whole workspace…)"],
  ["vx-chat.model", "Claude: Choose Model…"],
  ["vx-chat.effort", "Claude: Choose Effort…"],
  ["vx-chat.mode", "Claude: Choose Permission Mode…"],
  ["vx-activity.spaces", "View: Show Spaces"],
  ["vx-activity.agents", "View: Show Agents"],
  ["vx-activity.panel", "View: Toggle Panel"],
  ["vx-activity.problems", "View: Show Problems"],
  ["vx-activity.terminal", "View: Show Terminal"],
  ["vx-activity.ports", "View: Show Ports"],
  ["vx-activity.newterm", "Terminal: Create New Terminal in the Panel"],
  ["vx-activity.checks", "Problems: Run Checks (typecheck + lint)"],
  ["vx-tabs.switch", "View: Quick Open Previous Tab"],
  ["vx-tabs.list", "View: Show All Tabs"],
  ["vx-files.edit", "File: Edit / Stop Editing"],
  ["vx-files.save", "File: Save"],
  ["vx-titlebar.symbols", "Go to Symbol in Editor…"],
  ["vx-titlebar.line", "Go to Line…"],
  ["vx-titlebar.plans", "Claude: Open Plan…"],
  ["vx-titlebar.back", "Go Back"],
  ["vx-titlebar.forward", "Go Forward"],
];
const HELP = [
  ["", "Go to File"],
  [":", "Go to Line"],
  ["@", "Go to Symbol in Editor"],
  [">", "Show and Run Commands"],
  ["%", "Search for Text"],
  ["~", "Open a Claude Plan"],
];
const SYMBOL_LOOK = {
  class: ["◆", "ansi3"], interface: ["◇", "ansi4"], enum: ["E", "ansi3"], type: ["T", "ansi4"],
  function: ["ƒ", "ansi5"], method: ["ƒ", "ansi5"], variable: ["x", "ansi6"], heading: ["#", "muted"],
};

const sameFile = (a, b) => a.root.path === b.root.path && a.rel === b.rel;
const SLICE = 2500;

export const quickMethods = {
  initQuick(p, cx) {
    this.quick = true;
    this.files = null;
    this.cursor = 0;
    this.hovered = null;
    this.focusHandle = cx.focus_handle();
    this.top = 0;
    this.wheel = 0;
    this.textGen = 0;
    this.rankGen = 0;
    this.prepared = null;
    this.fileHits = null;
    this.rowsCache = [];
    this.query = InputState.new({ placeholder: PLACEHOLDER });
    const start = p.goto?.query ?? "";
    if (start) {
      this.query.set_value(start);
      this.query.set_selected_range({ start: start.length, end: start.length });
    }
    this.query.on("change", (_e, cx) => this.changed(cx));
    this.query.on("submit", (e, cx) => this.choose(this.cursor, cx, Boolean(e?.secondary)));
    this.query.focus();
    this.current = this.currentFile();
    this.loadFiles(cx);
    this.loadPlans(cx);
    this.changed(cx);
  },

  // Claude Code's plans, titled by their first heading.
  loadPlans(cx) {
    const dir = `${home()}/.claude/plans`;
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", LIST_PLANS, "vx-plans", dir]).catch(() => null);
      const list = r?.code === 0 ? parsePlanList(r.stdout) : [];
      for (const p of list) p.title = planTitle(await readTextFile(`${dir}/${p.name}`).catch(() => null), p.name);
      this.plans = { dir, list };
      this.changed(cx, true);
    });
  },

  roots() {
    const ws = workspace()?.roots ?? [];
    if (ws.length) return ws;
    const c = ctx();
    return c.cwd ? [{ name: baseName(c.cwd), path: c.cwd }] : [];
  },

  loadFiles(cx) {
    const roots = this.roots();
    cx.spawn(async (cx) => {
      const lists = await Promise.all(roots.map(async (root) => {
        const out = await git(["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root.path }).catch(() => null);
        return out?.code === 0 ? out.stdout.split("\0").filter(Boolean).map((rel) => ({ root, rel })) : [];
      }));
      this.files = lists.flat();
      this.prepared = prepareFiles(this.files);
      this.changed(cx, true);
    });
  },

  // The file in the active tab (a preview or a diff), for : and @.
  currentFile() {
    const space = spaces().find((s) => s.active);
    const tab = space?.tabs?.find((t) => t.active);
    if (!tab) return null;
    const d = describeTab(tab, space.id);
    const rel = d.value?.rel ?? d.value?.path;
    if ((d.kind !== "preview" && d.kind !== "diff") || !d.value?.root || !rel) return null;
    const root = rootFor(d.value.root, workspace()?.roots) ?? { name: baseName(d.value.root), path: d.value.root };
    return { root, rel, on: d.value.on ?? null };
  },

  // The query or the data changed: work the rows out again (files are ranked in slices).
  changed(cx, keepCursor = false) {
    if (!keepCursor) this.cursor = 0;
    const q = parseQuery(this.query.value());
    if ((q.mode === "symbols" || q.mode === "line") && this.current && this.currentText === undefined) {
      this.currentText = null;
      const f = this.current;
      cx.spawn(async (cx) => {
        this.currentText = (await readTextFile(`${f.root.path}/${f.rel}`, { on: f.on }).catch(() => null)) ?? "";
        this.refresh(cx);
      });
    }
    if (q.mode === "text") this.searchText(q.text, cx);
    if (q.mode === "files" && q.text && this.prepared) this.rankAsync(q.text, cx);
    this.refresh(cx);
  },

  refresh(cx) {
    this.rowsCache = this.rows();
    this.cursor = Math.min(this.cursor, Math.max(0, this.rowsCache.length - 1));
    this.reveal();
    cx.notify();
  },

  // Keep the selected row inside the drawn window.
  reveal() {
    const n = this.rowsCache.length;
    if (this.cursor < this.top) this.top = this.cursor;
    if (this.cursor >= this.top + QO_ROWS) this.top = this.cursor - QO_ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, n - QO_ROWS)));
  },

  scrollBy(e, cx) {
    const n = this.rowsCache.length;
    if (n <= QO_ROWS) return;
    this.wheel += e.delta_lines ? e.delta_lines.y * QO_ROW : e.delta?.y ?? 0;
    let moved = false;
    while (Math.abs(this.wheel) >= QO_ROW) {
      this.top -= Math.sign(this.wheel);
      this.wheel -= Math.sign(this.wheel) * QO_ROW;
      moved = true;
    }
    this.top = Math.max(0, Math.min(this.top, n - QO_ROWS));
    if (moved) cx.notify();
  },

  rankAsync(text, cx) {
    const gen = ++this.rankGen;
    const prepared = this.prepared;
    const words = queryWords(text);
    const scored = [];
    const step = (from, cx) => {
      if (gen !== this.rankGen) return;
      const to = Math.min(from + SLICE, prepared.length);
      scoreSlice(prepared, words, from, to, scored);
      if (to < prepared.length) return void cx.timer.after(0, (cx) => step(to, cx));
      this.fileHits = { text, list: topFiles(prepared, scored, text, 200) };
      this.refresh(cx);
    };
    step(0, cx);
  },

  searchText(text, cx) {
    const gen = ++this.textGen;
    if (!text) {
      this.textHits = [];
      return;
    }
    this.textHits = null;
    cx.timer.after(250, (cx) => {
      if (gen !== this.textGen) return;
      cx.spawn(async (cx) => {
        const args = grepArgs(text, {});
        const groups = await Promise.all(this.roots().map(async (root) => {
          const r = await git(args, { cwd: root.path, timeout: 15000 }).catch(() => null);
          return { root, ...parseGrep(r?.code === 0 ? r.stdout : "", { maxMatches: 200 }) };
        }));
        if (gen !== this.textGen) return;
        this.textHits = groups.flatMap((g) => g.files.flatMap((f) => f.matches.map((m) => ({ root: g.root, rel: f.rel, ...m })))).slice(0, 200);
        this.refresh(cx);
      });
    });
  },

  recentFiles() {
    const live = new Set(this.roots().map((r) => r.path));
    return (shared(RECENT_KEY) ?? []).filter((r) => r?.root?.path && r.rel && (live.size === 0 || live.has(r.root.path)))
      .map((r) => ({ root: rootFor(r.root.path, workspace()?.roots) ?? r.root, rel: r.rel }));
  },

  // The rows for the current query: { kind, group?, label runs, description runs, icon, … }.
  rows() {
    const q = parseQuery(this.query.value());
    const t = theme();
    const multi = this.roots().length > 1;
    const fileRow = (it, group, at = []) => {
      const name = baseName(it.rel);
      const cut = it.rel.length - name.length;
      const dir = cut > 0 ? it.rel.slice(0, cut - 1) : "";
      return {
        kind: "file", key: `f:${it.root.path}:${it.rel}`, file: it, group, line: q.line ?? null,
        icon: { file: it.rel }, label: runsOf(name, at, cut),
        desc: [...(multi ? [{ text: it.root.name, hit: false }] : []), ...(multi && dir ? [{ text: " • ", hit: false }] : []), ...runsOf(dir, at, 0)],
      };
    };
    if (q.mode === "help") {
      return HELP.map(([prefix, what]) => ({ kind: "help", key: `h:${prefix}`, prefix, icon: { glyph: prefix || "…", color: "accent" }, label: [{ text: what, hit: false }], desc: [] }));
    }
    if (q.mode === "plans" || q.mode === "files") {
      const pl = this.plans;
      const planRow = ({ p, m }, i, group) => ({
        kind: "file", key: `p:${p.name}`, file: { root: { name: "Claude plans", path: pl.dir }, rel: p.name }, title: p.title, group: i === 0 ? group : null,
        icon: { file: p.name }, label: runsOf(p.title, m?.at ?? []), desc: [{ text: p.name, hit: false }], right: timeAgo(p.at),
      });
      if (q.mode === "plans") {
        if (!pl) return [{ kind: "note", key: "n", label: [{ text: "Reading plans…", hit: false }], desc: [] }];
        const hits = q.text ? pl.list.map((p) => ({ p, m: matchPath(p.title, q.text) ?? (matchPath(p.name, q.text) ? { at: [] } : null) })).filter((x) => x.m) : pl.list.map((p) => ({ p, m: null }));
        if (!hits.length) return [{ kind: "note", key: "n", label: [{ text: pl.list.length ? "No matching plans." : "No plans yet. Claude writes one in plan mode.", hit: false }], desc: [] }];
        return hits.map((h, i) => planRow(h, i, `claude plans (${hits.length})`));
      }
      this.planHits = q.text && pl ? pl.list.map((p) => ({ p, m: matchPath(p.title, q.text) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).slice(0, 5).map((h, i) => planRow(h, i, "claude plans")) : [];
    }
    if (q.mode === "commands") {
      const list = commands() ?? [];
      const bound = keys() ?? [];
      const keyFor = (action) => bound.find((k) => k.action === action && (k.section === "layout:vx-code" || k.section === "global"))?.keys ?? null;
      const items = new Map();
      for (const [action, label] of VX_COMMANDS) items.set(action, { action, label });
      for (const c of list) if (!c.args.some((a) => a.required)) items.set(c.name, { action: c.name, label: commandLabel(c.name), about: c.about });
      for (const k of bound) if (k.action.includes(":") && !items.has(k.action) && actionToRun(k.action, list)) items.set(k.action, { action: k.action, label: commandLabel(k.action) });
      const recent = (shared(CMD_RECENT_KEY) ?? []).filter((a) => items.has(a));
      const all = [...items.values()];
      const scored = q.text
        ? all.map((c) => ({ c, m: matchPath(c.label, q.text) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score)
        : [...recent.map((a) => items.get(a)).filter(Boolean).map((c) => ({ c, m: null })), ...all.filter((c) => !recent.includes(c.action)).sort((a, b) => a.label.localeCompare(b.label)).map((c) => ({ c, m: null }))];
      return scored.slice(0, 300).map(({ c, m }, i) => ({
        kind: "command", key: `c:${c.action}`, action: c.action,
        group: q.text || !recent.length ? null : i === 0 ? "recently used" : i === recent.length ? "other commands" : null,
        label: runsOf(c.label, m?.at ?? []), desc: [], tip: c.about, keys: keyFor(c.action),
      }));
    }
    if (q.mode === "line") {
      const f = this.current;
      if (!f) return [{ kind: "note", key: "n", label: [{ text: "Open a file in the editor first, then go to a line.", hit: false }], desc: [] }];
      const n = this.currentText ? this.currentText.split("\n").length : null;
      if (!q.line) return [{ kind: "note", key: "n", label: [{ text: `Type a line number${n ? ` between 1 and ${n}` : ""} to navigate to.`, hit: false }], desc: [{ text: f.rel, hit: false }] }];
      const line = n ? Math.min(q.line, n) : q.line;
      return [{ kind: "line", key: "l", file: f, line, icon: { ui: "arrow-down" }, label: [{ text: `Go to line ${line}${q.col ? `, character ${q.col}` : ""}.`, hit: false }], desc: [{ text: baseName(f.rel), hit: false }] }];
    }
    if (q.mode === "symbols") {
      const f = this.current;
      if (!f) return [{ kind: "note", key: "n", label: [{ text: "Open a file in the editor first, then go to a symbol.", hit: false }], desc: [] }];
      if (this.currentText === null || this.currentText === undefined) return [{ kind: "note", key: "n", label: [{ text: "Reading symbols…", hit: false }], desc: [] }];
      const syms = symbolsOf(this.currentText);
      const hits = q.text ? syms.map((s) => ({ s, m: matchPath(s.name, q.text) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score) : syms.map((s) => ({ s, m: null }));
      if (!hits.length) return [{ kind: "note", key: "n", label: [{ text: syms.length ? "No matching symbols." : "No symbols found in this file.", hit: false }], desc: [] }];
      return hits.map(({ s, m }, i) => {
        const [glyph, color] = SYMBOL_LOOK[s.kind] ?? ["•", "muted"];
        return { kind: "line", key: `s:${s.line}:${s.name}`, file: f, line: s.line, group: i === 0 ? `symbols (${hits.length})` : null,
          icon: { glyph, color },
          label: runsOf(s.name, m?.at ?? []), desc: [{ text: s.kind, hit: false }], right: `Ln ${s.line}` };
      });
    }
    if (q.mode === "text") {
      if (!q.text) return [{ kind: "note", key: "n", label: [{ text: "Type to search for text in every repo of the workspace.", hit: false }], desc: [] }];
      if (!this.textHits) return [{ kind: "note", key: "n", label: [{ text: "Searching…", hit: false }], desc: [] }];
      if (!this.textHits.length) return [{ kind: "note", key: "n", label: [{ text: "No results found.", hit: false }], desc: [] }];
      return this.textHits.map((h, i) => {
        const sn = matchSnippet(h.text, h.col, q.text.length, { before: 20, width: 90 });
        return { kind: "file", key: `t:${h.root.path}:${h.rel}:${h.line}:${h.col}`, file: { root: h.root, rel: h.rel }, line: h.line,
          group: i === 0 ? "text results" : null, icon: { file: h.rel },
          label: [{ text: sn.head, hit: false }, { text: sn.hit, hit: true }, { text: sn.tail, hit: false }],
          desc: [{ text: `${multi ? `${h.root.name} • ` : ""}${h.rel}:${h.line}`, hit: false }] };
      });
    }
    // Files.
    const recent = this.recentFiles();
    if (!q.text) {
      if (!recent.length) return [{ kind: "note", key: "n", label: [{ text: "No recently opened files. Type to search every repo, or ? for help.", hit: false }], desc: [] }];
      return recent.slice(0, 50).map((it, i) => ({ ...fileRow(it, i === 0 ? "recently opened" : null), recent: true }));
    }
    const recentHits = rankFiles(recent, q.text, 20);
    // The last finished ranking (the one for an older query stays up until the new one lands).
    const all = (this.fileHits?.list ?? []).filter((it) => !recentHits.some((r) => sameFile(r, it)));
    const out = [
      ...recentHits.map((it, i) => ({ ...fileRow(it, i === 0 ? "recently opened" : null, it.at), recent: true })),
      ...all.map((it, i) => fileRow(it, i === 0 ? "file results" : null, it.at)),
      ...(this.planHits ?? []),
    ];
    const ranking = !this.prepared || this.fileHits?.text !== q.text;
    if (!out.length) return [{ kind: "note", key: "n", label: [{ text: ranking ? "Searching…" : "No matching results", hit: false }], desc: [] }];
    return out;
  },

  close() {
    closeOverlay(props()?.overlay);
  },

  remember(file) {
    const rest = (shared(RECENT_KEY) ?? []).filter((r) => !(r?.root?.path === file.root.path && r.rel === file.rel));
    setShared(RECENT_KEY, [{ root: { name: file.root.name, path: file.root.path }, rel: file.rel }, ...rest].slice(0, 50));
  },

  forget(file, cx) {
    setShared(RECENT_KEY, (shared(RECENT_KEY) ?? []).filter((r) => !(r?.root?.path === file.root.path && r.rel === file.rel)));
    this.refresh(cx);
  },

  openFile(file, line, side, title) {
    this.remember(file);
    const value = { root: file.root.path, on: file.on ?? null, rel: file.rel, ...(line ? { line } : {}) };
    if (side) {
      const space = spaces().find((s) => s.active);
      run("pane.split", { direction: "right", mod: "vx-files", props: { mode: "view", space: space?.id, fixed: true, file: { root: value.root, on: value.on, rel: value.rel }, ...(line ? { line } : {}) } });
    } else showInViewer("vx-files", value, title ?? baseName(file.rel));
  },

  choose(i, cx, side = false) {
    const rows = this.rowsCache;
    const row = rows[Math.min(i, rows.length - 1)];
    if (!row || row.kind === "note") return;
    if (row.kind === "help") {
      this.query.set_value(row.prefix);
      this.query.set_selected_range({ start: row.prefix.length, end: row.prefix.length });
      this.changed(cx);
      return;
    }
    this.close();
    if (row.kind === "file" || row.kind === "line") return this.openFile(row.file, row.line, side, row.title);
    if (row.kind === "command") {
      setShared(CMD_RECENT_KEY, [row.action, ...(shared(CMD_RECENT_KEY) ?? []).filter((a) => a !== row.action)].slice(0, 12));
      const r = actionToRun(row.action, commands() ?? []);
      if (r) run(r.name, r.args);
    }
  },

  move(to, count, cx) {
    if (!count) return;
    this.cursor = ((to % count) + count) % count;
    this.reveal();
    cx.notify();
  },

  // Rows are cached, and elements are single-use: rows keep a description, drawing makes the element.
  iconEl(t, icon) {
    if (icon.file) return FileIcon(this.icons, icon.file, { size: 16 });
    if (icon.ui) return Icon(icon.ui, 14).text_color(t.dim);
    return div().text_color(t[icon.color] ?? t.muted).font_medium().child(icon.glyph);
  },

  drawRow(t, row, i, cur, mac) {
    const runsEl = (runs, base, size) => h_flex().flex_none().min_w(0).overflow_hidden().whitespace_nowrap().text_size(size)
      .children(runs.filter((r) => r.text).map((r) => div().flex_none().whitespace_nowrap().text_color(r.hit ? t.accent : base).when(r.hit, (el) => el.font_semibold()).child(r.text)));
    const sel = i === cur && row.kind !== "note";
    const showActions = (sel || this.hovered === row.key) && (row.kind === "file" || row.kind === "line");
    const action = (id, icon, tip, fn) => div().id(`qa-${id}-${i}`).size(18).flex_none().flex().items_center().justify_center().rounded(3)
      .text_color(t.foreground).hover((s) => s.bg(tint(t.foreground, "22"))).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); fn(cx); }).child(Icon(icon, 13));
    return h_flex().id(`qo-${row.key}`).h(QO_ROW).w_full().px(5)
      .child(h_flex().id(`qi-${row.key}`).size_full().pl(6).pr(4).gap(6).items_center().rounded(4)
        .when(Boolean(row.group) && i > 0, (el) => el.border_t(1).border_color(t.border))
        .when(sel, (el) => el.bg(t.selected))
        .when(!sel && row.kind !== "note", (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
        .when(Boolean(row.tip), (el) => el.tooltip(row.tip))
        .on_hover((h, cx) => {
          const next = h ? row.key : this.hovered === row.key ? null : this.hovered;
          if (next !== this.hovered) {
            this.hovered = next;
            cx.notify();
          }
        })
        .on_click((e, cx) => this.choose(i, cx, Boolean(e?.modifiers?.platform || e?.modifiers?.control)))
        .when(Boolean(row.icon), (el) => el.child(div().w(16).flex_none().flex().items_center().justify_center().child(this.iconEl(t, row.icon))))
        .child(runsEl(row.label, row.kind === "note" ? t.muted : t.foreground, 13))
        .child(h_flex().flex_1().min_w(0).overflow_hidden().child(runsEl(row.desc, t.dim, 12)))
        .when(Boolean(row.right), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(row.right)))
        .when(Boolean(row.keys), (el) => el.child(div().flex_none().px(5).h(18).flex().items_center().rounded(3).border_1().border_color(t.border).bg(t.raised).text_size(11).text_color(t.muted).child(keyLabel(row.keys, mac))))
        .when(Boolean(row.group), (el) => el.child(div().flex_none().text_size(12).text_color(t.dim).child(row.group)))
        .when(showActions, (el) => el
          .child(action("side", "split", "Open to the Side (⌘Enter)", () => { this.close(); this.openFile(row.file, row.line, true); }))
          .when(Boolean(row.recent), (e2) => e2.child(action("forget", "x", "Remove from Recently Opened", (cx) => this.forget(row.file, cx))))));
  },

  renderQuick() {
    const t = theme();
    const rows = this.rowsCache;
    const cur = Math.min(this.cursor, Math.max(0, rows.length - 1));
    const mac = window()?.platform === "macos";
    const shown = Math.max(1, Math.min(rows.length, QO_ROWS));
    const listH = shown * QO_ROW;
    const top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - QO_ROWS)));
    return v_flex().id("vx-quick").w_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .track_focus(this.focusHandle)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "down") { cx.stop_propagation(); this.move(cur + 1, rows.length, cx); }
        else if (k === "up") { cx.stop_propagation(); this.move(cur - 1, rows.length, cx); }
        else if (k === "pagedown") { cx.stop_propagation(); this.move(Math.min(rows.length - 1, cur + QO_ROWS - 1), rows.length, cx); }
        else if (k === "pageup") { cx.stop_propagation(); this.move(Math.max(0, cur - QO_ROWS + 1), rows.length, cx); }
        else if (k === "escape") { cx.stop_propagation(); this.close(); }
      })
      .child(div().flex_none().p(6)
        .child(h_flex().h(26).px(6).items_center().rounded(4).border_1().border_color(t.accent).bg(t.canvas ?? t.background)
          .child(Input.new(this.query).flex_1().h(24).text_size(13))))
      .child(v_flex().id("qo-rows").flex_none().w_full().h(listH).mb(6).relative().overflow_hidden()
        .on_scroll_wheel((e, cx) => this.scrollBy(e, cx))
        .children(rows.slice(top, top + QO_ROWS).map((row, k) => this.drawRow(t, row, top + k, cur, mac)))
        .when(rows.length > QO_ROWS, (el) => el.child(div().absolute().right(1).w(6).rounded(3).bg(tint(t.foreground, "30"))
          .top(Math.round((top / rows.length) * listH)).h(Math.max(18, Math.round((QO_ROWS / rows.length) * listH))))));
  },
};
