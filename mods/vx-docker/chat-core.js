// Claude Chat (vx-chat): what `claude -p --output-format stream-json --verbose
// --include-partial-messages` prints, turned into chat items; the arguments for a turn; the
// saved sessions in ~/.claude/projects. Pure: no herdr imports, so node tests can load it.
import { diffLines } from "./devtools-core.js";

// Exact model versions (Claude Code takes the full name with --model), newest family first.
export const MODELS = [
  ["", "Default", "Claude Code's own default"],
  ["claude-fable-5-2", "Fable 5.2", "claude-fable-5-2 · most capable"],
  ["claude-opus-5-5", "Opus 5.5", "claude-opus-5-5"],
  ["claude-sonnet-5-5", "Sonnet 5.5", "claude-sonnet-5-5"],
  ["claude-haiku-5-5", "Haiku 5.5", "claude-haiku-5-5 · fastest"],
];
// Saved choices from before exact versions (aliases) map to them.
export const MODEL_ALIASES = { fable: "claude-fable-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
export const modelLabel = (id) => MODELS.find(([v]) => v === id)?.[1] ?? (id ? id.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, (c) => c.toUpperCase()) : "Default");
// --effort levels.
export const EFFORTS = [
  ["", "Default", "your Claude Code setting"],
  ["low", "Low", "quickest, least thinking"],
  ["medium", "Medium", "balanced"],
  ["high", "High", "thinks harder"],
  ["xhigh", "Extra high", "deeper thinking"],
  ["max", "Max", "most thinking, slowest"],
];
export const MODES = [["default", "Ask", "Reads freely; edits and commands that need approval are refused (Allow & retry)"], ["acceptEdits", "Auto-edit", "Edits files without asking; commands that need approval are refused"], ["plan", "Plan", "Looks around and proposes a plan; changes nothing"]];

// Arguments for one turn (a new session, or --resume of one).
export function claudeArgs({ prompt, sessionId, model, mode, effort, allowedTools, addDirs }) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", MODEL_ALIASES[model] ?? model);
  if (effort) args.push("--effort", effort);
  if (mode && mode !== "default") args.push("--permission-mode", mode);
  if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
  // Last: --add-dir takes every argument after it.
  if (addDirs?.length) args.push("--add-dir", ...addDirs);
  return args;
}

// Where a chat works. scope: { kind: "active" } (the repo the Explorer has active),
// { kind: "workspace" } (the folder of the .code-workspace, every repo in it, and --add-dir for
// repos that live elsewhere), or { kind: "folder", path }.
//   ws = shared vx.workspace ({ file?, dir?, name, roots: [{ name, path }] }), active = a folder.
export function scopeDirs(scope, ws, active) {
  const parent = (p) => String(p).replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
  const under = (p, base) => p === base || p.startsWith(`${base.replace(/\/+$/, "")}/`);
  if (scope?.kind === "folder" && scope.path) return { cwd: scope.path, addDirs: [], label: scope.path.split("/").pop() || scope.path };
  if (scope?.kind === "workspace" && ws?.roots?.length) {
    const roots = ws.roots.map((r) => r.path);
    let base = ws.file ? parent(ws.file) : ws.dir ?? null;
    // No workspace folder: the deepest folder every repo shares.
    if (!base) {
      base = roots[0];
      while (base !== "/" && !roots.every((r) => under(r, base))) base = parent(base);
    }
    return { cwd: base, addDirs: roots.filter((r) => !under(r, base)), label: `${ws.name ?? base.split("/").pop()} · ${roots.length} repos`, workspace: true };
  }
  return { cwd: active ?? null, addDirs: [], label: active ? active.split("/").pop() : "No folder" };
}

// ~/.claude/projects/<this>/ for a working folder: every character not a letter or digit is "-".
export const projectDir = (cwd) => String(cwd ?? "").replace(/[^A-Za-z0-9]/g, "-");

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("") : "");

