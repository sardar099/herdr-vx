import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPath, rankFiles, runsOf, parseQuery, symbolsOf, commandLabel, keyLabel, actionToRun } from "../shared/quickopen-core.js";

test("matchPath: positions of the matched letters", () => {
  assert.deepEqual(matchPath("src/app/page.tsx", "page").at, [8, 9, 10, 11]);
  assert.deepEqual(matchPath("src/app/page.tsx", "app").at, [4, 5, 6]);
  const s = matchPath("src/components/Card.tsx", "cmcard");
  assert.ok(s && s.at.length === 6);
  assert.equal(matchPath("a/b.ts", "zz"), null);
});

test("matchPath: words must all match; one may match the repo name", () => {
  assert.ok(matchPath("src/app/page.tsx", "app page"));
  assert.equal(matchPath("src/app/page.tsx", "app nope"), null);
  assert.ok(matchPath("src/app/page.tsx", "web page", "acme-web"));
});

test("rankFiles keeps positions and ranks name hits first", () => {
  const files = ["src/components/Card.tsx", "docs/scorecard.md", "src/app/page.tsx"].map((rel) => ({ root: { name: "w" }, rel }));
  const r = rankFiles(files, "card");
  assert.equal(r[0].rel, "src/components/Card.tsx");
  assert.deepEqual(r[0].at, [15, 16, 17, 18]);
});

test("runsOf splits a label into hit / plain runs", () => {
  assert.deepEqual(runsOf("page.tsx", [8, 9, 10, 11], 8), [{ text: "page", hit: true }, { text: ".tsx", hit: false }]);
  assert.deepEqual(runsOf("abc", []), [{ text: "abc", hit: false }]);
});

test("parseQuery: prefixes and file:line", () => {
  assert.deepEqual(parseQuery("> tab new"), { mode: "commands", text: "tab new" });
  assert.deepEqual(parseQuery("~ docker"), { mode: "plans", text: "docker" });
  assert.deepEqual(parseQuery("~"), { mode: "plans", text: "" });
  assert.deepEqual(parseQuery("@render"), { mode: "symbols", text: "render" });
  assert.deepEqual(parseQuery(":42"), { mode: "line", text: "", line: 42, col: null });
  assert.deepEqual(parseQuery(":12:5"), { mode: "line", text: "", line: 12, col: 5 });
  assert.deepEqual(parseQuery("page.tsx:30"), { mode: "files", text: "page.tsx", line: 30, col: null });
  assert.deepEqual(parseQuery("%TODO"), { mode: "text", text: "TODO" });
  assert.equal(parseQuery("?").mode, "help");
  assert.deepEqual(parseQuery("card"), { mode: "files", text: "card" });
});

test("symbolsOf: classes, functions, arrows, methods, types", () => {
  const src = [
    "export class Store {",
    "  async load(id: string): Promise<void> {",
    "    if (x) {",
    "  }",
    "}",
    "export interface Plan { name: string }",
    "export type Id = string;",
    "export function formatPrice(p: number) {",
    "export const total = (a: number) => a;",
    "const LIMIT = 5;",
    "def handler(event):",
    "## Install",
  ].join("\n");
  assert.deepEqual(symbolsOf(src).map((s) => [s.name, s.kind, s.line]), [
    ["Store", "class", 1], ["load", "method", 2], ["Plan", "interface", 6], ["Id", "type", 7],
    ["formatPrice", "function", 8], ["total", "function", 9], ["LIMIT", "variable", 10], ["handler", "function", 11], ["Install", "heading", 12],
  ]);
});

test("command and key labels", () => {
  assert.equal(commandLabel("tab.new"), "Tab: New");
  assert.equal(commandLabel("layout.toggle:sidebar"), "Layout: Toggle (sidebar)");
  assert.equal(commandLabel("app.zoom_in"), "App: Zoom In");
  assert.equal(keyLabel("cmd-shift-p"), "⇧⌘P");
  assert.equal(keyLabel("ctrl-alt-left"), "⌃⌥←");
  assert.equal(keyLabel("cmd--"), "⌘-");
  assert.equal(keyLabel("cmd-shift-p", false), "Ctrl+Shift+P");
});

test("actionToRun names the argument from the command list", () => {
  const list = [{ name: "tab.select", args: [{ name: "index", required: false }, { name: "id", required: false }] },
    { name: "pane.split", args: [{ name: "direction", required: true }] }, { name: "tab.new", args: [] }];
  assert.deepEqual(actionToRun("tab.select:3", list), { name: "tab.select", args: { index: 3 } });
  assert.deepEqual(actionToRun("pane.split:right", list), { name: "pane.split", args: { direction: "right" } });
  assert.equal(actionToRun("pane.split", list), null);
  assert.deepEqual(actionToRun("tab.new", list), { name: "tab.new", args: undefined });
  assert.deepEqual(actionToRun("vx-activity.search", list), { name: "vx-activity.search", args: undefined });
});
