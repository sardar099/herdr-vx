// The HTTP client's logic (vx-http): requests, variables, the curl command that sends them, the
// response curl reports, tests and captures, cURL / Postman import and export, code snippets.
// Pure: no herdr imports, so node tests can load it.

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
export const BODY_MODES = ["none", "json", "text", "xml", "form", "multipart", "graphql", "binary"];
export const AUTH_TYPES = ["none", "basic", "bearer", "apikey", "oauth2cc"];
export const TEST_SOURCES = ["status", "header", "json", "body", "time"];
export const TEST_OPS = ["==", "!=", ">", "<", ">=", "<=", "contains", "!contains", "matches", "exists", "!exists"];

const uid = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const newId = uid;

export function newRequest(over = {}) {
  return {
    id: uid(), name: "New Request", method: "GET", url: "",
    params: [], headers: [],
    body: { mode: "none", text: "", form: [], multipart: [], file: "", graphql: { query: "", variables: "" } },
    auth: { type: "none" },
    tests: [], captures: [],
    settings: { timeout: 30, follow: true, insecure: false, http: "auto" },
    ...over,
  };
}

// ── variables ──────────────────────────────────────────────────────────────────────────
// {{name}} from the environment (and captures); {{$guid}}, {{$timestamp}}, {{$isoTimestamp}},
// {{$randomInt}} like Postman. Unknown names stay as written, so they're easy to spot.
export function interpolate(text, vars = {}, dyn = dynamicValues()) {
  return String(text ?? "").replace(/\{\{\s*([$\w.-]+)\s*\}\}/g, (all, name) => {
    if (name.startsWith("$")) return dyn[name] !== undefined ? String(dyn[name]) : all;
    return Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null ? String(vars[name]) : all;
  });
}

export function dynamicValues(now = Date.now(), uuid = () => fakeUuid()) {
  return { $guid: uuid(), $uuid: uuid(), $timestamp: Math.floor(now / 1000), $isoTimestamp: new Date(now).toISOString(), $randomInt: Math.floor(Math.random() * 1001) };
}

function fakeUuid() {
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => (c === "x" ? h() : ((8 + Math.floor(Math.random() * 4)).toString(16))));
}

// Names a text uses that the variables don't define (for a warning under the URL).
export function missingVars(text, vars = {}) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) if (!Object.prototype.hasOwnProperty.call(vars, m[1])) out.add(m[1]);
  return [...out];
}

// ── URL and query params (two-way) ─────────────────────────────────────────────────────
const enc = (s) => encodeURIComponent(s).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
const dec = (s) => {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch {
    return s;
  }
};

export function paramsFromUrl(url) {
  const s = String(url ?? "");
  const q = s.indexOf("?");
  if (q < 0) return [];
  const query = s.slice(q + 1).split("#")[0];
  return query.split("&").filter(Boolean).map((pair) => {
    const i = pair.indexOf("=");
    return { key: dec(i < 0 ? pair : pair.slice(0, i)), value: i < 0 ? "" : dec(pair.slice(i + 1)), enabled: true };
  });
}

export function urlWithParams(url, params) {
  const s = String(url ?? "");
  const hash = s.includes("#") ? s.slice(s.indexOf("#")) : "";
  const base = s.split("#")[0].split("?")[0];
  const on = (params ?? []).filter((p) => p.enabled !== false && p.key !== "");
  if (!on.length) return base + hash;
  return `${base}?${on.map((p) => (p.value === "" ? enc(p.key) : `${enc(p.key)}=${enc(p.value)}`)).join("&")}${hash}`;
}

// Params edited in the table keep their disabled rows; the URL holds only enabled ones.
export function mergeParams(fromUrl, previous) {
  const disabled = (previous ?? []).filter((p) => p.enabled === false);
  return [...fromUrl, ...disabled];
}

// ── building the request ───────────────────────────────────────────────────────────────
const enabled = (rows) => (rows ?? []).filter((r) => r.enabled !== false && String(r.key ?? "").trim() !== "");
const hasHeader = (headers, name) => headers.some((h) => h.key.toLowerCase() === name.toLowerCase());

