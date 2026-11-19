// The preview tab: one per space, showing the file last picked in Files. Code is drawn as rows
// with syntax colours and a bar on lines changed since HEAD; Markdown renders (Code toggles it
// back); images show through a copy in this mod's cache (image() loads only from Herdr's folder).
// Edit (✎) swaps the rows for Herdr's code editor; ⌘S saves (vx-files.save), refusing to
// overwrite a file that changed on disk. Editing keeps the tab (it stops being the reused
// preview), and the tab bar shows a dot while there are unsaved changes (shared "vx.dirty").
// A viewer value with { line } (Search, Problems) selects and scrolls to that line.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, TextView, VirtualListScrollHandle, EditorState, Editor } from "gpui-base";
import { theme, readTextFile, writeTextFile, exec, appHome, settings, shared, setShared, notify, props, panes, spaces, run, home } from "herdr";
import { git, bump } from "./ws.js";
import { parseBlame, heat, shortAge, NOT_COMMITTED } from "./blame-core.js";
import { parseLog, LOG_FORMAT } from "./git-core.js";
import { showInViewer } from "./tabs.js";
import { parseHunks } from "./git-core.js";
import { lexLines, languageOf, syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, FileIcon, Message, codeFont, codeSize, tint } from "./ui.js";
import { viewerValue, viewerTab, keptTabs } from "./tabs.js";

const BLAME_W = 230;

const MOD = "vx-files";
const POLL_MS = 2000;
const MAX_LINES = 20000;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|svg|ico)$/i;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
// $1 source, $2 copy: copy only when different, so an unchanged image never reloads.
const COPY = 'mkdir -p -- "$(dirname -- "$2")" && { cmp -s -- "$1" "$2" || cp -- "$1" "$2"; }';

