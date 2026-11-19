import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newRequest, interpolate, missingVars, paramsFromUrl, urlWithParams, resolveRequest, curlArgs, bodyText, parseCurlInfo,
  parseHeaderBlocks, parseCookies, jsonPath, runTests, runCaptures, parseCurl, shellWords, toCurl, toFetch, toPython, toAxios, toHttpie,
  fromPostman, toPostman, upsertItem, removeItem, findItem, slugify, envVars, formatBytes, isJsonType, statusText,
} from "../shared/http-core.js";

const dyn = { $guid: "G", $timestamp: 1700000000, $isoTimestamp: "2023-11-14T22:13:20.000Z", $randomInt: 7 };

test("interpolate: env vars, dynamic vars, unknown names kept", () => {
  assert.equal(interpolate("{{base}}/u/{{ id }}?t={{$timestamp}}&x={{nope}}", { base: "https://a.io", id: 5 }, dyn), "https://a.io/u/5?t=1700000000&x={{nope}}");
  assert.deepEqual(missingVars("{{a}} {{b}} {{$guid}}", { a: 1 }), ["b"]);
});

test("params: from the URL and back, disabled rows left out", () => {
  const p = paramsFromUrl("https://x.io/s?q=a%20b&flag&n=1#top");
  assert.deepEqual(p.map((x) => [x.key, x.value]), [["q", "a b"], ["flag", ""], ["n", "1"]]);
  assert.equal(urlWithParams("https://x.io/s?old=1#top", [{ key: "q", value: "a b" }, { key: "off", value: "1", enabled: false }, { key: "v", value: "{{id}}" }]), "https://x.io/s?q=a%20b&v={{id}}#top");
  assert.equal(urlWithParams("https://x.io/s?a=1", []), "https://x.io/s");
});

test("resolveRequest: auth, api key in query, default content type, scheme added", () => {
  const r = resolveRequest(newRequest({
    method: "post", url: "{{host}}/items", params: [{ key: "a", value: "1" }],
    headers: [{ key: "X-Id", value: "{{id}}" }, { key: "Skip", value: "1", enabled: false }],
    body: { mode: "json", text: '{"n":"{{id}}"}' },
    auth: { type: "basic", username: "u", password: "p" },
  }), { host: "api.local:3000", id: "42" }, dyn);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "http://api.local:3000/items?a=1");
  assert.deepEqual(r.headers.map((h) => h.key), ["X-Id", "Authorization", "Content-Type"]);
  assert.equal(r.headers[1].value, "Basic dTpw");
  assert.equal(r.body.text, '{"n":"42"}');
  assert.equal(resolveRequest(newRequest({ url: "https://x.io/a?q=1&b=two" }), {}, dyn).url, "https://x.io/a?q=1&b=two");
  const k = resolveRequest(newRequest({ url: "https://x.io", auth: { type: "apikey", key: "api_key", value: "s", in: "query" } }), {}, dyn);
  assert.equal(k.url, "https://x.io?api_key=s");
});

test("resolveRequest: GraphQL body and a bad variables JSON", () => {
  const r = resolveRequest(newRequest({ method: "POST", url: "https://g.io", body: { mode: "graphql", graphql: { query: "query($id:ID){u(id:$id){n}}", variables: '{"id":"{{id}}"}' } } }), { id: "9" }, dyn);
  assert.deepEqual(JSON.parse(r.body.text), { query: "query($id:ID){u(id:$id){n}}", variables: { id: "9" } });
  assert.throws(() => resolveRequest(newRequest({ body: { mode: "graphql", graphql: { query: "q", variables: "{bad" } } }), {}, dyn), /GraphQL variables/);
});

test("curlArgs: body from a file, multipart, HEAD, settings", () => {
  const files = { body: "/t/b", headers: "/t/h", out: "/t/o" };
  const r = resolveRequest(newRequest({ method: "POST", url: "https://x.io", body: { mode: "json", text: "{}" }, settings: { timeout: 5, follow: false, insecure: true, http: "2" } }), {}, dyn);
  const a = curlArgs(r, files);
  assert.ok(a.includes("--data-binary") && a[a.indexOf("--data-binary") + 1] === "@/t/b");
  assert.ok(a.includes("-k") && a.includes("--http2") && !a.includes("-L"));
  assert.equal(a[a.indexOf("--max-time") + 1], "5");
  assert.equal(a[a.length - 1], "https://x.io");
  assert.equal(bodyText(r), "{}");
  const m = curlArgs(resolveRequest(newRequest({ method: "POST", url: "x.io", body: { mode: "multipart", multipart: [{ key: "f", value: "/tmp/a.png", type: "file" }, { key: "n", value: "@not-a-file" }] } }), {}, dyn), files);
  assert.ok(m.includes("f=@/tmp/a.png"));
  assert.equal(m[m.indexOf("n=@not-a-file") - 1], "--form-string");
  const h = curlArgs(resolveRequest(newRequest({ method: "HEAD", url: "x.io" }), {}, dyn), files);
  assert.ok(h.includes("-I") && !h.includes("-X"));
});