export function base64(text) {
  if (typeof Buffer !== "undefined") return Buffer.from(String(text), "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(String(text))));
}

// The request with variables filled in and auth turned into headers or params: what goes out.
export function resolveRequest(req, vars = {}, dyn = dynamicValues()) {
  const v = (s) => interpolate(s, vars, dyn);
  // No params rows yet (a request written by hand, or from history): the URL's own query counts.
  const rows = (req.params ?? []).length ? req.params : paramsFromUrl(req.url);
  const params = enabled(rows).map((p) => ({ key: v(p.key), value: v(p.value) }));
  const headers = enabled(req.headers).map((h) => ({ key: v(h.key), value: v(h.value) }));
  const a = req.auth ?? { type: "none" };
  if (a.type === "basic") headers.push({ key: "Authorization", value: `Basic ${base64(`${v(a.username ?? "")}:${v(a.password ?? "")}`)}` });
  if (a.type === "bearer" && a.token) headers.push({ key: "Authorization", value: `Bearer ${v(a.token)}` });
  if (a.type === "oauth2cc" && a.accessToken) headers.push({ key: "Authorization", value: `Bearer ${v(a.accessToken)}` });
  if (a.type === "apikey" && a.key) {
    if (a.in === "query") params.push({ key: v(a.key), value: v(a.value ?? "") });
    else headers.push({ key: v(a.key), value: v(a.value ?? "") });
  }
  let url = v(req.url).trim();
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = urlWithParams(url, params.map((p) => ({ ...p, enabled: true })));
  const b = req.body ?? { mode: "none" };
  const body = { mode: b.mode ?? "none" };
  if (["json", "text", "xml"].includes(body.mode)) body.text = v(b.text ?? "");
  if (body.mode === "form") body.form = enabled(b.form).map((f) => ({ key: v(f.key), value: v(f.value) }));
  if (body.mode === "multipart") body.multipart = enabled(b.multipart).map((f) => ({ key: v(f.key), value: v(f.value), type: f.type === "file" ? "file" : "text" }));
  if (body.mode === "binary") body.file = v(b.file ?? "");
  if (body.mode === "graphql") {
    let variables = {};
    const raw = v(b.graphql?.variables ?? "").trim();
    if (raw) {
      try {
        variables = JSON.parse(raw);
      } catch {
        throw new Error("GraphQL variables aren't valid JSON");
      }
    }
    body.text = JSON.stringify({ query: v(b.graphql?.query ?? ""), variables });
  }
  const ct = { json: "application/json", graphql: "application/json", xml: "application/xml", text: "text/plain", form: "application/x-www-form-urlencoded", binary: "application/octet-stream" }[body.mode];
  if (ct && !hasHeader(headers, "content-type")) headers.push({ key: "Content-Type", value: ct });
  return { method: (req.method ?? "GET").toUpperCase(), url, headers, body, settings: { timeout: 30, follow: true, insecure: false, http: "auto", ...(req.settings ?? {}) } };
}

// curl's arguments for a resolved request. files: { body, headers, out } paths the caller owns;
// the body text (when there is one) must be written to files.body first: never on the
// command line, so secrets don't show in `ps`.
export function curlArgs(r, files) {
  const args = ["-sS", "--globoff", "-X", r.method, "-D", files.headers, "-o", files.out, "-w", "%{json}"];
  const s = r.settings ?? {};
  args.push("--max-time", String(Math.max(1, Number(s.timeout) || 30)));
  if (s.follow !== false) args.push("-L", "--max-redirs", "10");
  if (s.insecure) args.push("-k");
  if (s.http === "1.1") args.push("--http1.1");
  if (s.http === "2") args.push("--http2");
  args.push("--compressed");
  for (const h of r.headers) args.push("-H", `${h.key}: ${h.value}`);
  const b = r.body ?? {};
  if (b.mode === "form") for (const f of b.form ?? []) args.push("--data-urlencode", `${f.key}=${f.value}`);
  else if (b.mode === "multipart") for (const f of b.multipart ?? []) args.push(f.type === "file" ? "-F" : "--form-string", f.type === "file" ? `${f.key}=@${f.value}` : `${f.key}=${f.value}`);
  else if (b.mode === "binary" && b.file) args.push("--data-binary", `@${b.file}`);
  else if (b.text !== undefined && b.mode !== "none") args.push("--data-binary", `@${files.body}`);
  if (r.method === "HEAD") args.splice(args.indexOf("-X"), 2, "-I");
  args.push("--url", r.url);
  return args;
}

// The text that goes into files.body (or null when the body isn't a text body).
export const bodyText = (r) => (["json", "text", "xml", "graphql"].includes(r.body?.mode) ? r.body.text ?? "" : null);

// ── the response ───────────────────────────────────────────────────────────────────────
// curl -w '%{json}': status, sizes and the timing breakdown in ms.
export function parseCurlInfo(stdout) {
  let j = {};
  try {
    j = JSON.parse(String(stdout ?? "").trim().split("\n").pop() || "{}");
  } catch {}
  const ms = (x) => (typeof x === "number" ? Math.round(x * 1000) : null);
  const t = { dns: ms(j.time_namelookup), connect: ms(j.time_connect), tls: ms(j.time_appconnect), ttfb: ms(j.time_starttransfer), total: ms(j.time_total), redirect: ms(j.time_redirect) };
  return {
    status: Number(j.http_code ?? j.response_code ?? 0),
    httpVersion: j.http_version ? String(j.http_version) : null,
    size: typeof j.size_download === "number" ? j.size_download : null,
    contentType: j.content_type ?? null,
    url: j.url_effective ?? null,
    redirects: Number(j.num_redirects ?? 0),
    remoteIp: j.remote_ip ?? null,
    error: j.errormsg ?? null,
    exitcode: Number(j.exitcode ?? 0),
    timing: {
      dns: t.dns,
      connect: t.connect !== null && t.dns !== null ? Math.max(0, t.connect - t.dns) : t.connect,
      tls: t.tls ? Math.max(0, t.tls - (t.connect ?? 0)) : 0,
      wait: t.ttfb !== null ? Math.max(0, t.ttfb - Math.max(t.tls || 0, t.connect ?? 0)) : null,
      download: t.total !== null && t.ttfb !== null ? Math.max(0, t.total - t.ttfb) : null,
      total: t.total,
    },
  };
}

// The headers curl -D wrote: one block per response (redirects, 100 Continue); the last counts.
export function parseHeaderBlocks(text) {
  const blocks = String(text ?? "").replace(/\r/g, "").split(/\n\n+/).map((b) => b.trim()).filter((b) => /^HTTP\//.test(b));
  const last = blocks[blocks.length - 1] ?? "";
  const [statusLine = "", ...rest] = last.split("\n");
  const headers = [];
  for (const line of rest) {
    const i = line.indexOf(":");
    if (i > 0) headers.push({ key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() });
  }
  const m = /^HTTP\/[\d.]+\s+(\d+)\s*(.*)$/.exec(statusLine);
  return { statusLine, status: m ? Number(m[1]) : 0, reason: m ? m[2] : "", headers, chain: blocks.map((b) => b.split("\n")[0].trim()) };
}

export function parseCookies(headers) {
  return (headers ?? []).filter((h) => h.key.toLowerCase() === "set-cookie").map((h) => {
    const [pair, ...attrs] = h.value.split(";").map((s) => s.trim());
    const i = pair.indexOf("=");
    const c = { name: i < 0 ? pair : pair.slice(0, i), value: i < 0 ? "" : pair.slice(i + 1) };
    for (const a of attrs) {
      const j = a.indexOf("=");
      const k = (j < 0 ? a : a.slice(0, j)).toLowerCase();
      c[k] = j < 0 ? true : a.slice(j + 1);
    }
    return c;
  });
}

export const headerValue = (headers, name) => (headers ?? []).find((h) => h.key.toLowerCase() === String(name).toLowerCase())?.value ?? null;

export function statusText(code) {
  return STATUS[code] ?? "";
}
export const STATUS = {
  100: "Continue", 101: "Switching Protocols", 200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content",
  301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
  400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed",
  406: "Not Acceptable", 408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed",
  413: "Payload Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 418: "I'm a teapot", 422: "Unprocessable Entity",
  423: "Locked", 425: "Too Early", 426: "Upgrade Required", 428: "Precondition Required", 429: "Too Many Requests",
  431: "Request Header Fields Too Large", 451: "Unavailable For Legal Reasons", 500: "Internal Server Error", 501: "Not Implemented",
  502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout", 505: "HTTP Version Not Supported",
};

export function formatBytes(n) {
  if (n === null || n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const isJsonType = (ct) => /[/+]json\b/i.test(String(ct ?? ""));

// ── JSONPath (the common subset) ───────────────────────────────────────────────────────
// $.a.b, $.a[0], $['a b'], $.list[*].id, $..id (deep), $.list.length. Returns all matches.
export function jsonPath(value, path) {
  const p = String(path ?? "").trim();
  if (!p || p === "$") return [value];
  const tokens = [];
  const re = /\.\.([A-Za-z_$][\w$-]*|\*)|\.([A-Za-z_$][\w$-]*|\*)|\[\s*(-?\d+)\s*\]|\[\s*\*\s*\]|\[\s*'([^']*)'\s*\]|\[\s*"([^"]*)"\s*\]/g;
  let rest = p.startsWith("$") ? p.slice(1) : p.startsWith(".") || p.startsWith("[") ? p : `.${p}`;
  let m;
  let at = 0;
  while ((m = re.exec(rest))) {
    if (m.index !== at) throw new Error(`Can't read the path at "${rest.slice(at)}"`);
    at = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ deep: true, key: m[1] });
    else if (m[2] !== undefined) tokens.push({ key: m[2] });
    else if (m[3] !== undefined) tokens.push({ index: Number(m[3]) });
    else if (m[4] !== undefined) tokens.push({ key: m[4] });
    else if (m[5] !== undefined) tokens.push({ key: m[5] });
    else tokens.push({ key: "*" });
  }
  if (at !== rest.length) throw new Error(`Can't read the path at "${rest.slice(at)}"`);
  let cur = [value];
  for (const tk of tokens) {
    const next = [];
    for (const v of cur) {
      if (tk.deep) {
        const walk = (x) => {
          if (x && typeof x === "object") {
            if (tk.key === "*") next.push(...Object.values(x));
            else if (Object.prototype.hasOwnProperty.call(x, tk.key)) next.push(x[tk.key]);
            for (const c of Object.values(x)) walk(c);
          }
        };
        walk(v);
      } else if (tk.index !== undefined) {
        if (Array.isArray(v)) {
          const i = tk.index < 0 ? v.length + tk.index : tk.index;
          if (i >= 0 && i < v.length) next.push(v[i]);
        }
      } else if (tk.key === "*") {
        if (v && typeof v === "object") next.push(...Object.values(v));
      } else if (tk.key === "length" && (Array.isArray(v) || typeof v === "string")) next.push(v.length);
      else if (v && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, tk.key)) next.push(v[tk.key]);
    }
    cur = next;
  }
  return cur;
}