export const previewMethods = {
  initPreview(p, cx) {
    this.viewSpace = p.space;
    // A tab opened directly (herdr-app do tab.new --mod vx-files --props {...}) names its file.
    this.propsFile = p.file?.root && p.file?.rel ? p.file : null;
    // A kept tab (props.fixed) shows its own file and never follows the space's preview.
    this.fixed = Boolean(p.fixed && this.propsFile);
    this.scroller = VirtualListScrollHandle.new();
    this.mdCode = false;
    this.blameOn = p.blame === true || localStorage.getItem("blame") === "1";
    if (Number.isInteger(p.line)) this.selLine = p.line;
    if (p.edit) this.wantEdit = true;
    // Opened by bin/vx-edit (an $EDITOR for Claude's Ctrl+G): it waits for Done or for the tab
    // to close, told through a marker file named by this token.
    if (typeof p.wait === "string" && /^[\w-]{1,64}$/.test(p.wait)) this.waitToken = p.wait;
    if (p.history === "file" || p.history === "line") this.wantHistory = p.history;
    cx.timer.every(POLL_MS, (cx) => this.syncPreview(cx, true));
    this.syncPreview(cx);
  },

  // This copy's tab: the space's reused preview tab, until it's kept (in place: from then on it
  // shows its own file and the next preview opens a new tab).
  followKept() {
    if (this.fixed) return;
    this.myTab ??= viewerTab(MOD, this.viewSpace);
    const kept = this.myTab ? keptTabs()[this.myTab] : null;
    if (kept?.value?.rel) {
      this.fixed = true;
      this.propsFile = kept.value;
    }
  },

  keepTab() {
    if (this.fixed || !this.file) return;
    this.myTab ??= viewerTab(MOD, this.viewSpace);
    if (!this.myTab) return;
    const value = { root: this.file.root, on: this.file.on ?? null, rel: this.file.rel };
    setShared("vx.tabs.kept", { ...keptTabs(), [this.myTab]: { mod: MOD, value } });
    this.fixed = true;
    this.propsFile = value;
  },

  // A tab opened straight onto a fixed file (a Claude plan from a toast) isn't in vx.tabs.kept,
  // so the tab bar and breadcrumbs would describe the space's preview instead. Register it:
  // this pane's tab if props name the pane, else the active tab when it holds a vx-files pane.
  registerFixed() {
    if (this.registered || !this.fixed || !this.propsFile) return;
    const mine = props()?.pane;
    let tab = mine ? panes().find((p) => p.pane === mine)?.tab : null;
    if (!tab) {
      const active = spaces().find((s) => s.id === this.viewSpace)?.tabs?.find((t) => t.active)?.id;
      if (active && panes().some((p) => p.tab === active && p.mod === MOD)) tab = active;
    }
    if (!tab) return;
    this.registered = true;
    this.myTab = tab;
    const kept = keptTabs();
    if (kept[tab]?.value?.rel === this.propsFile.rel && kept[tab]?.value?.root === this.propsFile.root) return;
    setShared("vx.tabs.kept", { ...kept, [tab]: { mod: MOD, value: { root: this.propsFile.root, on: this.propsFile.on ?? null, rel: this.propsFile.rel } } });
  },

  syncPreview(cx, poll = false) {
    this.followKept();
    this.registerFixed();
    // Opened straight onto a file (tab.new with props.file): share it as the space's preview, so
    // the tab bar, breadcrumbs and Timeline see it.
    if (!this.fixed && this.propsFile && !viewerValue(MOD, this.viewSpace) && this.viewSpace)
      setShared(`${MOD}.view`, { ...(shared(`${MOD}.view`) ?? {}), [this.viewSpace]: { ...this.propsFile, at: Date.now() } });
    const v = this.fixed ? this.propsFile : viewerValue(MOD, this.viewSpace) ?? this.propsFile;
    if (!v?.rel) return;
    // A jump to a line (Search, Problems): select it and scroll there once the text is in.
    if (Number.isInteger(v.line) && v.at && v.at !== this.jumpAt && !this.fixed) {
      this.jumpAt = v.at;
      this.jumpLine = v.line;
    }
    // An edit request (Claude Plans' Edit): open the editor once the text is in.
    if (v.edit && v.edit !== this.editAt) {
      this.editAt = v.edit;
      this.wantEdit = true;
    }
    const key = `${v.on ?? ""}|${v.root}/${v.rel}`;
    if (key !== this.fileKey) {
      this.fileKey = key;
      this.file = v;
      this.text = undefined;
      this.problem = null;
      this.lines = null;
      this.hunks = [];
      this.mdCode = false;
      this.selLine = this.firstFileSeen ? null : this.selLine ?? null;
      this.editor = null;
      this.diskChanged = false;
      this.firstFileSeen = true;
      this.blame = null;
      this.heat = null;
      this.blameError = null;
      if (this.history) this.history = this.history.kind === "file" ? { kind: "file", items: null } : null;
    } else if (!poll) return;
    this.readPreview(cx);
  },

  readPreview(cx) {
    const f = this.file;
    if (!f || this.readingPreview) return;
    this.readingPreview = true;
    const abs = `${f.root}/${f.rel}`;
    cx.spawn(async (cx) => {
      try {
        if (IMAGE.test(f.rel)) {
          if (f.on) this.problem = "Images on another machine can't be shown here.";
          else {
            const copy = `mods/${MOD}/cache/${encodeURIComponent(abs).replace(/%/g, "_").slice(-150)}`;
            const r = await exec("sh", ["-c", COPY, "vx-copy", abs, `${appHome()}/${copy}`]);
            this.problem = r.code === 0 ? null : "This file is no longer there.";
            this.imageCopy = r.code === 0 ? copy : null;
          }
          return;
        }
        let text = null;
        try {
          text = await readTextFile(abs, { on: f.on });
        } catch {
          this.problem = "Too large or unreadable to preview.";
          return;
        }
        if (this.jumpLine && text === this.text && this.lines) {
          this.selLine = Math.min(this.jumpLine, this.lines.length);
          this.scroller.scroll_to_item(this.selLine - 1, "center");
          this.jumpLine = null;
        }
        if (text === null) this.problem = "This file is no longer there.";
        else if (text.includes("\0")) this.problem = "Binary file.";
        else if (text !== this.text) {
          // Rewritten on disk while you edit (Claude updating its plan): say so; Save would refuse.
          if (this.editor && this.text !== undefined && text !== this.saved) this.diskChanged = true;
          this.problem = null;
          this.text = text;
          const all = text.replace(/\r/g, "").replace(/\t/g, "    ").split("\n");
          this.lines = all.slice(0, MAX_LINES);
          this.truncated = all.length > MAX_LINES;
          this.runs = this.lines.length <= 6000 ? lexLines(this.lines, languageOf(f.rel)) : null;
          if (this.blameOn) this.loadBlame(cx);
          if (this.history?.kind === "file" && !this.history.items) this.openHistory("file", cx);
          if (this.jumpLine) {
            this.selLine = Math.min(this.jumpLine, this.lines.length);
            this.scroller.scroll_to_item(this.selLine - 1, "center");
            this.jumpLine = null;
          }
          if (this.wantHistory) {
            this.openHistory(this.wantHistory, cx);
            this.wantHistory = null;
          }
        }
        if (this.wantEdit && this.text !== undefined && this.text !== null && !this.editor) {
          this.wantEdit = false;
          this.mdCode = true;
          this.startEdit(cx);
        }
        // Changed lines since HEAD (an untracked file is all new).
        const st = await git(["status", "--porcelain", "--", f.rel], { cwd: f.root, on: f.on }).catch(() => null);
        if (st?.code === 0 && st.stdout.startsWith("??")) this.hunks = [{ newStart: 1, fresh: Infinity, kind: "added" }];
        else if (st?.code === 0 && st.stdout.trim()) {
          const d = await git(["diff", "-U0", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--", f.rel], { cwd: f.root, on: f.on }).catch(() => null);
          this.hunks = d?.code === 0 ? parseHunks(d.stdout) : [];
        } else this.hunks = [];
      } finally {
        this.readingPreview = false;
        cx.notify();
      }
    });
  },

  // ── GitLens: blame, heatmap, file and line history ─────────────────────────────────────
  toggleBlame(cx) {
    this.blameOn = !this.blameOn;
    localStorage.setItem("blame", this.blameOn ? "1" : "0");
    if (this.blameOn) this.loadBlame(cx);
    cx.notify();
  },

  loadBlame(cx) {
    const f = this.file;
    if (!f) return;
    cx.spawn(async (cx) => {
      const r = await git(["blame", "--porcelain", "--", f.rel], { cwd: f.root, on: f.on }).catch(() => null);
      if (this.file !== f) return;
      if (r?.code === 0) {
        this.blame = parseBlame(r.stdout);
        this.heat = heat(this.blame);
        this.blameError = null;
      } else {
        this.blame = null;
        this.blameError = /no such path|not in the working tree|fatal: no such ref/i.test(r?.stderr ?? "") ? "Not committed yet: no blame." : (r?.stderr ?? "").trim() || "No blame here.";
      }
      cx.notify();
    });
  },

  // kind "file": commits that touched this file (following renames); "line": the selected line.
  openHistory(kind, cx) {
    const f = this.file;
    if (!f || (kind === "line" && !this.selLine)) return;
    const line = this.selLine;
    this.history = { kind, line, items: null };
    cx.notify();
    const args = kind === "line"
      ? ["log", "-n", "50", LOG_FORMAT, "--no-patch", `-L${line},${line}:${f.rel}`]
      : ["log", "-n", "100", "--follow", LOG_FORMAT, "--", f.rel];
    cx.spawn(async (cx) => {
      const r = await git(args, { cwd: f.root, on: f.on }).catch(() => null);
      if (!this.history || this.history.kind !== kind || this.history.line !== line) return;
      this.history.items = r?.code === 0 ? parseLog(r.stdout) : [];
      this.history.error = r?.code === 0 ? null : (r?.stderr ?? "").trim() || "git log failed";
      cx.notify();
    });
  },

  heatColor(t, h) {
    if (h === undefined) return null;
    return h >= 0.9 ? t.ansi1 : h >= 0.7 ? t.ansi3 : h >= 0.45 ? t.ansi2 : h >= 0.2 ? t.ansi4 : t.border;
  },

  historyDrawer(t) {
    const h = this.history;
    const f = this.file;
    const pane = v_flex().id("pv-history").w(320).flex_none().h_full().border_l(1).border_color(t.border).bg(t.chrome)
      .child(h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
        .child(Icon("history", 13).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(h.kind === "line" ? `Line ${h.line} history` : "File history"))
        .child(IconButton({ id: "pv-hist-close", icon: "x", label: "Close", size: 20, onClick: (cx) => { this.history = null; cx.notify(); } })));
    const list = v_flex().id("pv-hist-list").flex_1().min_h(0).overflow_y_scrollbar().py(4);
    if (h.error) list.child(Message(h.error, true));
    else if (!h.items) list.child(Message("Loading…"));
    else if (!h.items.length) list.child(Message("No commits."));
    else list.children(h.items.map((c) => v_flex().id(`h-${c.hash}`).flex_none().mx(4).px(8).py(4).gap(1).rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => showInViewer("vx-changes", { root: f.root, on: f.on ?? null, path: f.rel, scope: "commit", sha: c.hash, subject: c.subject }, f.rel.split("/").pop()))
      .child(div().truncate().text_size(TEXT.small).text_color(t.foreground).child(c.subject))
      .child(h_flex().gap(6).text_size(TEXT.caption).text_color(t.dim)
        .child(div().font_family(codeFont()).child(c.short)).child(div().flex_1().truncate().child(c.author)).child(div().child(shortAge(c.at))))));
    return pane.child(list);
  },

  lineMark(n) {
    for (const h of this.hunks ?? []) {
      if (h.kind === "removed") {
        if (n === h.newStart + 1) return "removed";
      } else if (n >= h.newStart && n < h.newStart + h.fresh) return h.kind;
    }
    return null;
  },

  codeRows(t) {
    const C = syntaxColors(t);
    const size = codeSize();
    const height = Math.round(size * 1.55);
    const lines = this.lines ?? [];
    const lang = languageOf(this.file.rel);
    const listId = `pv-${this.fileKey}`;
    const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const blameOn = Boolean(this.blameOn && this.blame);
    const row = (i) => {
      const n = i + 1;
      const mark = this.lineMark(n);
      const bar = mark === "added" ? t.ansi2 : mark === "changed" ? t.ansi3 : mark === "removed" ? t.ansi1 : null;
      const runs = this.runs?.[i] ?? lexLines([lines[i]], lang)[0];
      const b = blameOn ? this.blame?.[i] : null;
      const first = b && (i === 0 || this.blame[i - 1]?.sha !== b.sha);
      const sel = this.selLine === n;
      return h_flex().id(`l${i}`).h(height).w_full().items_center()
        .when(sel, (el) => el.bg(t.selected))
        .when(!sel && (mark === "added" || mark === "changed"), (el) => el.bg(tint(bar, "1c")))
        .when(blameOn, (el) => el
          .child(div().w(4).h_full().flex_none().bg(this.heatColor(t, this.heat?.[i]) ?? t.background))
          .child(div().w(BLAME_W).flex_none().px(8).truncate().text_size(Math.max(10, size - 3)).text_color(sel ? t.muted : t.dim)
            .when(i > 0 && first, (e2) => e2.border_t(1).border_color(t.border))
            .child(first ? (NOT_COMMITTED.test(b.sha) ? "You · Not committed yet" : `${b.author} · ${shortAge(b.time)} · ${b.summary}`) : "")))
        .child(div().w(3).h_full().flex_none().when(Boolean(bar), (el) => el.bg(bar)))
        .child(div().w(size * 3.6).pr(size * 0.9).flex_none().text_right().text_color(t.dim).child(String(n)))
        .child(h_flex().flex_1().min_w(0).whitespace_nowrap()
          .children(runs.map((r) => div().flex_none().whitespace_nowrap().text_color(r.kind ? C[r.kind] : t.foreground).child(r.text || " "))));
    };
    return div().id("pv-code").flex_1().min_w(0).h_full().min_h(0).relative().font_family(codeFont()).text_size(size)
      .child(div().id("pv-x").size_full().overflow_x_scrollbar()
        .child(div().h_full().min_w(Math.max(300, (widest * 0.62 + 6) * size + (blameOn ? BLAME_W + 4 : 0)))
          .child(v_virtual_list(listId, lines.length, height, (i) => `l${i}`, (range) => {
            const out = [];
            for (let i = range.start; i < range.end; i++) out.push(row(i));
            return out;
          }).track_scroll(this.scroller).on_item_click((key, cx) => {
            const n = Number(key.slice(1)) + 1;
            this.selLine = this.selLine === n ? null : n;
            if (this.history?.kind === "line" && this.selLine) this.openHistory("line", cx);
            cx.notify();
          }).size_full())))
      .child(Scrollbar.vertical(listId).viewport_from_layout().absolute().inset_0());
  },

  // ── editing ────────────────────────────────────────────────────────────────────────────
  dirtyKey() {
    return this.file ? `${this.file.root}/${this.file.rel}` : null;
  },

  setDirty(on) {
    const key = this.dirtyKey();
    if (!key) return;
    const all = shared("vx.dirty") ?? {};
    if (Boolean(all[key]) === on) return;
    const next = { ...all };
    if (on) next[key] = true;
    else delete next[key];
    setShared("vx.dirty", next);
  },

  startEdit(cx) {
    if (!this.file || this.file.on || this.text === undefined || this.text === null) return;
    this.keepTab();
    const C = syntaxColors(theme());
    this.editor = EditorState.new({
      language: languageOf(this.file.rel) ?? undefined, value: this.text, font_family: codeFont(), font_size: codeSize(),
      syntax: { keyword: C.keyword, string: C.string, comment: C.comment, function: C.fn, type: C.type, number: C.number, constant: C.constant },
    });
    this.saved = this.text;
    this.editor.on("change", (_e, cx) => { this.setDirty(this.editor.value() !== this.saved); cx.notify(); });
    this.editor.focus();
    cx.notify();
  },

  stopEdit(cx) {
    if (this.editor && this.editor.value() !== this.saved) {
      notify({ title: "Unsaved changes", body: "Save (⌘S) or Revert first.", timeout: 3000 });
      return;
    }
    this.editor?.release();
    this.editor = null;
    this.diskChanged = false;
    this.setDirty(false);
    cx.notify();
  },

  // The file changed on disk under the editor: take the disk version, or keep yours (the next
  // save then overwrites the disk version on purpose).
  loadDisk(cx) {
    if (!this.editor) return;
    this.editor.set_value(this.text);
    this.saved = this.text;
    this.diskChanged = false;
    this.setDirty(false);
    cx.notify();
  },

  keepMine(cx) {
    this.saved = this.text;
    this.diskChanged = false;
    this.setDirty(Boolean(this.editor) && this.editor.value() !== this.saved);
    cx.notify();
  },

  // vx-edit is waiting: save what's unsaved, tell it we're done, close the tab.
  doneWaiting(cx) {
    const f = this.file;
    cx.spawn(async (cx) => {
      if (this.editor && f && this.editor.value() !== this.saved) {
        const text = this.editor.value();
        try {
          await writeTextFile(`${f.root}/${f.rel}`, text, this.saved);
          this.saved = text;
          this.text = text;
          this.setDirty(false);
        } catch (e) {
          notify({ title: "Not saved", body: String(e?.message ?? e), level: "error", timeout: 8000 });
          cx.notify();
          return;
        }
      }
      await this.signalDone();
      if (this.myTab) run("tab.close", { id: this.myTab });
      cx.notify();
    });
  },

  async signalDone() {
    if (!this.waitToken || this.waitDone) return;
    this.waitDone = true;
    await exec("sh", ["-c", 'mkdir -p "$1" && : > "$1/$2.done"', "vx-edit", `${home()}/.local/state/vx-edit`, this.waitToken]).catch(() => {});
  },

  revert(cx) {
    if (!this.editor) return;
    this.editor.set_value(this.saved);
    this.setDirty(false);
    cx.notify();
  },

  save(cx) {
    const f = this.file;
    if (!this.editor || !f) return;
    const text = this.editor.value();
    if (text === this.saved) return;
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(`${f.root}/${f.rel}`, text, this.saved);
        this.saved = text;
        this.text = text;
        this.diskChanged = false;
        this.setDirty(false);
        bump(f.root);
        notify({ title: `Saved ${f.rel.split("/").pop()}`, level: "success", timeout: 1500 });
      } catch (e) {
        notify({ title: "Not saved", body: /stale|changed|expected/i.test(String(e)) ? "The file changed on disk since you opened it. Revert to load it, then edit again." : String(e?.message ?? e), level: "error", timeout: 8000 });
      }
      cx.notify();
    });
  },

  renderPreview() {
    const t = theme();
    const f = this.file;
    const root = v_flex().id("vx-preview").size_full().min_w(0).min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(TEXT.body);
    if (!f) return root.child(Message("Pick a file in Files to preview it here."));
    const md = MARKDOWN.test(f.rel);
    const abs = `${f.root}/${f.rel}`;
    const dir = f.rel.includes("/") ? f.rel.slice(0, f.rel.lastIndexOf("/")) : "";
    root.child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(FileIcon(this.icons, abs, { size: 14 }))
      .child(div().flex_none().max_w(320).truncate().font_medium().child(f.rel.split("/").pop()))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(dir))
      .when(md, (el) => el
        .child(IconButton({ id: "pv-md", icon: "eye", label: "Rendered", active: !this.mdCode, onClick: (cx) => { this.mdCode = false; cx.notify(); }, size: 22 }))
        .child(IconButton({ id: "pv-code", icon: "file", label: "Code", active: this.mdCode, onClick: (cx) => { this.mdCode = true; cx.notify(); }, size: 22 })))
      .when(!md || this.mdCode, (el) => el
        .when(Boolean(this.selLine), (e2) => e2.child(div().text_size(TEXT.caption).text_color(t.dim).child(`line ${this.selLine}`)))
        .child(IconButton({ id: "pv-blame", icon: "blame", label: this.blameOn ? "Hide blame" : "Blame (author · age per line, heatmap)", active: Boolean(this.blameOn), onClick: (cx) => this.toggleBlame(cx), size: 22 }))
        .child(IconButton({ id: "pv-hist", icon: "history", label: "File history", active: this.history?.kind === "file", onClick: (cx) => (this.history?.kind === "file" ? ((this.history = null), cx.notify()) : this.openHistory("file", cx)), size: 22 }))
        .child(IconButton({ id: "pv-lhist", icon: "line-history", label: this.selLine ? `History of line ${this.selLine}` : "Click a line, then show its history", disabled: !this.selLine, active: this.history?.kind === "line", onClick: (cx) => this.openHistory("line", cx), size: 22 })))
      .when(!f.on && !IMAGE.test(f.rel) && this.text !== undefined, (el) => el
        .when(Boolean(this.editor) && this.editor?.value() !== this.saved, (e2) => e2
          .child(div().id("pv-revert").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).text_color(t.muted).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.revert(cx)).child("Revert"))
          .child(div().id("pv-save").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground).on_click((_e, cx) => this.save(cx)).child("Save ⌘S")))
        .child(IconButton({ id: "pv-edit", icon: "pencil", label: this.editor ? "Stop editing" : "Edit this file", active: Boolean(this.editor), onClick: (cx) => { if (this.editor) this.stopEdit(cx); else { this.mdCode = true; this.startEdit(cx); } }, size: 22 })))
      .when(!f.on, (el) => el.child(IconButton({ id: "pv-open", icon: "external", label: "Open in default app", onClick: () => exec("open", ["--", abs]).catch(() => {}), size: 22 }))));
    if (this.blameOn && this.blameError && !md) root.child(div().px(10).py(4).text_size(TEXT.caption).text_color(t.dim).child(this.blameError));
    // The selected line's full blame, like GitLens' current-line annotation.
    const sb = this.blameOn && this.selLine ? this.blame?.[this.selLine - 1] : null;
    if (sb) root.child(h_flex().h(24).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome).text_size(TEXT.caption).text_color(t.muted)
      .child(Icon("git-commit", 11).text_color(t.accent))
      .child(div().font_family(codeFont()).child(NOT_COMMITTED.test(sb.sha) ? "uncommitted" : sb.sha.slice(0, 8)))
      .child(div().child(NOT_COMMITTED.test(sb.sha) ? "You" : sb.author))
      .child(div().child(sb.time ? new Date(sb.time * 1000).toISOString().slice(0, 10) : ""))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(NOT_COMMITTED.test(sb.sha) ? "Not committed yet" : sb.summary))
      .when(!NOT_COMMITTED.test(sb.sha), (el) => el.child(h_flex().id("pv-sb-open").px(6).h(18).items_center().rounded(4).cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
        .on_click(() => showInViewer("vx-changes", { root: f.root, on: f.on ?? null, path: f.rel, scope: "commit", sha: sb.sha, subject: sb.summary }, f.rel.split("/").pop()))
        .child("open commit diff"))));
    if (this.waitToken && !this.waitDone) root.child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(tint(t.accent)).text_size(TEXT.small)
      .child(Icon("sparkles", 13).text_color(t.accent))
      .child(div().flex_1().min_w(0).truncate().child("Waiting for you: edit this file, then click Done to hand it back."))
      .child(div().id("pv-wait-done").px(10).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground).on_click((_e, cx) => this.doneWaiting(cx)).child("Done")));
    if (this.editor && this.diskChanged) root.child(h_flex().h(30).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).bg(tint(t.ansi3)).text_size(TEXT.small)
      .child(Icon("alert", 13).text_color(t.ansi3))
      .child(div().flex_1().min_w(0).truncate().child("This file changed on disk while you were editing."))
      .child(div().id("pv-disk-load").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? t.accent_foreground).on_click((_e, cx) => this.loadDisk(cx)).child("Load disk version"))
      .child(div().id("pv-disk-keep").px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).text_color(t.muted).hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.keepMine(cx)).child("Keep mine")));
    if (this.problem) return root.child(Message(this.problem));
    if (IMAGE.test(f.rel))
      return root.child(this.imageCopy ? h_flex().flex_1().min_h(0).p(16).justify_center().items_center().child(image(this.imageCopy).max_w_full().max_h_full()) : Message("Loading…"));
    if (this.text === undefined) return root.child(Message("Loading…"));
    if (md && !this.mdCode)
      return root.child(div().id("pv-md-body").flex_1().min_h(0).overflow_y_scrollbar().px(28).py(18)
        .child(TextView.markdown(`md-${this.fileKey}`, this.text).w_full().text_size(TEXT.title).selectable(true).scrollable(false)));
    if (this.editor) {
      return root.child(div().id("pv-editor").flex_1().min_h(0).font_family(codeFont())
        .on_key_down((e, cx) => { if (e.key === "s" && e.modifiers?.platform) { cx.stop_propagation(); this.save(cx); } })
        .child(Editor.new(this.editor).size_full()));
    }
    root.child(h_flex().flex_1().min_h(0).child(this.codeRows(t)).when(Boolean(this.history), (el) => el.child(this.historyDrawer(t))));
    if (this.truncated) root.child(Message(`Showing the first ${MAX_LINES.toLocaleString()} lines.`));
    return root;
  },
};
