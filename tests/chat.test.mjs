import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  modelLabel, scopeDirs, parseStream, claudeArgs, projectDir, parseSessionFile, parseSessionList, toolSummary, editDiff, editedFile, allowFor, formatCost, formatDuration,
} from "../shared/chat-core.js";

const fixture = (n) => readFileSync(new URL(`./fixtures/claude-stream-${n}.jsonl`, import.meta.url), "utf8");

test("parseStream: a plain answer (real claude -p output)", () => {
  const s = parseStream(fixture(1));
  assert.equal(s.sessionId, "c980571e-1dd9-411f-a5ed-afd0d10a2737");
  assert.equal(s.running, false);
  assert.deepEqual(s.items.map((i) => [i.kind, i.text]), [["text", "hello there"]]);
  assert.equal(s.result.ok, true);
  assert.ok(s.result.cost > 0);
});

test("parseStream: tool calls, results, a denial, thinking (real output)", () => {
  const s = parseStream(fixture(2));
  const kinds = s.items.map((i) => (i.kind === "tool" ? `tool:${i.name}` : i.kind));
  assert.deepEqual(kinds.filter((k) => k !== "thinking"), ["tool:Read", "tool:Write", "text"]);
  const [read, write] = s.items.filter((i) => i.kind === "tool");
  assert.equal(read.input.file_path, "/tmp/demo/note.txt");
  assert.match(read.result, /first line here/);
  assert.equal(read.isError, false);
  assert.equal(write.denied, true);
  assert.equal(write.input.content, "hi");
  assert.match(s.items.find((i) => i.kind === "text").text, /first line/);
  assert.deepEqual(s.result.denials.map((d) => d.tool), ["Write"]);
});

test("parseStream: streams partially, line by line, then settles", () => {
  const lines = fixture(1).split("\n").filter(Boolean);
  const partial = parseStream(lines.slice(0, lines.findIndex((l) => l.includes('"text_delta"')) + 1));
  assert.equal(partial.running, true);
  assert.ok(partial.items[0].text.length > 0);
  // Feeding the rest into the same state finishes it.
  const rest = lines.slice(lines.findIndex((l) => l.includes('"text_delta"')) + 1);
  const done = parseStream(rest, partial);
  assert.equal(done.items.length, 1);
  assert.equal(done.items[0].text, "hello there");
  assert.equal(done.running, false);
});

test("parseStream: partial tool input JSON, sub-agents counted not shown", () => {
  const ev = (o) => JSON.stringify(o);
  const s = parseStream([
    ev({ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }),
    ev({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "Bash" } } }),
    ev({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"comm' } } }),
    ev({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'and":"ls"}' } } }),
    ev({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
    ev({ type: "assistant", parent_tool_use_id: "task1", message: { id: "m9", content: [{ type: "text", text: "inside a sub-agent" }] } }),
  ]);
  assert.deepEqual(s.items[0].input, { command: "ls" });
  assert.equal(s.items.length, 1);
  assert.equal(s.subAgents.task1, 1);
});

