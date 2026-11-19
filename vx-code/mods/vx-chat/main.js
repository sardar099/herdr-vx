// vx-chat: Claude in a side panel, like VS Code's Claude Code extension (vx-code's right side
// bar; the ✨ button right of the title bar's search box, or ⌘⌥I).
//   panel    props {}            the chat: messages streaming in, tool cards, the composer
//   history  props { history }   your saved sessions for this folder (popup)
//   pick     props { pick }      the model / mode lists (popup)
// The engine (engine.js) runs `claude -p` per turn; the stream is parsed by shared/chat-core.js.
// Permissions are a mode per chat (Ask / Auto-edit / Plan): what -p can't ask about is refused,
// and the chat offers Allow & retry or the same session in Claude Code's terminal.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState, TextView, ScrollHandle } from "gpui-base";
import { theme, props, exec, home, nextCommand, checking, openOverlay, closeOverlay, shared, setShared, notify, pickFolder } from "herdr";
import { modelLabel, EFFORTS, MODELS, MODES, projectDir, LIST_SESSIONS, parseSessionList, toolSummary, TOOL_ICON, editDiff, editedFile, formatCost, formatDuration } from "./chat-core.js";
import { engineMethods } from "./engine.js";
import { showInViewer } from "./tabs.js";
import { baseName, workspace } from "./ws.js";
import { timeAgo } from "./git-core.js";
import { TEXT, Icon, IconButton, Button, Message, codeFont } from "./ui.js";

