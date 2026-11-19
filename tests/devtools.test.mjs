import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  TOOLS, toolById, defaultOptions, detect, searchTools, md5, decodeJwt, signJwt, parseJsonAt, parseCron, cronNext, describeCron, parseColor,
  rgbToHsl, words, CASES, jsonToTs, jsonToZod, csvToJson, jsonToCsv, formatXml, formatSql, envToJson, jsonToEnv, uuidV4, uuidV7, ulid, nanoid,
  inspectUuid, password, diffLines, regexTest, textStats, lineTool, parseNumber, parseBytes, chmod, cidr, parseUrl, parseUserAgent, parseMoment, relative,
} from "../shared/devtools-core.js";

const run = async (id, input, options = {}) => {
  const t = toolById(id);
  return t.run(typeof input === "string" ? { in: input } : input, { ...defaultOptions(t), ...options });
};
// Runs an exec tool for real (the programs it needs are on any Mac this suite targets).
const runExec = (id, input, options = {}) => {
  const t = toolById(id);
  const e = t.exec(typeof input === "string" ? { in: input } : input, { ...defaultOptions(t), ...options });
  try {
    const out = execFileSync(e.cmd, e.args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return e.parse(out, "", 0);
  } catch (err) {
    return e.parse(err.stdout ?? "", err.stderr ?? "", err.status ?? 1);
  }
};

test("registry: unique ids, every tool runs or execs, groups known", () => {
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TOOLS) assert.ok(t.run || t.exec, t.id);
  assert.ok(TOOLS.length >= 45);
  assert.ok(searchTools("sha").some((t) => t.id === "hash"));
});