// Stream lines -> { sessionId, model, cwd, items, result, running }.
//   items: { kind: "user", text } | { kind: "text", text, done } | { kind: "thinking", text, done }
//        | { kind: "tool", id, name, input, inputText, result, isError, denied, done }
// Partial text streams in through stream_event deltas; the complete assistant message (one
// content block per event) then settles each block. Sub-agent traffic (parent_tool_use_id) is
// counted on its Task card, not shown inline.
export function parseStream(input, state = null) {
  const s = state ?? { sessionId: null, model: null, cwd: null, items: [], result: null, running: true, blocks: new Map(), subAgents: {} };
  const lines = Array.isArray(input) ? input : String(input ?? "").split("\n");
  for (const raw of lines) {
    let ev = raw;
    if (typeof raw === "string") {
      if (!raw.trim()) continue;
      try {
        ev = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    if (ev.parent_tool_use_id) {
      s.subAgents[ev.parent_tool_use_id] = (s.subAgents[ev.parent_tool_use_id] ?? 0) + (ev.type === "assistant" ? 1 : 0);
      continue;
    }
    if (ev.type === "system" && ev.subtype === "init") {
      s.sessionId = ev.session_id ?? s.sessionId;
      s.model = ev.model ?? s.model;
      s.cwd = ev.cwd ?? s.cwd;
    } else if (ev.type === "system" && ev.subtype === "permission_denied") {
      const t = s.items.find((x) => x.kind === "tool" && x.id === ev.tool_use_id);
      if (t) t.denied = true;
    } else if (ev.type === "stream_event") streamEvent(s, ev.event ?? {});
    else if (ev.type === "assistant") {
      const msg = ev.message ?? {};
      for (const [i, block] of (msg.content ?? []).entries()) settle(s, msg.id, i, block);
    } else if (ev.type === "user") {
      for (const c of ev.message?.content ?? []) {
        if (c?.type !== "tool_result") continue;
        const t = s.items.find((x) => x.kind === "tool" && x.id === c.tool_use_id);
        if (!t) continue;
        t.result = textOf(c.content);
        t.isError = c.is_error === true;
        t.done = true;
        if (t.isError && /requested permissions|haven't granted|permission/i.test(t.result)) t.denied = true;
      }
    } else if (ev.type === "result") {
      s.running = false;
      s.sessionId = ev.session_id ?? s.sessionId;
      s.result = {
        ok: !ev.is_error, subtype: ev.subtype, text: ev.result ?? "", cost: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null, turns: ev.num_turns ?? null,
        denials: (ev.permission_denials ?? []).map((d) => ({ tool: d.tool_name, id: d.tool_use_id, input: d.tool_input })),
      };
      for (const d of s.result.denials) {
        const t = s.items.find((x) => x.kind === "tool" && x.id === d.id);
        if (t) t.denied = true;
      }
      for (const it of s.items) if (it.kind !== "tool") it.done = true;
    }
  }
  return s;
}

function streamEvent(s, e) {
  if (e.type === "message_start") s.msgId = e.message?.id ?? null;
  else if (e.type === "content_block_start") {
    const b = e.content_block ?? {};
    const key = `${s.msgId}:${e.index}`;
    const item = b.type === "tool_use" ? { kind: "tool", id: b.id, name: b.name, input: null, inputText: "", result: null, isError: false, denied: false, done: false }
      : b.type === "thinking" ? { kind: "thinking", text: b.thinking ?? "", done: false }
      : b.type === "text" ? { kind: "text", text: b.text ?? "", done: false } : null;
    if (!item) return;
    s.items.push(item);
    s.blocks.set(key, item);
  } else if (e.type === "content_block_delta") {
    const item = s.blocks.get(`${s.msgId}:${e.index}`);
    const d = e.delta ?? {};
    if (!item) return;
    if (d.type === "text_delta") item.text += d.text ?? "";
    else if (d.type === "thinking_delta") item.text += d.thinking ?? "";
    else if (d.type === "input_json_delta") item.inputText += d.partial_json ?? "";
  } else if (e.type === "content_block_stop") {
    const item = s.blocks.get(`${s.msgId}:${e.index}`);
    if (item?.kind === "tool" && item.input === null) {
      try {
        item.input = JSON.parse(item.inputText || "{}");
      } catch {}
    }
    if (item && item.kind !== "tool") item.done = true;
  }
}

// A complete content block from an "assistant" event: settle the streamed item, or add it.
// Claude Code sends one block per event, so the index inside an event isn't the API index:
// match by kind within the message (tools by id).
function settle(s, msgId, _i, block) {
  if (block.type === "tool_use") {
    let t = s.items.find((x) => x.kind === "tool" && x.id === block.id);
    if (!t) {
      t = { kind: "tool", id: block.id, name: block.name, input: null, inputText: "", result: null, isError: false, denied: false, done: false };
      s.items.push(t);
    }
    t.name = block.name;
    t.input = block.input ?? t.input;
    return;
  }
  const kind = block.type === "thinking" ? "thinking" : block.type === "text" ? "text" : null;
  if (!kind) return;
  const owned = [...s.blocks.entries()].filter(([k, v]) => k.startsWith(`${msgId}:`) && v.kind === kind && !v.settled).map(([, v]) => v);
  const item = owned[0];
  const text = kind === "thinking" ? block.thinking : block.text;
  if (item) {
    if (typeof text === "string" && text) item.text = text;
    item.settled = true;
    item.done = true;
  } else if (typeof text === "string" && text) s.items.push({ kind, text, done: true, settled: true });
}

// The items of a saved session (the transcript Claude Code keeps), for showing a resumed chat.
export function parseSessionFile(text, max = 300) {
  const items = [];
  let title = null;
  for (const raw of String(text ?? "").split("\n")) {
    if (!raw.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue;
    }
    if (ev.type === "ai-title" && ev.aiTitle) title = ev.aiTitle;
    if (ev.isSidechain || ev.isMeta) continue;
    if (ev.type === "user") {
      const c = ev.message?.content;
      if (typeof c === "string") {
        if (!c.startsWith("<") || !/^<(command|local-command|system|bash-)/.test(c)) items.push({ kind: "user", text: c });
        continue;
      }
      for (const part of c ?? []) {
        if (part.type === "text" && part.text && !/^<(system-reminder|command|local-command)/.test(part.text)) items.push({ kind: "user", text: part.text });
        if (part.type === "tool_result") {
          const t = items.find((x) => x.kind === "tool" && x.id === part.tool_use_id);
          if (t) {
            t.result = textOf(part.content);
            t.isError = part.is_error === true;
            t.done = true;
          }
        }
      }
    } else if (ev.type === "assistant") {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "text" && b.text) items.push({ kind: "text", text: b.text, done: true });
        else if (b.type === "tool_use") items.push({ kind: "tool", id: b.id, name: b.name, input: b.input, inputText: "", result: null, isError: false, denied: false, done: false });
      }
    }
  }
  for (const it of items) if (it.kind === "tool" && !it.done) it.done = true;
  return { title, items: items.slice(-max) };
}

// `sh` output listing sessions: "@@ <mtime> <path>" then, optionally, the ai-title and the
// last-prompt lines of that file.
export const LIST_SESSIONS = 'cd "$1" 2>/dev/null || exit 0; ls -t -- *.jsonl 2>/dev/null | head -n 40 | while read -r f; do printf "@@ %s %s\\n" "$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f")" "$PWD/$f"; grep -m1 \'"type":"ai-title"\' "$f"; grep \'"type":"last-prompt"\' "$f" | tail -n 1; done';

export function parseSessionList(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^@@ (\d+) (.+\.jsonl)$/.exec(line);
    if (m) {
      cur = { at: Number(m[1]) * 1000, file: m[2], id: m[2].split("/").pop().replace(/\.jsonl$/, ""), title: null, last: null };
      out.push(cur);
      continue;
    }
    if (!cur || !line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "ai-title") cur.title = ev.aiTitle ?? cur.title;
      if (ev.type === "last-prompt") cur.last = ev.lastPrompt ?? cur.last;
    } catch {}
  }
  for (const s of out) s.title ??= (s.last ?? "").split("\n")[0].slice(0, 80) || "Untitled chat";
  return out;
}

