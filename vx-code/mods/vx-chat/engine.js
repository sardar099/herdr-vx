// The chat's engine. Each turn runs `claude -p … --output-format stream-json` in a hidden
// herdr-core terminal (label vx.chat=1, no herdr.space label, so it never shows as a tab),
// writing its stream to ~/.local/state/vx-chat/<turn>.jsonl. The panel reads that file as it
// grows (every 250 ms while a turn runs). Follow-ups --resume the session; Stop kills the
// terminal. The working folder is the active repo.
import { exec, hc, run, readTextFile, notify, home, terminals, spaces } from "herdr";
import { describeTab } from "./kinds.js";
import { claudeArgs, parseStream, parseSessionFile, allowFor, scopeDirs, MODEL_ALIASES } from "./chat-core.js";
import { ctx, repoTop, workspace } from "./ws.js";
import { runInTab } from "./term.js";

const stateDir = () => `${home()}/.local/state/vx-chat`;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const engineMethods = {
  initEngine(cx) {
    this.tops = new Map();
    this.items = []; // the conversation so far (finished turns, or a resumed transcript)
    this.turn = null; // { id, address, out, err, state, offset, startedAt }
    this.sessionId = null;
    this.allowed = [];
    try {
      const p = JSON.parse(localStorage.getItem("prefs") ?? "{}");
      this.model = MODEL_ALIASES[p.model] ?? p.model ?? "";
      this.mode = p.mode ?? "default";
      this.effort = p.effort ?? "";
      this.scope = p.scope?.kind ? p.scope : { kind: "active" };
    } catch {
      this.model = "";
      this.mode = "default";
      this.effort = "";
      this.scope = { kind: "active" };
    }
    try {
      this.lastModel = localStorage.getItem("lastModel") || null;
    } catch {}
    this.applyScope();
    cx.spawn(async (cx) => {
      const r = await exec("/bin/zsh", ["-lc", "command -v claude"]).catch(() => null);
      this.claude = r?.code === 0 && r.stdout.trim() ? r.stdout.trim().split("\n").pop() : `${home()}/.local/bin/claude`;
      await exec("mkdir", ["-p", stateDir()]).catch(() => {});
      // What "Default" means: Claude Code's own settings.
      const settingsText = await readTextFile(`${home()}/.claude/settings.json`).catch(() => null);
      try {
        const st = JSON.parse(settingsText ?? "{}");
        this.defaultModel = st.model ?? null;
        this.defaultEffort = st.effortLevel ?? null;
      } catch {}
      cx.notify();
    });
    cx.timer.every(500, (cx) => this.followRepo(cx));
    cx.timer.every(250, (cx) => this.pollTurn(cx));
  },

  savePrefs() {
    try {
      localStorage.setItem("prefs", JSON.stringify({ model: this.model, mode: this.mode, effort: this.effort, scope: this.scope }));
    } catch {}
  },

  // Where the chat works, from its scope: the active repo (a new chat follows the Explorer; a
  // running one keeps its folder), the whole workspace, or one folder.
  applyScope() {
    const d = scopeDirs(this.scope, workspace(), this.activeRepo ?? null);
    this.cwd = d.cwd;
    this.addDirs = d.addDirs;
    this.scopeLabel = d.label;
  },

  followRepo(cx) {
    if (this.turn || this.items.length) return;
    // The workspace's repos can change (added / removed roots).
    if (this.scope.kind === "workspace") {
      const key = JSON.stringify(workspace()?.roots ?? []);
      if (key !== this.wsSeen) {
        this.wsSeen = key;
        this.applyScope();
        cx.notify();
      }
    }
    const c = ctx();
    if (c.on) return;
    const cwd = c.cwd ?? c.root?.path ?? null;
    if (!cwd || cwd === this.cwdSeen) return;
    this.cwdSeen = cwd;
    cx.spawn(async (cx) => {
      const top = await repoTop(this.tops, cwd, null);
      this.activeRepo = top ?? cwd;
      this.applyScope();
      cx.notify();
    });
  },

  // A new scope starts a new chat: Claude keeps a session with the folder it ran in.
  setScope(scope, cx) {
    const had = this.items.length > 0 || Boolean(this.turn);
    if (had) this.newChat(cx);
    this.scope = scope;
    this.savePrefs();
    this.applyScope();
    if (had) this.items.push({ kind: "note", text: `New chat in ${this.scopeLabel}.` });
    cx.notify();
  },

  newChat(cx) {
    if (this.turn) this.stop(cx);
    this.items = [];
    this.sessionId = null;
    this.allowed = [];
    this.title = null;
    this.cwdSeen = null;
    this.followRepo(cx);
    cx.notify();
  },

  // ── a turn ─────────────────────────────────────────────────────────────────────────────
  send(text, cx, { allowedTools, display } = {}) {
    const prompt = String(text ?? "").trim();
    if (!prompt || this.turn) return;
    if (!this.cwd) return notify({ title: "No folder for Claude", body: "Pick a repo in the Explorer first.", level: "warning" });
    if (allowedTools?.length) this.allowed = [...new Set([...this.allowed, ...allowedTools])];
    this.items.push({ kind: "user", text: display ?? prompt });
    this.title ??= prompt.split("\n")[0].slice(0, 60);
    const id = stamp();
    const out = `${stateDir()}/${id}.jsonl`, err = `${stateDir()}/${id}.err`;
    const args = claudeArgs({ prompt, sessionId: this.sessionId, model: this.model, mode: this.mode, effort: this.effort, allowedTools: this.allowed, addDirs: this.addDirs });
    // A login shell gives claude (and the tools it runs) your usual PATH.
    const argv = ["/bin/zsh", "-lc", 'out=$1; err=$2; shift 2; exec "$@" >"$out" 2>"$err" </dev/null', "vx-chat", out, err, this.claude ?? "claude", ...args];
    this.turn = { id, address: null, out, err, state: parseStream([]), offset: 0, partial: "", startedAt: Date.now() };
    this.scrollDown = true;
    cx.notify();
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", stateDir()]).catch(() => {});
      const r = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--label", "vx.chat=1", "--cwd", this.cwd, "--", ...argv]).catch((e) => ({ code: -1, stderr: String(e?.message ?? e), stdout: "" }));
      let address = null;
      try {
        address = r.code === 0 ? JSON.parse(r.stdout).address : null;
      } catch {}
      if (!address) {
        this.items.push({ kind: "error", text: `Couldn't start Claude: ${(r.stderr || r.stdout || "").trim()}` });
        this.turn = null;
        return cx.notify();
      }
      if (this.turn?.id === id) this.turn.address = address;
    });
  },

  // New stream lines into the turn; finish when the result arrives or the program is gone.
  pollTurn(cx) {
    const turn = this.turn;
    if (!turn || this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        const text = (await readTextFile(turn.out).catch(() => null)) ?? "";
        if (this.turn !== turn) return;
        if (text.length > turn.offset) {
          const chunk = text.slice(turn.offset);
          const cut = chunk.lastIndexOf("\n");
          if (cut >= 0) {
            parseStream(chunk.slice(0, cut).split("\n"), turn.state);
            turn.offset += cut + 1;
            if (turn.state.sessionId) this.sessionId = turn.state.sessionId;
            this.scrollDown = true;
            cx.notify();
          }
        }
        const alive = turn.address ? (terminals() ?? []).some((x) => x.address === turn.address && x.state === "live") : Date.now() - turn.startedAt < 8000;
        if (turn.state.result || (!alive && Date.now() - turn.startedAt > 1500)) await this.finishTurn(turn, cx);
      } finally {
        this.polling = false;
      }
    });
  },

  async finishTurn(turn, cx) {
    if (this.turn !== turn) return;
    const s = turn.state;
    this.items.push(...s.items);
    if (s.result) {
      this.items.push({ kind: "result", ...s.result, model: s.model, effort: this.effort || this.defaultEffort || null, stopped: turn.stopped });
      if (s.model) {
        this.lastModel = s.model;
        try {
          localStorage.setItem("lastModel", s.model);
        } catch {}
      }
      if (s.result.denials.length) this.items.push({ kind: "denied", denials: s.result.denials, tools: allowFor(s.result.denials) });
    } else {
      const err = ((await readTextFile(turn.err).catch(() => null)) ?? "").trim();
      this.items.push(turn.stopped ? { kind: "note", text: "Stopped." } : { kind: "error", text: err || "Claude ended without an answer." });
    }
    this.turn = null;
    this.scrollDown = true;
    exec("rm", ["-f", turn.out, turn.err]).catch(() => {});
    cx.notify();
  },

  stop(cx) {
    const turn = this.turn;
    if (!turn) return;
    turn.stopped = true;
    if (turn.address) run("terminal.kill", { terminal: turn.address });
    this.finishTurn(turn, cx);
  },

  // Denied tools: allow them for this session and ask Claude to go on.
  allowAndRetry(tools, cx) {
    this.send("I allowed it: please retry what was blocked and carry on.", cx, { allowedTools: tools, display: `Allowed ${tools.join(", ")} · retry` });
  },

  approvePlan(cx) {
    this.mode = "acceptEdits";
    this.savePrefs();
    this.send("The plan is approved. Go ahead and implement it.", cx, { display: "Approved the plan · Auto-edit" });
  },

  // The same session in Claude Code's terminal (per-call permission prompts, every command).
  openInTerminal() {
    if (!this.sessionId) return notify({ title: "Nothing to continue yet", level: "info" });
    runInTab([this.claude ?? "claude", "--resume", this.sessionId], { cwd: this.cwd, name: "Claude" });
  },

  // A saved session from ~/.claude/projects: show its transcript, continue it with --resume.
  resume(session, cx) {
    if (this.turn) this.stop(cx);
    cx.spawn(async (cx) => {
      const r = await exec("tail", ["-n", "3000", session.file]).catch(() => null);
      const parsed = parseSessionFile(r?.stdout ?? "");
      this.items = [...parsed.items, { kind: "note", text: "Resumed: new messages continue this session." }];
      this.sessionId = session.id;
      this.title = parsed.title ?? session.title;
      this.allowed = [];
      this.scrollDown = true;
      cx.notify();
    });
  },

  // Items to draw: the conversation, then the running turn's.
  allItems() {
    return this.turn ? [...this.items, ...this.turn.state.items] : this.items;
  },

  // The file open in the editor (a preview or a diff tab), as context for the prompt.
  activeFile() {
    const space = spaces().find((x) => x.active);
    const tab = space?.tabs?.find((x) => x.active);
    if (!tab) return null;
    const d = describeTab(tab, space.id);
    const rel = d.value?.rel ?? d.value?.path;
    return (d.kind === "preview" || d.kind === "diff") && d.value?.root && rel && !d.value.on ? `${d.value.root}/${rel}` : null;
  },
};
