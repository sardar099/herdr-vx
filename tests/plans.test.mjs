import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlanList, planTitle, isLive, changedPlans, matchPlan, LIVE_MS } from "../shared/plans-core.js";

test("parsePlanList: newest first, ignores junk lines", () => {
  const out = parsePlanList("1700000000/120/old-plan.md\nnot a line\n1700000500/9/new plan.md\n1700000500/3/a.md\n");
  assert.deepEqual(out.map((p) => p.name), ["a.md", "new plan.md", "old-plan.md"]);
  assert.equal(out[2].at, 1700000000000);
  assert.equal(out[1].size, 9);
});

test("parsePlanList: empty output", () => {
  assert.deepEqual(parsePlanList(""), []);
  assert.deepEqual(parsePlanList(undefined), []);
});

test("planTitle: first heading of any level, markup stripped", () => {
  assert.equal(planTitle("intro\n\n## **Fix** the `login` flow ##\n# later", "x.md"), "Fix the login flow");
  assert.equal(planTitle("# vx suite: Docker\n", "x.md"), "vx suite: Docker");
});

test("planTitle: falls back to a readable file name", () => {
  assert.equal(planTitle("no headings here", "foamy-wibbling-treasure.md"), "foamy wibbling treasure");
  assert.equal(planTitle("", ""), "Untitled plan");
  assert.equal(planTitle("#nospace", "a_b.md"), "a b");
});

test("isLive: only within the live window", () => {
  const now = 10_000_000;
  assert.equal(isLive({ at: now - 1000 }, now), true);
  assert.equal(isLive({ at: now - LIVE_MS - 1 }, now), false);
});

test("changedPlans: new and newer files only", () => {
  const before = [{ name: "a.md", at: 1 }, { name: "b.md", at: 5 }];
  const after = [{ name: "a.md", at: 2 }, { name: "b.md", at: 5 }, { name: "c.md", at: 1 }];
  assert.deepEqual(changedPlans(before, after).map((p) => p.name), ["a.md", "c.md"]);
  assert.equal(changedPlans(null, after).length, 3);
});

test("matchPlan: title or file name, case-insensitive", () => {
  const p = { name: "foamy.md", title: "Docker panel" };
  assert.equal(matchPlan(p, "docker"), true);
  assert.equal(matchPlan(p, "FOAMY"), true);
  assert.equal(matchPlan(p, "http"), false);
  assert.equal(matchPlan(p, " "), true);
});