// ── tests and captures ─────────────────────────────────────────────────────────────────
// res = { status, headers, body (text), json (parsed or undefined), time (ms) }
function sourceValue(res, source, path) {
  switch (source) {
    case "status": return { found: true, value: res.status };
    case "time": return { found: res.time !== null && res.time !== undefined, value: res.time };
    case "header": {
      const v = headerValue(res.headers, path);
      return { found: v !== null, value: v };
    }
    case "body": return { found: true, value: res.body ?? "" };
    case "json": {
      if (res.json === undefined) return { found: false, value: undefined, error: "The response isn't JSON" };
      try {
        const hits = jsonPath(res.json, path || "$");
        return { found: hits.length > 0, value: hits.length === 1 ? hits[0] : hits.length ? hits : undefined };
      } catch (e) {
        return { found: false, value: undefined, error: String(e.message ?? e) };
      }
    }
  }
  return { found: false, value: undefined, error: `Unknown source ${source}` };
}

const asText = (v) => (v === undefined ? "undefined" : typeof v === "string" ? v : JSON.stringify(v));
const num = (v) => (typeof v === "number" ? v : v !== null && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : NaN);

export function runTest(t, res) {
  const got = sourceValue(res, t.source, t.path);
  const want = t.value ?? "";
  if (got.error) return { pass: false, actual: undefined, message: got.error };
  let pass = false;
  switch (t.op) {
    case "exists": pass = got.found && got.value !== undefined && got.value !== null; break;
    case "!exists": pass = !got.found || got.value === undefined || got.value === null; break;
    case "==": pass = got.found && (asText(got.value) === want || (!Number.isNaN(num(got.value)) && num(got.value) === num(want))); break;
    case "!=": pass = !(got.found && (asText(got.value) === want || (!Number.isNaN(num(got.value)) && num(got.value) === num(want)))); break;
    case ">": pass = num(got.value) > num(want); break;
    case "<": pass = num(got.value) < num(want); break;
    case ">=": pass = num(got.value) >= num(want); break;
    case "<=": pass = num(got.value) <= num(want); break;
    case "contains": pass = got.found && asText(got.value).includes(want); break;
    case "!contains": pass = !(got.found && asText(got.value).includes(want)); break;
    case "matches":
      try {
        pass = got.found && new RegExp(want).test(asText(got.value));
      } catch {
        return { pass: false, actual: got.value, message: `Bad pattern ${want}` };
      }
      break;
  }
  return { pass, actual: got.value, message: pass ? "" : `got ${asText(got.value)}` };
}