test("hashes: MD5 and SHA vectors", async () => {
  assert.equal(md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(md5("The quick brown fox jumps over the lazy dog"), "9e107d9d372bb6826bd81d3542a419d6");
  const r = await run("hash", "abc");
  const by = Object.fromEntries(r.rows.map((x) => [x.label, x.value]));
  assert.equal(by["SHA-256"], "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(by["SHA-1"], "a9993e364706816aba3e25717850c26c9cd0d89d");
  const h = await run("hmac", { in: "The quick brown fox jumps over the lazy dog", secret: "key" });
  assert.equal(h.text, "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
});

test("encode: base64 (UTF-8, url-safe), url, query, html, escape, hex, binary", async () => {
  assert.equal((await run("base64", "héllo ✓")).text, "aMOpbGxvIOKckw==");
  assert.equal((await run("base64", "aMOpbGxvIOKckw==", { mode: "decode" })).text, "héllo ✓");
  assert.equal((await run("base64", "a?b>", { variant: "url-safe" })).text, "YT9iPg");
  assert.ok((await run("base64", "@@@", { mode: "decode" })).error);
  assert.equal((await run("url", "a b&c")).text, "a%20b%26c");
  assert.equal((await run("url", "a+b%20c", { mode: "decode" })).text, "a b c");
  assert.deepEqual(JSON.parse((await run("query", "https://x.io/?a=1&b=2&a=3")).text), { a: ["1", "3"], b: "2" });
  assert.equal((await run("query", '{"q":"a b","n":[1,2]}', { mode: "JSON → query" })).text, "q=a+b&n=1&n=2");
  assert.equal((await run("html", "<a href=\"x\">")).text, "&lt;a href=&quot;x&quot;&gt;");
  assert.equal((await run("html", "&lt;b&gt; &#x41;&#66; &copy;", { mode: "decode" })).text, "<b> AB ©");
  assert.equal((await run("escape", 'a "b"\n')).text, 'a \\"b\\"\\n');
  assert.equal((await run("escape", 'a \\"b\\"\\n', { mode: "unescape" })).text, 'a "b"\n');
  assert.equal((await run("hex", "Hi")).text, "48 69");
  assert.equal((await run("hex", "48:69", { mode: "hex → text" })).text, "Hi");
  assert.equal((await run("binary", "A")).text, "01000001");
  assert.equal((await run("binary", "01000001", { mode: "binary → text" })).text, "A");
});

test("JWT: sign, decode, verify, expiry", async () => {
  const token = await signJwt('{"sub":"1","exp":1}', "s3cret");
  const j = decodeJwt(token);
  assert.equal(j.header.alg, "HS256");
  assert.equal(j.payload.sub, "1");
  const good = await run("jwt", { in: token, secret: "s3cret" });
  const rowsOf = (r) => Object.fromEntries(r.rows.map((x) => [x.label, x.value]));
  assert.match(rowsOf(good).signature, /valid/);
  assert.match(rowsOf(good).expires, /EXPIRED/);
  assert.match(rowsOf(await run("jwt", { in: token, secret: "nope" })).signature, /NOT/);
  assert.ok((await run("jwt", "not.a")).error);
});

test("format: JSON errors with a place, sort keys, TS, Zod, CSV, XML, SQL, env", async () => {
  assert.throws(() => parseJsonAt('{\n  "a": 1,\n}'), /line 3/);
  assert.equal((await run("json", '{"b":1,"a":{"d":1,"c":2}}', { mode: "sort keys" })).text, '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}');
  assert.equal((await run("json", '{ "a" : [1, 2] }', { mode: "minify" })).text, '{"a":[1,2]}');
  assert.match(jsonToTs({ id: 1, user: { name: "a" }, tags: ["x"] }), /export interface User \{\n {2}name: string;\n\}[\s\S]*export interface Root \{\n {2}id: number;\n {2}user: User;\n {2}tags: string\[\];/);
  assert.match(jsonToZod({ id: 1, ok: true }), /id: z\.number\(\)\.int\(\),\n {2}ok: z\.boolean\(\)/);
  assert.deepEqual(csvToJson('name,age\n"Doe, J",42\nA,x'), [{ name: "Doe, J", age: 42 }, { name: "A", age: "x" }]);
  assert.equal(jsonToCsv([{ a: 1, b: "x,y" }, { a: 2 }]), 'a,b\n1,"x,y"\n2,');
  assert.equal(formatXml("<a><b>1</b><c/></a>"), "<a>\n  <b>1</b>\n  <c/>\n</a>");
  assert.match(formatSql("select a, b from t where x = 1 and y = 2 order by a"), /^SELECT\n {2}a,\n {2}b\nFROM t\nWHERE x = 1\n {2}AND y = 2\nORDER BY a$/);
  assert.deepEqual(envToJson('# c\nA=1\nexport B="x y"\nC=\'z\' \nD=e # note'), { A: "1", B: "x y", C: "z", D: "e" });
  assert.equal(jsonToEnv({ A: "1", B: "x y" }), 'A=1\nB="x y"');
});

// The programs some tools run; a machine without one skips its checks (CI runners vary).
const has = (cmd) => {
  try {
    execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("exec tools: YAML (ruby)", { skip: !has("ruby") }, () => {
  assert.match(runExec("yaml", '{"a":[1,2],"b":"x"}').text, /^a:\n- 1\n- 2\nb: x/);
  assert.deepEqual(JSON.parse(runExec("yaml", "a: 1\nb: [x]", { mode: "YAML → JSON" }).text), { a: 1, b: ["x"] });
  assert.ok(runExec("yaml", "{bad", { mode: "JSON → YAML" }).error);
});

test("exec tools: jq", { skip: !has("jq") }, () => {
  assert.equal(runExec("jq", { filter: ".a[1]", in: '{"a":[5,6]}' }).text, "6");
  assert.ok(runExec("jq", { filter: ".a[", in: "{}" }).error);
});

test("exec tools: bcrypt (htpasswd)", { skip: !has("htpasswd") }, () => {
  const hash = runExec("bcrypt", { in: "pw" }, { cost: "8" }).text;
  assert.match(hash, /^\$2y\$08\$/);
  assert.match(runExec("bcrypt", { in: "pw", hash }).text, /matches/);
  assert.match(runExec("bcrypt", { in: "nope", hash }).text, /not match/);
});

test("generate: ids, password, lorem, fake data", async () => {
  assert.match(uuidV4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const v7 = uuidV7(1700000000000);
  assert.match(v7, /^[0-9a-f]{8}-[0-9a-f]{4}-7/);
  assert.equal(inspectUuid(v7).time, "2023-11-14T22:13:20.000Z");
  assert.equal(ulid().length, 26);
  assert.equal(nanoid().length, 21);
  const pw = password(24);
  assert.equal(pw.length, 24);
  assert.match(pw, /[a-z]/);
  assert.match(pw, /[A-Z]/);
  assert.match(pw, /\d/);
  assert.equal((await run("uuid", { in: "" }, { count: "5" })).text.split("\n").length, 5);
  assert.equal(JSON.parse((await run("fake", {}, { count: "3" })).text).length, 3);
  assert.match((await run("lorem", {}, { count: "1", unit: "sentences" })).text, /\.$/);
});

test("convert: timestamps, number bases, colour, case, bytes, rem, chmod, cron", async () => {
  assert.equal(parseMoment("1700000000").toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(parseMoment("1700000000000").toISOString(), "2023-11-14T22:13:20.000Z");
  assert.equal(relative(0, 3 * 3600 * 1000), "3 hours ago");
  assert.equal(parseNumber("0xff"), 255n);
  assert.deepEqual(Object.fromEntries((await run("base", "-10")).rows.map((r) => [r.label, r.value])).hex, "-0xa");
  assert.deepEqual(parseColor("#8143FD"), { r: 129, g: 67, b: 253, a: 1 });
  assert.deepEqual(parseColor("hsl(0 100% 50%)"), { r: 255, g: 0, b: 0, a: 1 });
  assert.deepEqual(rgbToHsl(129, 67, 253), [260, 98, 63]);
  const col = await run("color", "#8143fd");
  assert.equal(col.swatch, "#8143fd");
  assert.deepEqual(words("userAccountID_v2-thing"), ["user", "Account", "ID", "v2", "thing"]);
  assert.equal(CASES.snake(words("UserAccountId")), "user_account_id");
  assert.equal(CASES.camel(words("user-account id")), "userAccountId");
  assert.equal(parseBytes("1.5 KiB"), 1536);
  assert.equal(parseBytes("2 GB"), 2e9);
  assert.equal(chmod("755").symbolic, "rwxr-xr-x");
  assert.equal(chmod("rw-r--r--").octal, "644");
  assert.throws(() => chmod("999"));
  assert.match(describeCron("*/15 9-17 * * 1-5"), /^Every 15 minutes.*on Monday, Tuesday, Wednesday, Thursday, Friday/);
  assert.equal(describeCron("30 8 * * *"), "At 08:30");
  const next = cronNext("0 9 * * 1", new Date(2026, 10, 19, 10, 0));
  assert.equal(next[0].getDay(), 1);
  assert.equal(next[0].getHours(), 9);
  assert.throws(() => parseCron("* * *"), /5 fields/);
  assert.throws(() => parseCron("61 * * * *"), /out of range/);
  const rem = Object.fromEntries((await run("rem", { in: "24px", base: "16" })).rows.map((r) => [r.label, r.value]));
  assert.equal(rem.rem, "1.5rem");
});

test("text: diff, regex, stats, lines", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nc\nd").map((d) => d.op + d.text), [" a", "-b", " c", "+d"]);
  const r = regexTest("(\\w+)@(\\w+)", "g", "a@b x c@d", "$2@$1");
  assert.equal(r.matches.length, 2);
  assert.deepEqual(r.matches[1].groups, ["c", "d"]);
  assert.equal(r.replaced, "b@a x d@c");
  assert.throws(() => regexTest("(", "g", "x"));
  const s = textStats("Hi there. Bye!\n\nNew para ✓");
  assert.equal(s.words, 5);
  assert.equal(s.sentences, 2);
  assert.equal(s.paragraphs, 2);
  assert.equal(lineTool("b\na\nb", "unique"), "b\na");
  assert.equal(lineTool("10\n9\n100", "sort numeric"), "9\n10\n100");
});

test("network: CIDR, URL, user agent", () => {
  const c = cidr("192.168.1.77/26");
  assert.equal(c.network, "192.168.1.64/26");
  assert.equal(c.broadcast, "192.168.1.127");
  assert.equal(c["first host"], "192.168.1.65");
  assert.equal(c.hosts, "62");
  assert.match(c.private, /^yes/);
  assert.equal(cidr("10.0.0.5/32").hosts, "1");
  assert.throws(() => cidr("300.1.1.1/8"));
  const u = Object.fromEntries(parseUrl("https://a.io:8443/p%20q?x=1#h").map((r) => [r.label, r.value]));
  assert.deepEqual([u.host, u.port, u.path, u["?x"], u.hash], ["a.io", "8443", "/p q", "1", "h"]);
  const ua = parseUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
  assert.equal(ua.browser, "Chrome 131.0.0.0");
  assert.equal(ua.os, "macOS 10.15.7");
});

test("detect: what pasted text looks like", () => {
  const ids = (s) => detect(s).map((d) => d.tool);
  assert.deepEqual(ids("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc").slice(0, 1), ["jwt"]);
  assert.ok(ids("1700000000").includes("timestamp"));
  assert.ok(ids("#8143FD").includes("color"));
  assert.ok(ids("*/5 * * * *").includes("cron"));
  assert.ok(ids('{"a":1}').includes("json"));
  assert.ok(ids("aGVsbG8gd29ybGQ=").includes("base64"));
  assert.ok(ids("10.0.0.0/8").includes("cidr"));
  assert.ok(ids("https://x.io/a?b=1").includes("urlparse"));
  assert.ok(ids("curl https://x.io").includes("curl"));
  assert.ok(ids("hello").includes("hash"));
  assert.deepEqual(detect(""), []);
});

test("pure hashes match Node's crypto", async () => {
  const { createHash, createHmac } = await import("node:crypto");
  const { digestBytes, hmacBytes } = await import("../shared/devtools-core.js");
  const hexOf = (b) => Buffer.from(b).toString("hex");
  for (const msg of ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(119), "héllo ✓".repeat(40)]) {
    const bytes = new Uint8Array(Buffer.from(msg, "utf8"));
    for (const [alg, node] of [["SHA-1", "sha1"], ["SHA-256", "sha256"], ["SHA-384", "sha384"], ["SHA-512", "sha512"]]) {
      assert.equal(hexOf(digestBytes(alg, bytes)), createHash(node).update(msg).digest("hex"), `${alg} of ${msg.length} chars`);
      assert.equal(hexOf(hmacBytes(alg, new Uint8Array(Buffer.from("k".repeat(150))), bytes)), createHmac(node, "k".repeat(150)).update(msg).digest("hex"), `HMAC ${alg}`);
    }
  }
});