// A one-line summary of a tool call for its card.
export function toolSummary(name, input) {
  const i = input ?? {};
  const base = (p) => String(p ?? "").split("/").pop();
  switch (name) {
    case "Read": return `${base(i.file_path)}${i.offset ? ` from line ${i.offset}` : ""}`;
    case "Write": return base(i.file_path);
    case "Edit": case "MultiEdit": return base(i.file_path);
    case "NotebookEdit": return base(i.notebook_path);
    case "Bash": return String(i.command ?? "").split("\n")[0];
    case "Grep": return `${i.pattern ?? ""}${i.path ? ` in ${base(i.path)}` : ""}`;
    case "Glob": return String(i.pattern ?? "");
    case "WebFetch": return String(i.url ?? "");
    case "WebSearch": return String(i.query ?? "");
    case "Task": case "Agent": return String(i.description ?? i.subagent_type ?? "");
    case "TodoWrite": return `${(i.todos ?? []).length} todos`;
    default: {
      const v = Object.values(i).find((x) => typeof x === "string");
      return v ? String(v).split("\n")[0] : "";
    }
  }
}

export const TOOL_ICON = { Read: "eye", Write: "file", Edit: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil", Bash: "terminal", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe", Task: "bot", Agent: "bot", TodoWrite: "list" };

// What an edit changes, as diff lines (Edit, MultiEdit, Write).
export function editDiff(name, input) {
  const i = input ?? {};
  try {
    if (name === "Edit") return diffLines(i.old_string ?? "", i.new_string ?? "");
    if (name === "MultiEdit") return (i.edits ?? []).flatMap((e, n) => [...(n ? [{ op: " ", text: "⋯" }] : []), ...diffLines(e.old_string ?? "", e.new_string ?? "")]);
    if (name === "Write") return String(i.content ?? "").split("\n").map((text) => ({ op: "+", text }));
  } catch {}
  return null;
}

export const editedFile = (name, input) => (["Edit", "MultiEdit", "Write"].includes(name) ? input?.file_path ?? null : name === "NotebookEdit" ? input?.notebook_path ?? null : null);

// Tools Allow & retry should add: the denied ones, by name (a Bash denial allows that command's
// first word, like Claude Code's own rules: Bash(git:*)).
export function allowFor(denials) {
  const out = new Set();
  for (const d of denials ?? []) {
    if (d.tool === "Bash" && d.input?.command) {
      const word = String(d.input.command).trim().split(/\s+/)[0];
      out.add(word ? `Bash(${word}:*)` : "Bash");
    } else out.add(d.tool);
  }
  return [...out];
}

export const formatCost = (usd) => (usd === null || usd === undefined ? "" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
export const formatDuration = (ms) => (!ms ? "" : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