export const describeTest = (t) => `${t.source}${t.path ? ` ${t.path}` : ""} ${t.op}${["exists", "!exists"].includes(t.op) ? "" : ` ${t.value ?? ""}`}`;

export function runTests(tests, res) {
  return (tests ?? []).filter((t) => t.enabled !== false).map((t) => ({ test: t, label: describeTest(t), ...runTest(t, res) }));
}

// Captures: { source, path, variable } -> { variable: value } (strings; JSON for objects).
export function runCaptures(captures, res) {
  const out = {};
  for (const c of captures ?? []) {
    if (c.enabled === false || !c.variable) continue;
    const got = sourceValue(res, c.source, c.path);
    if (got.found && got.value !== undefined) out[c.variable] = typeof got.value === "string" ? got.value : JSON.stringify(got.value);
  }
  return out;
}

// ── cURL import ────────────────────────────────────────────────────────────────────────
export function shellWords(cmd) {
  const s = String(cmd ?? "").replace(/\\\r?\n/g, " ");
  const out = [];
  let w = null, q = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") {
      if (ch === "'") q = "";
      else w += ch;
    } else if (q === '"') {
      if (ch === '"') q = "";
      else if (ch === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) w += s[++i];
      else w += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      w ??= "";
    } else if (ch === "$" && s[i + 1] === "'") {
      // $'…' ANSI-C quoting (Chrome's "Copy as cURL" uses it).
      i += 2;
      w ??= "";
      while (i < s.length && s[i] !== "'") {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i];
          w += n === "n" ? "\n" : n === "t" ? "\t" : n === "r" ? "\r" : n;
        } else w += s[i];
        i++;
      }
    } else if (ch === "\\" && i + 1 < s.length) {
      w = (w ?? "") + s[++i];
    } else if (/\s/.test(ch)) {
      if (w !== null) out.push(w);
      w = null;
    } else w = (w ?? "") + ch;
  }
  if (w !== null) out.push(w);
  return out;
}