test("parseCurlInfo: status and timing breakdown", () => {
  const info = parseCurlInfo('{"http_code":201,"time_namelookup":0.01,"time_connect":0.03,"time_appconnect":0.08,"time_starttransfer":0.2,"time_total":0.25,"size_download":1234,"content_type":"application/json","num_redirects":1,"http_version":"2","exitcode":0}');
  assert.equal(info.status, 201);
  assert.deepEqual(info.timing, { dns: 10, connect: 20, tls: 50, wait: 120, download: 50, total: 250 });
  assert.equal(info.size, 1234);
  assert.equal(parseCurlInfo("garbage").status, 0);
});

test("parseHeaderBlocks: the last response after a redirect; cookies", () => {
  const h = parseHeaderBlocks("HTTP/1.1 302 Found\r\nLocation: /b\r\n\r\nHTTP/2 200 \r\ncontent-type: application/json\r\nset-cookie: sid=abc; Path=/; HttpOnly\r\n\r\n");
  assert.equal(h.status, 200);
  assert.deepEqual(h.chain, ["HTTP/1.1 302 Found", "HTTP/2 200"]);
  assert.equal(h.headers[0].value, "application/json");
  const c = parseCookies(h.headers);
  assert.deepEqual([c[0].name, c[0].value, c[0].path, c[0].httponly], ["sid", "abc", "/", true]);
});