test("claudeArgs: new and resumed turns, model, mode, allowed tools", () => {
  assert.deepEqual(claudeArgs({ prompt: "hi" }), ["-p", "hi", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  const a = claudeArgs({ prompt: "go", sessionId: "s1", model: "opus", mode: "acceptEdits", allowedTools: ["Write", "Bash(git:*)"] });
  assert.deepEqual(a.slice(6), ["--resume", "s1", "--model", "claude-opus-5-5", "--permission-mode", "acceptEdits", "--allowedTools", "Write,Bash(git:*)"]);
});

test("models and effort: exact versions, old aliases, --effort", () => {
  assert.deepEqual(claudeArgs({ prompt: "p", model: "opus", effort: "xhigh" }).slice(6), ["--model", "claude-opus-5-5", "--effort", "xhigh"]);
  assert.deepEqual(claudeArgs({ prompt: "p", model: "claude-haiku-5-5" }).slice(6), ["--model", "claude-haiku-5-5"]);
  assert.equal(modelLabel("claude-sonnet-5-5"), "Sonnet 5.5");
  assert.equal(modelLabel("claude-mythos-6-1"), "Mythos 6.1");
  assert.equal(modelLabel(""), "Default");
});

test("scopeDirs: active repo, a folder, the whole workspace (+ repos outside it)", () => {
  const ws = { file: "/w/proj/proj.code-workspace", name: "proj", roots: [{ name: "a", path: "/w/proj/a" }, { name: "b", path: "/w/proj/b" }, { name: "c", path: "/elsewhere/c" }] };
  assert.deepEqual(scopeDirs({ kind: "active" }, ws, "/w/proj/a"), { cwd: "/w/proj/a", addDirs: [], label: "a" });
  assert.deepEqual(scopeDirs({ kind: "folder", path: "/x/y" }, ws, "/w/proj/a").cwd, "/x/y");
  const w = scopeDirs({ kind: "workspace" }, ws, "/w/proj/a");
  assert.deepEqual([w.cwd, w.addDirs, w.label], ["/w/proj", ["/elsewhere/c"], "proj · 3 repos"]);
  // A plain folder of repos (no .code-workspace): their shared parent.
  assert.equal(scopeDirs({ kind: "workspace" }, { name: "n", roots: [{ path: "/r/x/a" }, { path: "/r/x/b/c" }] }, null).cwd, "/r/x");
  // No workspace open: falls back to the active repo.
  assert.equal(scopeDirs({ kind: "workspace" }, null, "/w/a").cwd, "/w/a");
  assert.deepEqual(claudeArgs({ prompt: "p", addDirs: ["/e/c"] }).slice(-2), ["--add-dir", "/e/c"]);
});

test("projectDir and sessions on disk", () => {
  assert.equal(projectDir("/Users/a/my.repo/x_y"), "-Users-a-my-repo-x-y");
  const file = [
    JSON.stringify({ type: "user", message: { content: "Fix the login bug" } }),
    JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/a.ts" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "code" }] }] } }),
    JSON.stringify({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "sub" }] } }),
    JSON.stringify({ type: "ai-title", aiTitle: "Login bug" }),
    "not json",
  ].join("\n");
  const p = parseSessionFile(file);
  assert.equal(p.title, "Login bug");
  assert.deepEqual(p.items.map((i) => i.kind), ["user", "text", "tool"]);
  assert.equal(p.items[2].result, "code");
  const list = parseSessionList(`@@ 1700000000 /p/abc.jsonl\n${JSON.stringify({ type: "ai-title", aiTitle: "T1" })}\n@@ 1690000000 /p/def.jsonl\n${JSON.stringify({ type: "last-prompt", lastPrompt: "second line one\nmore" })}\n`);
  assert.deepEqual(list.map((s) => [s.id, s.title, s.at]), [["abc", "T1", 1700000000000], ["def", "second line one", 1690000000000]]);
});

test("tool cards: summaries, diffs, allow rules, formatting", () => {
  assert.equal(toolSummary("Read", { file_path: "/a/b/c.ts", offset: 40 }), "c.ts from line 40");
  assert.equal(toolSummary("Bash", { command: "npm test\nmore" }), "npm test");
  assert.equal(toolSummary("Grep", { pattern: "TODO", path: "/r/src" }), "TODO in src");
  assert.deepEqual(editDiff("Edit", { old_string: "a\nb", new_string: "a\nc" }).map((d) => d.op + d.text), [" a", "-b", "+c"]);
  assert.equal(editDiff("Write", { content: "x\ny" }).length, 2);
  assert.equal(editedFile("Edit", { file_path: "/r/a.ts" }), "/r/a.ts");
  assert.equal(editedFile("Read", { file_path: "/r/a.ts" }), null);
  assert.deepEqual(allowFor([{ tool: "Write" }, { tool: "Bash", input: { command: "git push origin main" } }, { tool: "Write" }]), ["Write", "Bash(git:*)"]);
  assert.equal(formatCost(0.0092), "$0.0092");
  assert.equal(formatCost(1.234), "$1.23");
  assert.equal(formatDuration(1210), "1.2 s");
});