export function parseCurl(cmd) {
  const words = shellWords(String(cmd ?? "").trim());
  if (!words.length || !/(^|\/)curl$/.test(words[0])) throw new Error("That isn't a curl command");
  const req = newRequest({ name: "Imported request" });
  let method = null, getMode = false;
  const data = [], form = [];
  const takesValue = new Set(["-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode", "-F", "--form", "--form-string", "-u", "--user", "--url", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-m", "--max-time", "-o", "--output", "--connect-timeout", "-x", "--proxy", "-w", "--write-out"]);
  for (let i = 1; i < words.length; i++) {
    let w = words[i];
    let val = null;
    const eq = w.startsWith("--") ? w.indexOf("=") : -1;
    if (eq > 0 && takesValue.has(w.slice(0, eq))) {
      val = w.slice(eq + 1);
      w = w.slice(0, eq);
    } else if (/^-[XHdFuAebm]./.test(w) && !w.startsWith("--")) {
      val = w.slice(2);
      w = w.slice(0, 2);
    } else if (takesValue.has(w)) val = words[++i] ?? "";
    switch (w) {
      case "-X": case "--request": method = val.toUpperCase(); break;
      case "-H": case "--header": {
        const j = val.indexOf(":");
        if (j > 0) req.headers.push({ key: val.slice(0, j).trim(), value: val.slice(j + 1).trim(), enabled: true });
        break;
      }
      case "-d": case "--data": case "--data-raw": case "--data-binary": case "--data-ascii": data.push(val); break;
      case "--data-urlencode": data.push(val.includes("=") ? `${val.slice(0, val.indexOf("="))}=${encodeURIComponent(val.slice(val.indexOf("=") + 1))}` : encodeURIComponent(val)); break;
      case "-F": case "--form": case "--form-string": {
        const j = val.indexOf("=");
        const key = val.slice(0, j), v = val.slice(j + 1);
        form.push(v.startsWith("@") && w !== "--form-string" ? { key, value: v.slice(1).split(";")[0], type: "file", enabled: true } : { key, value: v, type: "text", enabled: true });
        break;
      }
      case "-u": case "--user": {
        const j = val.indexOf(":");
        req.auth = { type: "basic", username: j < 0 ? val : val.slice(0, j), password: j < 0 ? "" : val.slice(j + 1) };
        break;
      }
      case "-A": case "--user-agent": req.headers.push({ key: "User-Agent", value: val, enabled: true }); break;
      case "-e": case "--referer": req.headers.push({ key: "Referer", value: val, enabled: true }); break;
      case "-b": case "--cookie": req.headers.push({ key: "Cookie", value: val, enabled: true }); break;
      case "-m": case "--max-time": req.settings.timeout = Number(val) || 30; break;
      case "-k": case "--insecure": req.settings.insecure = true; break;
      case "-L": case "--location": req.settings.follow = true; break;
      case "-G": case "--get": getMode = true; break;
      case "-I": case "--head": method = "HEAD"; break;
      case "--url": req.url = val; break;
      case "--http1.1": req.settings.http = "1.1"; break;
      case "--http2": req.settings.http = "2"; break;
      default:
        if (!w.startsWith("-") && !req.url) req.url = w;
    }
  }
  const ctHeader = req.headers.find((h) => h.key.toLowerCase() === "content-type");
  const ct = ctHeader?.value ?? "";
  if (form.length) {
    req.body = { ...req.body, mode: "multipart", multipart: form };
    if (ctHeader && /multipart/i.test(ct)) req.headers = req.headers.filter((h) => h !== ctHeader);
  } else if (data.length) {
    const text = data.join("&");
    if (getMode) req.url += (req.url.includes("?") ? "&" : "?") + text;
    else if (/json/i.test(ct) || (!ct && /^\s*[[{]/.test(text))) {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {}
      req.body = { ...req.body, mode: "json", text: pretty };
      if (ctHeader && /^application\/json\s*$/i.test(ct)) req.headers = req.headers.filter((h) => h !== ctHeader);
    } else if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text))) {
      req.body = { ...req.body, mode: "form", form: text.split("&").map((p) => ({ key: dec(p.split("=")[0]), value: dec(p.slice(p.indexOf("=") + 1)), enabled: true })) };
      if (ctHeader) req.headers = req.headers.filter((h) => h !== ctHeader);
    } else req.body = { ...req.body, mode: /xml/i.test(ct) ? "xml" : "text", text };
  }
  req.method = method ?? (data.length && !getMode ? "POST" : form.length ? "POST" : "GET");
  req.params = paramsFromUrl(req.url);
  try {
    const u = new URL(req.url.includes("://") ? req.url : `http://${req.url}`);
    req.name = `${req.method} ${u.pathname === "/" ? u.host : u.pathname}`;
  } catch {
    req.name = `${req.method} ${req.url}`.slice(0, 60);
  }
  return req;
}

// ── export as code ─────────────────────────────────────────────────────────────────────
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const js = (s) => JSON.stringify(String(s));

export function toCurl(r) {
  const out = [`curl -X ${r.method} ${sq(r.url)}`];
  for (const h of r.headers) out.push(`-H ${sq(`${h.key}: ${h.value}`)}`);
  const b = r.body ?? {};
  if (b.mode === "form") for (const f of b.form ?? []) out.push(`--data-urlencode ${sq(`${f.key}=${f.value}`)}`);
  else if (b.mode === "multipart") for (const f of b.multipart ?? []) out.push(`-F ${sq(f.type === "file" ? `${f.key}=@${f.value}` : `${f.key}=${f.value}`)}`);
  else if (b.mode === "binary" && b.file) out.push(`--data-binary ${sq(`@${b.file}`)}`);
  else if (b.text) out.push(`--data-raw ${sq(b.text)}`);
  if (r.settings?.insecure) out.push("-k");
  if (r.settings?.follow !== false) out.push("-L");
  return out.join(" \\\n  ");
}

export function toFetch(r) {
  const opts = [`  method: ${js(r.method)}`];
  if (r.headers.length) opts.push(`  headers: {\n${r.headers.map((h) => `    ${js(h.key)}: ${js(h.value)}`).join(",\n")}\n  }`);
  const b = r.body ?? {};
  if (b.mode === "form") opts.push(`  body: new URLSearchParams(${JSON.stringify(Object.fromEntries((b.form ?? []).map((f) => [f.key, f.value])))})`);
  else if (b.mode === "multipart") return `const form = new FormData();\n${(b.multipart ?? []).map((f) => `form.append(${js(f.key)}, ${f.type === "file" ? `/* file: ${f.value} */ new Blob([])` : js(f.value)});`).join("\n")}\n\nconst res = await fetch(${js(r.url)}, {\n${[...opts, "  body: form"].join(",\n")}\n});\nconsole.log(res.status, await res.text());`;
  else if (b.text) opts.push(`  body: ${b.mode === "json" || b.mode === "graphql" ? `JSON.stringify(${prettyOr(b.text)})` : js(b.text)}`);
  return `const res = await fetch(${js(r.url)}, {\n${opts.join(",\n")}\n});\nconsole.log(res.status, await res.text());`;
}

function prettyOr(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).replace(/\n/g, "\n  ");
  } catch {
    return js(text);
  }
}