const MOD = "vx-chat";
const GUTTER = 12; // every message row starts 12px in
const CMD = "vx.chat.cmd";
const post = (cmd) => setShared(CMD, { ...cmd, n: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}` });

class VxChat extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.history) return this.initHistory(p, cx);
    if (p.pick) return void (this.pick = p.pick);
    this.panel = true;
    this.open = new Set(); // expanded tool cards / thinking
    this.withFile = true;
    this.scroll = ScrollHandle.new();
    this.box = TextareaState.new({ placeholder: "Ask Claude…  (⌘Enter to send · drop files here)", rows: 3 });
    this.box.set_auto_grow(3, 12);
    this.box.on("submit", (_e, cx) => this.submit(cx));
    this.cmdSeen = shared(CMD)?.n ?? null;
    this.initEngine(cx);
    if (checking()) return;
    cx.timer.every(150, (cx) => {
      const c = shared(CMD);
      if (!c || c.n === this.cmdSeen) return;
      this.cmdSeen = c.n;
      if (c.cmd === "resume") this.resume(c.session, cx);
      if (c.cmd === "set" && c.key === "scope") this.pickScope(c.value, cx);
      else if (c.cmd === "set") { this[c.key] = c.value; this.savePrefs(); }
      cx.notify();
    });
    cx.timer.every(300, () => {
      if (!this.scrollDown) return;
      this.scrollDown = false;
      if (this.rowCount) this.scroll.scroll_to_item(this.rowCount - 1);
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.box.focus();
        if (c === "new") this.newChat(cx);
        if (c === "scope" || c === "model" || c === "effort" || c === "mode") this.openPick(c);
        if (c === "stop") this.stop(cx);
        cx.notify();
      }
    });
  }

  submit(cx) {
    const text = this.box.value().trim();
    if (!text || this.turn) return;
    const file = this.withFile ? this.activeFile() : null;
    const prompt = file ? `${text}\n\n(The file open in my editor: ${file})` : text;
    this.box.set_value("");
    this.send(prompt, cx, { display: text });
  }

  // ── popups ─────────────────────────────────────────────────────────────────────────────
  openPick(kind) {
    const options = kind === "model" ? this.modelOptions() : kind === "effort" ? this.effortOptions() : kind === "scope" ? this.scopeOptions() : MODES.map(([value, label, about]) => ({ value, label, about }));
    const current = kind === "model" ? this.model : kind === "effort" ? this.effort : kind === "mode" ? this.mode : this.scope.kind === "folder" ? `folder:${this.scope.path}` : this.scope.kind;
    const rowsH = options.slice(0, 9).reduce((h, o) => h + (o.about ? 46 : 28), 0);
    openOverlay({ mod: MOD, kind: "popup", width: kind === "effort" ? 280 : 340, height: rowsH + 12, props: { pick: { kind, options, current } } });
  }

  // Exact versions; "Default" says what that is (your setting, or what the last turn ran on).
  modelOptions() {
    const dflt = this.defaultModel ? `your setting: ${this.defaultModel}` : this.lastModel ? `Claude Code's default · last ran on ${this.lastModel}` : "Claude Code's default";
    return MODELS.map(([value, label, about]) => ({ value, label, about: value ? about : dflt }));
  }

  effortOptions() {
    return EFFORTS.map(([value, label, about]) => ({ value, label, about: value ? about : this.defaultEffort ? `your setting: ${this.defaultEffort}` : about }));
  }

  // Where Claude works: the active repo, the whole workspace, one repo, or any folder.
  scopeOptions() {
    const ws = workspace();
    const roots = ws?.roots ?? [];
    const tilde = (p) => String(p ?? "").replace(home(), "~");
    return [
      { value: "active", label: "Active repo", about: `follows the Explorer${this.activeRepo ? ` · now ${baseName(this.activeRepo)}` : ""}` },
      ...(roots.length > 1 ? [{ value: "workspace", label: "Entire workspace", about: `${ws.name ?? "workspace"} · all ${roots.length} repos` }] : []),
      ...roots.map((r) => ({ value: `folder:${r.path}`, label: r.name, about: tilde(r.path) })),
      { value: "__pick", label: "Other folder…", about: "choose any folder" },
    ];
  }

  pickScope(value, cx) {
    if (value === "__pick") {
      return void cx.spawn(async (cx) => {
        const dir = await pickFolder({ prompt: "Folder for Claude to work in" }).catch(() => null);
        if (dir) this.setScope({ kind: "folder", path: dir }, cx);
      });
    }
    this.setScope(value.startsWith("folder:") ? { kind: "folder", path: value.slice(7) } : { kind: value }, cx);
  }

  renderPick() {
    const t = theme();
    const p = this.pick;
    return v_flex().id("ch-pick").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small).overflow_y_scrollbar()
      .children(p.options.map((o, i) => v_flex().id(`pk-${i}`).flex_none().px(8).py(o.about ? 5 : 0).h(o.about ? 46 : 28).justify_center().rounded(5).cursor_pointer()
        .bg(o.value === p.current ? t.selected : "#00000000").hover((s) => s.bg(t.hover))
        .on_click(() => { post({ cmd: "set", key: p.kind, value: o.value }); closeOverlay(props()?.overlay); })
        .child(div().font_medium().child(o.label))
        .when(Boolean(o.about), (el) => el.child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(o.about)))));
  }

  initHistory(p, cx) {
    this.history = p.history;
    this.sessions = null;
    cx.spawn(async (cx) => {
      const dir = `${home()}/.claude/projects/${projectDir(p.history.cwd)}`;
      const r = await exec("sh", ["-c", LIST_SESSIONS, "vx-chat", dir]).catch(() => null);
      this.sessions = parseSessionList(r?.stdout ?? "");
      cx.notify();
    });
  }

  renderHistory() {
    const t = theme();
    const list = this.sessions;
    return v_flex().id("ch-hist").size_full().bg(t.popover ?? t.surface).text_color(t.foreground)
      .child(div().h(30).flex_none().px(12).flex().items_center().text_size(TEXT.caption).font_medium().text_color(t.dim).child(`CHATS IN ${baseName(this.history.cwd).toUpperCase()}`))
      .child(v_flex().id("ch-hist-list").h(390).flex_none().overflow_y_scrollbar().px(6).pb(6)
        .children(!list ? [Message("Loading…")] : !list.length ? [Message("No saved chats for this folder yet.")] : list.map((s, i) => h_flex().id(`hs-${i}`).h(40).flex_none().px(8).gap(10).items_center().rounded(6).cursor_pointer().hover((st) => st.bg(t.hover))
          .on_click(() => { post({ cmd: "resume", session: s }); closeOverlay(props()?.overlay); })
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(TEXT.small).font_medium().child(s.title))
            .child(div().truncate().text_size(TEXT.caption).text_color(t.dim).child(s.last && s.last !== s.title ? s.last.split("\n")[0] : s.id.slice(0, 8))))
          .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(s.at))))));
  }

  // The panel's one button size (26px), so cards and the composer match.
  button(t, id, label, icon, primary, onClick) {
    return h_flex().id(id).h(26).px(10).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(TEXT.small).font_medium()
      .bg(primary ? t.solid ?? t.accent : t.raised).text_color(primary ? t.solid_foreground ?? t.accent_foreground : t.foreground)
      .border_1().border_color(primary ? t.solid ?? t.accent : t.border)
      .hover((st) => (primary ? st.opacity(0.88) : st.bg(t.hover))).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => onClick(cx))
      .when(Boolean(icon), (el) => el.child(Icon(icon, 12))).child(label);
  }

  // ── messages ───────────────────────────────────────────────────────────────────────────
  toolCard(t, it, i) {
    const open = this.open.has(it.id ?? i);
    const toggle = () => { const k = it.id ?? i; if (this.open.has(k)) this.open.delete(k); else this.open.add(k); };
    if (it.name === "ExitPlanMode") return this.planCard(t, it, i);
    const status = it.denied ? ["⊘", t.ansi3, "needs permission"] : !it.done ? [null, t.dim, "running"] : it.isError ? ["✕", t.ansi1, "error"] : ["✓", t.ansi2, ""];
    const file = editedFile(it.name, it.input);
    const diff = open ? editDiff(it.name, it.input) : null;
    return v_flex().id(`tc-${i}`).flex_none().mx(GUTTER).my(4).rounded(6).border_1().border_color(t.border).bg(t.background).overflow_hidden()
      .child(h_flex().id(`tch-${i}`).h(28).px(8).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover)).text_size(TEXT.small)
        .on_click((_e, cx) => { toggle(); cx.notify(); })
        .child(Icon(TOOL_ICON[it.name] ?? "sparkles", 12).text_color(t.dim))
        .child(div().flex_none().font_medium().child(it.name ?? "Tool"))
        .child(div().flex_1().min_w(0).truncate().font_family(codeFont()).text_size(TEXT.caption).text_color(t.muted).child(toolSummary(it.name, it.input ?? safeJson(it.inputText))))
        .when(Boolean(this.turn?.state?.subAgents?.[it.id]), (el) => el.child(div().text_size(TEXT.caption).text_color(t.dim).child(`${this.turn.state.subAgents[it.id]} steps`)))
        .child(status[0] ? div().flex_none().text_color(status[1]).tooltip(status[2]).child(status[0]) : Icon("spinner", 11).spin(900).text_color(t.dim)))
      .when(open, (el) => el
        .when(Boolean(diff), (e2) => e2.child(v_flex().id(`tcd-${i}`).max_h(260).overflow_y_scrollbar().border_t(1).border_color(t.border).py(4).font_family(codeFont()).text_size(TEXT.caption)
          .children(diff.slice(0, 400).map((d, k) => h_flex().id(`tcdl-${i}-${k}`).px(8).gap(6).bg(d.op === "+" ? `${t.ansi2}1f` : d.op === "-" ? `${t.ansi1}1f` : "#00000000")
            .child(div().w(8).flex_none().text_color(d.op === "+" ? t.ansi2 : d.op === "-" ? t.ansi1 : t.dim).child(d.op))
            .child(div().flex_1().min_w(0).whitespace_normal().child(d.text || " "))))))
        .when(!diff && Boolean(it.input), (e2) => e2.child(div().border_t(1).border_color(t.border).px(8).py(6).font_family(codeFont()).text_size(TEXT.caption).text_color(t.muted).whitespace_normal()
          .children(inputLines(it.name, it.input).map((l, k) => div().id(`tci-${i}-${k}`).whitespace_normal().child(l)))))
        .when(it.result !== null && it.result !== undefined, (e2) => e2.child(v_flex().id(`tcr-${i}`).max_h(220).overflow_y_scrollbar().border_t(1).border_color(t.border).px(8).py(6).font_family(codeFont()).text_size(TEXT.caption)
          .text_color(it.isError ? t.ansi1 : t.muted).children(String(it.result).split("\n").slice(0, 60).map((l) => div().whitespace_normal().child(l || " ")))))
        .when(Boolean(file), (e2) => e2.child(h_flex().border_t(1).border_color(t.border).px(6).py(4).gap(6)
          .child(this.button(t, `tco-${i}`, `Open ${baseName(file)}`, "file", false, () => openFile(file))))));
  }

  planCard(t, it, i) {
    const plan = it.input?.plan ?? "";
    return v_flex().id(`pc-${i}`).flex_none().mx(GUTTER).my(6).rounded(8).border_1().border_color(t.accent).bg(t.background).overflow_hidden()
      .child(h_flex().h(30).px(10).gap(8).items_center().bg(`${t.accent}1a`).text_size(TEXT.small)
        .child(Icon("list", 13).text_color(t.accent)).child(div().flex_1().font_semibold().child("Plan")))
      .child(div().px(14).py(8).child(TextView.markdown(`plan-${i}`, plan || "*(empty plan)*").w_full().text_size(TEXT.small).selectable(true).scrollable(false)))
      .when(!this.turn, (el) => el.child(h_flex().px(10).pb(10).gap(8)
        .child(this.button(t, `pc-go-${i}`, "Approve & implement (Auto-edit)", "check", true, (cx) => this.approvePlan(cx)))
        .child(this.button(t, `pc-ed-${i}`, "Keep planning", null, false, () => this.box.focus()))));
  }

  row(t, it, i) {
    switch (it.kind) {
      case "user":
        return div().id(`u-${i}`).flex_none().mx(GUTTER).mt(i === 0 ? 12 : 16).mb(6).px(12).py(8).rounded(8).bg(t.raised).text_size(TEXT.body).whitespace_normal().child(it.text);
      case "text":
        return div().id(`a-${i}`).flex_none().px(GUTTER).py(4).child(TextView.markdown(`md-${i}`, it.text || "…").w_full().text_size(TEXT.body).selectable(true).scrollable(false));
      case "thinking": {
        const open = this.open.has(`th-${i}`);
        return v_flex().id(`th-${i}`).flex_none().mx(GUTTER).my(4).cursor_pointer().on_click((_e, cx) => { if (open) this.open.delete(`th-${i}`); else this.open.add(`th-${i}`); cx.notify(); })
          .child(h_flex().gap(6).items_center().text_size(TEXT.caption).text_color(t.dim).italic()
            .child(Icon(open ? "chevron-down" : "chevron-right", 10)).child(it.done ? "Thought" : "Thinking…"))
          .when(open && Boolean(it.text), (el) => el.child(div().pl(16).pt(4).text_size(TEXT.caption).text_color(t.dim).italic().whitespace_normal().child(it.text)));
      }
      case "tool":
        return this.toolCard(t, it, i);
      case "result":
        return h_flex().id(`r-${i}`).flex_none().px(GUTTER).pt(6).pb(4).gap(8).text_size(TEXT.caption).text_color(it.ok ? t.dim : t.ansi1)
          .child(it.ok ? "✓ Done" : `✕ ${it.subtype?.replace(/_/g, " ") ?? "Error"}`)
          .when(Boolean(it.model), (el) => el.child(div().tooltip(`${it.model}${it.effort ? ` · effort ${it.effort}` : ""}`).child(`${modelLabel(it.model)}${it.effort ? ` · ${it.effort}` : ""}`)))
          .when(it.cost !== null && it.cost !== undefined, (el) => el.child(div().child(formatCost(it.cost))))
          .when(Boolean(it.durationMs), (el) => el.child(div().child(formatDuration(it.durationMs))))
          .when(Boolean(it.turns), (el) => el.child(div().child(`${it.turns} step${it.turns === 1 ? "" : "s"}`)));
      case "denied":
        return v_flex().id(`d-${i}`).flex_none().mx(GUTTER).my(6).px(10).py(8).gap(8).rounded(8).border_1().border_color(t.ansi3).bg(`${t.ansi3}14`)
          .child(h_flex().gap(8).items_start().text_size(TEXT.small).child(Icon("alert", 13).text_color(t.ansi3))
            .child(div().flex_1().min_w(0).whitespace_normal().child(`Claude needed permission for ${it.denials.map((d) => `${d.tool}${d.input?.command ? ` (${String(d.input.command).split("\n")[0].slice(0, 40)})` : d.input?.file_path ? ` ${baseName(d.input.file_path)}` : ""}`).join(", ")}.`)))
          .when(!this.turn, (el) => el.child(h_flex().flex_wrap().gap(8)
            .child(this.button(t, `d-ok-${i}`, `Allow ${it.tools.join(", ")} & retry`, "check", true, (cx) => this.allowAndRetry(it.tools, cx)))
            .child(this.button(t, `d-term-${i}`, "Open in terminal", "terminal", false, () => this.openInTerminal()))));
      case "error":
        return div().id(`e-${i}`).flex_none().mx(GUTTER).my(6).px(10).py(8).rounded(6).bg(`${t.ansi1}18`).text_size(TEXT.small).text_color(t.ansi1).whitespace_normal().child(it.text);
      case "note":
        return div().id(`n-${i}`).flex_none().px(GUTTER).py(4).text_size(TEXT.caption).text_color(t.dim).child(it.text);
    }
    return div();
  }

  renderEmpty(t) {
    const modes = [["Ask", "reads freely, asks before changes"], ["Auto-edit", "edits files without asking"], ["Plan", "proposes a plan, changes nothing"]];
    return v_flex().flex_1().items_center().justify_center().gap(8).px(24).text_color(t.dim)
      .child(image("mods/vx-icons/icons/claude.svg").size(36).opacity(0.9))
      .child(div().pt(2).text_size(TEXT.title).font_semibold().text_color(t.foreground).child("Claude"))
      .child(div().text_size(TEXT.small).text_center().whitespace_normal().child(!this.cwd ? "Pick a repo in the Explorer, or a folder below." : this.scope.kind === "workspace" ? `Ask about the whole ${(workspace()?.name ?? "workspace")} workspace (${workspace()?.roots?.length ?? 0} repos), or have Claude change it.` : `Ask about ${baseName(this.cwd)}, or have Claude change it.`))
      // Names right-aligned in one column, what they do left-aligned in the next.
      .child(h_flex().pt(12).gap(8).items_start().text_size(TEXT.caption)
        .child(v_flex().gap(6).items_end().children(modes.map(([n]) => div().font_medium().text_color(t.muted).child(n))))
        .child(v_flex().gap(6).children(modes.map(([, a]) => div().child(a)))));
  }

  renderPanel() {
    const t = theme();
    const items = this.allItems();
    const running = Boolean(this.turn);
    const header = h_flex().h(38).flex_none().pl(GUTTER).pr(6).gap(6).items_center().border_b(1).border_color(t.border)
      .child(image("mods/vx-icons/icons/claude.svg").size(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).font_medium().child(this.title ?? "New chat"))
      .child(div().w(2))
      .child(IconButton({ id: "ch-hist", icon: "history", label: "Chat history", size: 24, onClick: () => this.cwd && openOverlay({ mod: MOD, kind: "popup", width: 360, height: 430, props: { history: { cwd: this.cwd } } }) }))
      .child(IconButton({ id: "ch-term", icon: "terminal", label: "Continue in Claude Code's terminal", size: 24, disabled: !this.sessionId, onClick: () => this.openInTerminal() }))
      .child(IconButton({ id: "ch-new", icon: "plus", label: "New chat", size: 24, onClick: (cx) => this.newChat(cx) }));
    const rows = items.map((it, i) => this.row(t, it, i));
    if (running && !(this.turn.state.items.length)) rows.push(h_flex().id("ch-wait").flex_none().px(GUTTER).py(6).gap(8).text_size(TEXT.small).text_color(t.dim).child(Icon("spinner", 12).spin(900)).child("Claude is working…"));
    this.rowCount = rows.length;
    const body = items.length || running
      ? v_flex().id("ch-msgs").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).pb(8).children(rows)
      : this.renderEmpty(t);
    const file = this.activeFile();
    const chip = (id, label, onClick, tip) => h_flex().id(id).h(24).px(6).gap(4).items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => onClick())
      .child(label).child(Icon("chevron-down", 9).text_color(t.dim));
    const modeLabel = MODES.find(([v]) => v === this.mode)?.[1] ?? "Ask";
    const modelText = this.model ? modelLabel(this.model) : this.defaultModel ? modelLabel(this.defaultModel) : this.lastModel ? `${modelLabel(this.lastModel)} (default)` : "Default model";
    const effortName = EFFORTS.find(([v]) => v === (this.effort || this.defaultEffort))?.[1] ?? "Default";
    const effortText = `${effortName} effort${this.effort ? "" : " (default)"}`;
    const send = (id, label, icon, primary, onClick) => this.button(t, id, label, icon, primary, onClick);
    const composer = v_flex().flex_none().mx(GUTTER).mt(4).mb(GUTTER - 2).rounded(8).border_1().border_color(t.input ?? t.border).bg(t.background)
      .on_drop((e, cx) => { if (e.paths?.length) { this.box.set_value(`${this.box.value()}${this.box.value() && !/\s$/.test(this.box.value()) ? " " : ""}${e.paths.map((p) => `@${p}`).join(" ")} `); this.box.focus(); } cx.notify(); })
      .on_key_down((e, cx) => { if (e.key === "enter" && e.modifiers?.platform) { cx.stop_propagation(); this.submit(cx); } })
      .child(h_flex().px(6).pt(6).gap(4).min_w(0)
        .child(h_flex().id("ch-scope").h(22).px(6).gap(4).flex_shrink(0).max_w(220).items_center().rounded(5).cursor_pointer().text_size(TEXT.caption).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(() => this.openPick("scope"))
          .tooltip(`Claude works in ${this.cwd ?? "no folder yet"}${this.addDirs?.length ? `\nand can also reach:\n${this.addDirs.join("\n")}` : ""}\nClick to choose: active repo, the whole workspace, or a folder`)
          .child(Icon(this.scope.kind === "workspace" ? "layers" : "folder", 11)).child(div().truncate().child(this.scopeLabel ?? "Pick a folder")).child(Icon("chevron-down", 9).text_color(t.dim)))
        .when(Boolean(file), (el) => el.child(h_flex().id("ch-file").h(20).px(6).gap(4).items_center().rounded(4).cursor_pointer().text_size(TEXT.caption)
          .bg(this.withFile ? t.selected : "#00000000").text_color(this.withFile ? t.foreground : t.dim).border_1().border_color(t.border)
          .tooltip(this.withFile ? "The open file goes with your message (click to leave it out)" : "Click to send the open file's path with your message")
          .on_click((_e, cx) => { this.withFile = !this.withFile; cx.notify(); })
          .child(Icon("file", 10)).child(div().truncate().child(baseName(file))).when(!this.withFile, (e2) => e2.line_through()).min_w(0))))
      .child(div().px(8).pt(4).child(Textarea.new(this.box).w_full().text_size(TEXT.body)))
      // Chips start where the text does (8px), and the button keeps 6px from every edge.
      .child(h_flex().h(38).px(2).pr(6).gap(0).items_center()
        .child(chip("ch-mode", modeLabel, () => this.openPick("mode"), "Permission mode for this chat"))
        .child(chip("ch-model", modelText, () => this.openPick("model"), "Model (exact version)"))
        .child(chip("ch-effort", effortText, () => this.openPick("effort"), "Effort: how hard Claude thinks (--effort)"))

        .child(div().flex_1())
        .child(running ? send("ch-stop", "Stop", "stop", false, (cx) => this.stop(cx)) : send("ch-send", "Send", "arrow-up", true, (cx) => this.submit(cx))));
    return v_flex().id(MOD).size_full().min_h(0).bg(t.chrome).text_color(t.foreground).text_size(TEXT.body)
      .child(header).child(body).child(composer);
  }

  render() {
    if (this.history) return this.renderHistory();
    if (this.pick) return this.renderPick();
    return this.renderPanel();
  }
}

// A tool's input as short "key  value" lines (Bash: the command after a $).
function inputLines(name, input) {
  if (name === "Bash") return [`$ ${input.command ?? ""}`, ...(input.description ? [`# ${input.description}`] : [])];
  return Object.entries(input ?? {}).slice(0, 12).map(([k, v]) => {
    const val = typeof v === "string" ? v : JSON.stringify(v);
    return `${k}  ${val.length > 300 ? `${val.slice(0, 300)}…` : val}`;
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Opens a file Claude touched in the preview tab (its folder as the root).
function openFile(abs) {
  const i = abs.lastIndexOf("/");
  showInViewer("vx-files", { root: abs.slice(0, i), on: null, rel: abs.slice(i + 1) }, abs.slice(i + 1));
}

Object.assign(VxChat.prototype, engineMethods);
export default VxChat;