test("jsonPath: keys, indexes, wildcard, deep, length, quoted", () => {
  const v = { data: { items: [{ id: 1, tags: ["a"] }, { id: 2 }], "a b": 3 }, id: 0 };
  assert.deepEqual(jsonPath(v, "$.data.items[1].id"), [2]);
  assert.deepEqual(jsonPath(v, "$.data.items[*].id"), [1, 2]);
  assert.deepEqual(jsonPath(v, "$..id"), [0, 1, 2]);
  assert.deepEqual(jsonPath(v, "$.data.items.length"), [2]);
  assert.deepEqual(jsonPath(v, "$.data['a b']"), [3]);
  assert.deepEqual(jsonPath(v, "data.items[-1].id"), [2]);
  assert.deepEqual(jsonPath(v, "$.nope.x"), []);
  assert.throws(() => jsonPath(v, "$.a[?(@.x)]"), /Can't read/);
});

test("runTests and runCaptures", () => {
  const res = { status: 200, time: 120, headers: [{ key: "Content-Type", value: "application/json" }], body: '{"token":"t1","n":3}', json: { token: "t1", n: 3, list: [1, 2] } };
  const results = runTests([
    { source: "status", op: "==", value: "200" },
    { source: "time", op: "<", value: "500" },
    { source: "header", path: "content-type", op: "contains", value: "json" },
    { source: "json", path: "$.n", op: ">=", value: "3" },
    { source: "json", path: "$.token", op: "matches", value: "^t\\d$" },
    { source: "json", path: "$.missing", op: "exists" },
    { source: "body", op: "contains", value: "nope" },
    { source: "json", path: "$.n", op: "==", value: "4", enabled: false },
  ], res);
  assert.deepEqual(results.map((r) => r.pass), [true, true, true, true, true, false, false]);
  assert.equal(results[0].label, "status == 200");
  assert.deepEqual(runCaptures([{ source: "json", path: "$.token", variable: "token" }, { source: "json", path: "$.list", variable: "list" }, { source: "json", path: "$.x", variable: "x" }], res), { token: "t1", list: "[1,2]" });
  assert.equal(runTests([{ source: "json", path: "$.a", op: "exists" }], { ...res, json: undefined })[0].message, "The response isn't JSON");
});

test("shellWords: quotes, escapes, $'…' and line continuations", () => {
  assert.deepEqual(shellWords(`curl -H 'A: b' \\\n  -d "x \\"y\\"" $'line\\nnext'`), ["curl", "-H", "A: b", "-d", 'x "y"', "line\nnext"]);
});

test("parseCurl: JSON POST from Chrome's Copy as cURL", () => {
  const r = parseCurl(`curl 'https://api.x.io/v1/users?page=2' -H 'content-type: application/json' -H 'authorization: Bearer abc' --data-raw '{"name":"a"}' --compressed`);
  assert.equal(r.method, "POST");
  assert.equal(r.url, "https://api.x.io/v1/users?page=2");
  assert.equal(r.body.mode, "json");
  assert.deepEqual(JSON.parse(r.body.text), { name: "a" });
  assert.deepEqual(r.headers.map((h) => h.key), ["authorization"]);
  assert.deepEqual(r.params.map((p) => [p.key, p.value]), [["page", "2"]]);
  assert.equal(r.name, "POST /v1/users");
});

test("parseCurl: form, multipart, user, -G, -X, --flag=value", () => {
  const f = parseCurl("curl -X PUT https://x.io/a -d a=1 -d b=two -u me:pw -k");
  assert.equal(f.method, "PUT");
  assert.equal(f.body.mode, "form");
  assert.deepEqual(f.body.form.map((x) => [x.key, x.value]), [["a", "1"], ["b", "two"]]);
  assert.deepEqual([f.auth.type, f.auth.username, f.auth.password, f.settings.insecure], ["basic", "me", "pw", true]);
  const m = parseCurl("curl https://x.io/up -F file=@/tmp/a.png -F note=hi");
  assert.equal(m.method, "POST");
  assert.deepEqual(m.body.multipart.map((x) => [x.key, x.value, x.type]), [["file", "/tmp/a.png", "file"], ["note", "hi", "text"]]);
  const g = parseCurl("curl -G https://x.io/s --data-urlencode 'q=a b' --request=GET");
  assert.equal(g.url, "https://x.io/s?q=a%20b");
  assert.equal(g.method, "GET");
  assert.throws(() => parseCurl("wget x"), /isn't a curl/);
});

test("code snippets", () => {
  const r = resolveRequest(newRequest({ method: "POST", url: "https://x.io/a", headers: [{ key: "X", value: "it's" }], body: { mode: "json", text: '{"a":1}' } }), {}, dyn);
  assert.match(toCurl(r), /curl -X POST 'https:\/\/x.io\/a' \\\n  -H 'X: it'\\''s'/);
  assert.match(toFetch(r), /JSON\.stringify\(\{\n {4}"a": 1\n {2}\}\)/);
  assert.match(toPython(r), /requests\.request\(\n {4}"POST",/);
  assert.match(toAxios(r), /method: "post"/);
  assert.match(toHttpie(r), /\| http POST/);
  // A cURL export imports back to the same request.
  const back = parseCurl(toCurl(r));
  assert.equal(back.url, "https://x.io/a");
  assert.deepEqual(JSON.parse(back.body.text), { a: 1 });
});

test("Postman v2.1: import folders, bodies, auth; export round-trips", () => {
  const pm = {
    info: { name: "Demo", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    variable: [{ key: "base", value: "https://x.io" }],
    item: [
      { name: "Users", item: [{ name: "List", request: { method: "GET", url: { raw: "{{base}}/users?limit=5", query: [{ key: "limit", value: "5" }] }, header: [{ key: "Accept", value: "application/json" }] } }] },
      { name: "Create", request: { method: "POST", url: "{{base}}/users", body: { mode: "raw", raw: '{"n":1}', options: { raw: { language: "json" } } }, auth: { type: "bearer", bearer: [{ key: "token", value: "{{tok}}" }] } } },
      { name: "Upload", request: { method: "POST", url: "{{base}}/f", body: { mode: "formdata", formdata: [{ key: "f", type: "file", src: "/a.txt" }, { key: "n", value: "x", type: "text" }] } } },
    ],
  };
  const { collection, variables } = fromPostman(pm);
  assert.equal(collection.name, "Demo");
  assert.deepEqual(variables, { base: "https://x.io" });
  assert.equal(collection.items[0].folder, true);
  assert.equal(collection.items[0].items[0].params[0].key, "limit");
  assert.deepEqual([collection.items[1].body.mode, collection.items[1].auth.type, collection.items[1].auth.token], ["json", "bearer", "{{tok}}"]);
  assert.deepEqual(collection.items[2].body.multipart.map((x) => x.type), ["file", "text"]);
  const again = fromPostman(toPostman(collection)).collection;
  assert.equal(again.items[1].body.text, '{"n":1}');
  assert.equal(again.items[0].items[0].name, "List");
  assert.throws(() => fromPostman({ foo: 1 }), /Postman/);
});

test("collection items: find, upsert into a folder, remove", () => {
  const a = newRequest({ id: "a" }), b = newRequest({ id: "b" });
  let items = [{ id: "f", folder: true, name: "F", items: [a] }];
  items = upsertItem(items, { ...a, name: "renamed" });
  assert.equal(findItem(items, "a").name, "renamed");
  items = upsertItem(items, b);
  assert.equal(items.length, 2);
  items = removeItem(items, "a");
  assert.equal(findItem(items, "a"), null);
});

test("helpers: slugify, envVars, formatBytes, isJsonType, statusText", () => {
  assert.equal(slugify("My API — v2!"), "my-api-v2");
  assert.deepEqual(envVars({ envs: { dev: { a: "1", s: "pub" } } }, { envs: { dev: { s: "secret" } } }, "dev"), { a: "1", s: "secret" });
  assert.deepEqual(envVars({}, {}, null), {});
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(isJsonType("application/problem+json; charset=utf-8"), true);
  assert.equal(statusText(404), "Not Found");
});