export function toAxios(r) {
  const lines = [`  method: ${js(r.method.toLowerCase())}`, `  url: ${js(r.url)}`];
  if (r.headers.length) lines.push(`  headers: {\n${r.headers.map((h) => `    ${js(h.key)}: ${js(h.value)}`).join(",\n")}\n  }`);
  const b = r.body ?? {};
  if (b.mode === "form") lines.push(`  data: new URLSearchParams(${JSON.stringify(Object.fromEntries((b.form ?? []).map((f) => [f.key, f.value])))})`);
  else if (b.text) lines.push(`  data: ${b.mode === "json" || b.mode === "graphql" ? prettyOr(b.text) : js(b.text)}`);
  return `import axios from "axios";\n\nconst res = await axios({\n${lines.join(",\n")}\n});\nconsole.log(res.status, res.data);`;
}

export function toPython(r) {
  const py = (s) => JSON.stringify(String(s));
  const lines = ["import requests", "", `response = requests.request(`, `    ${py(r.method)},`, `    ${py(r.url)},`];
  if (r.headers.length) lines.push(`    headers={${r.headers.map((h) => `${py(h.key)}: ${py(h.value)}`).join(", ")}},`);
  const b = r.body ?? {};
  if (b.mode === "form") lines.push(`    data={${(b.form ?? []).map((f) => `${py(f.key)}: ${py(f.value)}`).join(", ")}},`);
  else if (b.mode === "multipart") lines.push(`    files={${(b.multipart ?? []).map((f) => `${py(f.key)}: ${f.type === "file" ? `open(${py(f.value)}, "rb")` : `(None, ${py(f.value)})`}`).join(", ")}},`);
  else if (b.text) lines.push(`    data=${py(b.text)},`);
  if (r.settings?.insecure) lines.push("    verify=False,");
  lines.push(`    timeout=${Number(r.settings?.timeout) || 30},`, ")", "print(response.status_code, response.text)");
  return lines.join("\n");
}

export function toHttpie(r) {
  const out = [`http ${r.method} ${sq(r.url)}`];
  for (const h of r.headers) out.push(sq(`${h.key}:${h.value}`));
  const b = r.body ?? {};
  if (b.mode === "form") return `http --form ${r.method} ${sq(r.url)} ${[...r.headers.map((h) => sq(`${h.key}:${h.value}`)), ...(b.form ?? []).map((f) => sq(`${f.key}=${f.value}`))].join(" ")}`;
  if (b.text) return `printf %s ${sq(b.text)} | ${out.join(" ")}`;
  return out.join(" ");
}

export const SNIPPETS = { curl: ["cURL", toCurl], fetch: ["fetch", toFetch], axios: ["axios", toAxios], python: ["Python requests", toPython], httpie: ["HTTPie", toHttpie] };

// ── collections and Postman v2.1 ───────────────────────────────────────────────────────
// A collection file (.vx/http/<slug>.json): { name, version: 1, items: [request | folder] },
// folder = { id, folder: true, name, items: [...] }.
export function newCollection(name) {
  return { name: name || "Collection", version: 1, items: [] };
}

export const slugify = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 60) || "collection";

export function walkItems(items, fn, path = []) {
  for (const it of items ?? []) {
    fn(it, path);
    if (it.folder) walkItems(it.items, fn, [...path, it]);
  }
}

export function findItem(items, id) {
  let hit = null;
  walkItems(items, (it) => {
    if (!hit && it.id === id) hit = it;
  });
  return hit;
}

// Replaces (or adds at the top level) a request by id; returns new items.
export function upsertItem(items, item) {
  let done = false;
  const map = (list) => (list ?? []).map((it) => {
    if (it.id === item.id) {
      done = true;
      return item;
    }
    return it.folder ? { ...it, items: map(it.items) } : it;
  });
  const out = map(items);
  return done ? out : [...out, item];
}

export function removeItem(items, id) {
  return (items ?? []).filter((it) => it.id !== id).map((it) => (it.folder ? { ...it, items: removeItem(it.items, id) } : it));
}

const pmKV = (list) => (list ?? []).map((x) => ({ key: x.key ?? "", value: String(x.value ?? ""), enabled: !x.disabled }));

export function fromPostman(json) {
  const col = typeof json === "string" ? JSON.parse(json) : json;
  if (!col?.info || !Array.isArray(col.item)) throw new Error("Not a Postman collection (v2.1 JSON)");
  const convert = (item) => {
    if (Array.isArray(item.item)) return { id: uid(), folder: true, name: item.name ?? "Folder", items: item.item.map(convert) };
    const r = item.request ?? {};
    const url = typeof r.url === "string" ? r.url : r.url?.raw ?? "";
    const req = newRequest({ name: item.name ?? "Request", method: String(r.method ?? "GET").toUpperCase(), url });
    req.headers = pmKV(r.header);
    req.params = typeof r.url === "object" && Array.isArray(r.url.query) ? pmKV(r.url.query) : paramsFromUrl(url);
    const b = r.body ?? {};
    if (b.mode === "raw") {
      const lang = b.options?.raw?.language;
      req.body = { ...req.body, mode: lang === "json" ? "json" : lang === "xml" ? "xml" : /^\s*[[{]/.test(b.raw ?? "") ? "json" : "text", text: b.raw ?? "" };
    } else if (b.mode === "urlencoded") req.body = { ...req.body, mode: "form", form: pmKV(b.urlencoded) };
    else if (b.mode === "formdata") req.body = { ...req.body, mode: "multipart", multipart: (b.formdata ?? []).map((f) => ({ key: f.key, value: f.type === "file" ? String(f.src ?? "") : String(f.value ?? ""), type: f.type === "file" ? "file" : "text", enabled: !f.disabled })) };
    else if (b.mode === "graphql") req.body = { ...req.body, mode: "graphql", graphql: { query: b.graphql?.query ?? "", variables: b.graphql?.variables ?? "" } };
    else if (b.mode === "file") req.body = { ...req.body, mode: "binary", file: String(b.file?.src ?? "") };
    const a = r.auth;
    const av = (k) => (a?.[a?.type] ?? []).find((x) => x.key === k)?.value ?? "";
    if (a?.type === "basic") req.auth = { type: "basic", username: av("username"), password: av("password") };
    else if (a?.type === "bearer") req.auth = { type: "bearer", token: av("token") };
    else if (a?.type === "apikey") req.auth = { type: "apikey", key: av("key"), value: av("value"), in: av("in") === "query" ? "query" : "header" };
    return req;
  };
  return {
    collection: { name: col.info.name ?? "Imported", version: 1, items: col.item.map(convert) },
    variables: Object.fromEntries((col.variable ?? []).map((v) => [v.key, String(v.value ?? "")])),
  };
}

export function toPostman(collection) {
  const kv = (list) => (list ?? []).map((x) => ({ key: x.key, value: x.value, ...(x.enabled === false ? { disabled: true } : {}) }));
  const convert = (it) => {
    if (it.folder) return { name: it.name, item: (it.items ?? []).map(convert) };
    const b = it.body ?? {};
    const body = b.mode === "json" || b.mode === "text" || b.mode === "xml" ? { mode: "raw", raw: b.text ?? "", options: { raw: { language: b.mode === "text" ? "text" : b.mode } } }
      : b.mode === "form" ? { mode: "urlencoded", urlencoded: kv(b.form) }
      : b.mode === "multipart" ? { mode: "formdata", formdata: (b.multipart ?? []).map((f) => (f.type === "file" ? { key: f.key, type: "file", src: f.value } : { key: f.key, value: f.value, type: "text" })) }
      : b.mode === "graphql" ? { mode: "graphql", graphql: { query: b.graphql?.query ?? "", variables: b.graphql?.variables ?? "" } }
      : b.mode === "binary" ? { mode: "file", file: { src: b.file ?? "" } } : undefined;
    const a = it.auth ?? {};
    const auth = a.type === "basic" ? { type: "basic", basic: [{ key: "username", value: a.username ?? "" }, { key: "password", value: a.password ?? "" }] }
      : a.type === "bearer" ? { type: "bearer", bearer: [{ key: "token", value: a.token ?? "" }] }
      : a.type === "apikey" ? { type: "apikey", apikey: [{ key: "key", value: a.key ?? "" }, { key: "value", value: a.value ?? "" }, { key: "in", value: a.in ?? "header" }] } : undefined;
    return { name: it.name, request: { method: it.method, header: kv(it.headers), url: { raw: it.url, query: kv(it.params) }, ...(body ? { body } : {}), ...(auth ? { auth } : {}) } };
  };
  return {
    info: { name: collection.name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: (collection.items ?? []).map(convert),
  };
}

// ── environments ───────────────────────────────────────────────────────────────────────
// environments.json: { envs: { [name]: { [var]: value } } }; .secrets.json the same shape for
// the variables marked secret (gitignored). The active one is per user (not in the repo).
export function envVars(envs, secrets, name) {
  if (!name) return {};
  return { ...(envs?.envs?.[name] ?? {}), ...(secrets?.envs?.[name] ?? {}) };
}

export const GITIGNORE = "# vx-http: secret environment values and per-user state stay out of git\n.secrets.json\n";
