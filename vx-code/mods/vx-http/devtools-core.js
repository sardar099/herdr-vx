// Dev Tools (vx-devtools): every tool as data. A tool is
//   { id, group, name, keys, inputs: [{ id, label, multi?, placeholder? }], options: [{ id, label, choices, value }],
//     run(input, opts) -> { text } | { rows: [{ label, value }] } | { markdown } | { diff } | { error }   (may be async)
//     exec?(input, opts) -> { cmd, args, parse(stdout, stderr, code) }   (needs a program; the mod runs it) }
// Pure apart from crypto.subtle / crypto.getRandomValues (both in Node and in Herdr).
import { parseCurl, resolveRequest, SNIPPETS, STATUS } from "./http-core.js";

export const GROUPS = ["Encode", "Format", "Generate", "Convert", "Text", "Network"];

// ── small helpers ──────────────────────────────────────────────────────────────────────
const enc = new (globalThis.TextEncoder ?? class { encode(s) { return Uint8Array.from(Buffer.from(s, "utf8")); } })();
const utf8 = (s) => (typeof Buffer !== "undefined" ? Uint8Array.from(Buffer.from(String(s), "utf8")) : enc.encode(String(s)));
const fromUtf8 = (bytes) => (typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("utf8") : decodeURIComponent(escape(String.fromCharCode(...bytes))));
const toB64 = (bytes) => (typeof Buffer !== "undefined" ? Buffer.from(bytes).toString("base64") : btoa(String.fromCharCode(...bytes)));
const fromB64 = (s) => {
  const clean = String(s).trim().replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*=*$/.test(clean)) throw new Error("Not valid Base64");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  return typeof Buffer !== "undefined" ? Uint8Array.from(Buffer.from(padded, "base64")) : Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};
const b64url = (bytes) => toB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const randomBytes = (n) => {
  const a = new Uint8Array(n);
  try {
    globalThis.crypto?.getRandomValues?.(a);
  } catch {}
  // A stubbed getRandomValues leaves zeros: fall back (fine for test data, ids and passwords here).
  if (n >= 4 && a.every((x) => x === 0)) for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
  return a;
};
const ok = (text) => ({ text: String(text) });
const rows = (list) => ({ rows: list.filter((r) => r && r.value !== undefined && r.value !== null).map((r) => ({ label: r.label, value: String(r.value) })) });
const fail = (msg) => ({ error: String(msg?.message ?? msg) });
const tryRun = (fn) => {
  try {
    return fn();
  } catch (e) {
    return fail(e);
  }
};
const lines = (s) => String(s ?? "").replace(/\r/g, "").split("\n");

// JSON with the place of a syntax error (line and column).
export function parseJsonAt(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = /position (\d+)/.exec(String(e.message));
    if (m) {
      const pos = Number(m[1]);
      const before = String(text).slice(0, pos).split("\n");
      throw new Error(`${String(e.message).replace(/ in JSON at position \d+.*$/, "")} at line ${before.length}, column ${before[before.length - 1].length + 1}`);
    }
    throw e;
  }
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ── MD5 (crypto.subtle has none) ───────────────────────────────────────────────────────
export function md5(input) {
  const bytes = typeof input === "string" ? utf8(input) : input;
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const len = bytes.length;
  const total = (((len + 8) >> 6) + 1) * 64;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = len * 8;
  for (let i = 0; i < 4; i++) m[total - 8 + i] = (bits >>> (8 * i)) & 0xff;
  const hi = Math.floor(len / 0x20000000);
  for (let i = 0; i < 4; i++) m[total - 4 + i] = (hi >>> (8 * i)) & 0xff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, c) => (x << c) | (x >>> (32 - c));
  for (let off = 0; off < total; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => m[off + i * 4] | (m[off + i * 4 + 1] << 8) | (m[off + i * 4 + 2] << 16) | (m[off + i * 4 + 3] << 24));
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + rotl(F, S[i])) | 0;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map((x) => hex([x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff])).join("");
}

// SHA-1 / SHA-256 / SHA-384 / SHA-512 and HMAC in plain JS: Herdr's crypto.subtle is a stub,
// so nothing here leans on it (Node gives the same answers, which the tests check).
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
function pad64(bytes, lenBytes = 8) {
  const block = lenBytes === 16 ? 128 : 64;
  const len = bytes.length;
  const total = Math.ceil((len + 1 + lenBytes) / block) * block;
  const m = new Uint8Array(total);
  m.set(bytes);
  m[len] = 0x80;
  const bits = BigInt(len) * 8n;
  for (let i = 0; i < 8; i++) m[total - 1 - i] = Number((bits >> BigInt(8 * i)) & 0xffn);
  return m;
}
function sha1(bytes) {
  const m = pad64(bytes);
  let [a0, b0, c0, d0, e0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let [a, b, c, d, e] = [a0, b0, c0, d0, e0];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0; e0 = (e0 + e) | 0;
  }
  return words32([a0, b0, c0, d0, e0]);
}
const K256 = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
function sha256(bytes) {
  const m = pad64(bytes);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (m[off + 4 * i] << 24) | (m[off + 4 * i + 1] << 16) | (m[off + 4 * i + 2] << 8) | m[off + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return words32(H);
}
function words32(list) {
  const out = new Uint8Array(list.length * 4);
  list.forEach((x, i) => { out[4 * i] = (x >>> 24) & 255; out[4 * i + 1] = (x >>> 16) & 255; out[4 * i + 2] = (x >>> 8) & 255; out[4 * i + 3] = x & 255; });
  return out;
}
const K512 = ["428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019", "923f82a4af194f9b", "ab1c5ed5da6d8118", "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2", "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694", "e49b69c19ef14ad2", "efbe4786384f25e3", "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5", "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725", "06ca6351e003826f", "142929670a0e6e70", "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df", "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b", "a2bfe8a14cf10364", "a81a664bbc423001", "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8", "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb", "5b9cca4f7763e373", "682e6ff3d6b2b8a3", "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec", "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b", "ca273eceea26619c", "d186b8c721c0c207", "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b", "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a", "5fcb6fab3ad6faec", "6c44198c4a475817"].map((x) => BigInt(`0x${x}`));
const M64 = (1n << 64n) - 1n;
const rotr64 = (x, n) => ((x >> n) | (x << (64n - n))) & M64;
function sha512(bytes, is384 = false) {
  const m = pad64(bytes, 16);
  const H = (is384
    ? ["cbbb9d5dc1059ed8", "629a292a367cd507", "9159015a3070dd17", "152fecd8f70e5939", "67332667ffc00b31", "8eb44a8768581511", "db0c2e0d64f98fa7", "47b5481dbefa4fa4"]
    : ["6a09e667f3bcc908", "bb67ae8584caa73b", "3c6ef372fe94f82b", "a54ff53a5f1d36f1", "510e527fade682d1", "9b05688c2b3e6c1f", "1f83d9abfb41bd6b", "5be0cd19137e2179"]).map((x) => BigInt(`0x${x}`));
  const w = new Array(80);
  for (let off = 0; off < m.length; off += 128) {
    for (let i = 0; i < 16; i++) { let v = 0n; for (let k = 0; k < 8; k++) v = (v << 8n) | BigInt(m[off + 8 * i + k]); w[i] = v; }
    for (let i = 16; i < 80; i++) {
      const s0 = rotr64(w[i - 15], 1n) ^ rotr64(w[i - 15], 8n) ^ (w[i - 15] >> 7n);
      const s1 = rotr64(w[i - 2], 19n) ^ rotr64(w[i - 2], 61n) ^ (w[i - 2] >> 6n);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & M64;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 80; i++) {
      const t1 = (h + (rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n)) + ((e & f) ^ (~e & M64 & g)) + K512[i] + w[i]) & M64;
      const t2 = ((rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n)) + ((a & b) ^ (a & c) ^ (b & c))) & M64;
      h = g; g = f; f = e; e = (d + t1) & M64; d = c; c = b; b = a; a = (t1 + t2) & M64;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) & M64; });
  }
  const out = new Uint8Array(64);
  H.forEach((x, i) => { for (let k = 0; k < 8; k++) out[8 * i + k] = Number((x >> BigInt(8 * (7 - k))) & 0xffn); });
  return is384 ? out.slice(0, 48) : out;
}
const HASHES = { "SHA-1": [sha1, 64], "SHA-256": [sha256, 64], "SHA-384": [(b) => sha512(b, true), 128], "SHA-512": [(b) => sha512(b), 128] };
export function digestBytes(alg, bytes) {
  return HASHES[alg][0](bytes);
}
async function digest(alg, text) {
  return hex(digestBytes(alg, utf8(text)));
}
export function hmacBytes(alg, keyBytes, msgBytes) {
  const [fn, block] = HASHES[alg];
  let key = keyBytes.length > block ? fn(keyBytes) : keyBytes;
  const k = new Uint8Array(block);
  k.set(key);
  const ipad = k.map((x) => x ^ 0x36), opad = k.map((x) => x ^ 0x5c);
  const inner = fn(Uint8Array.from([...ipad, ...msgBytes]));
  return fn(Uint8Array.from([...opad, ...inner]));
}
async function hmac(alg, key, text, out = "hex") {
  const sig = hmacBytes(alg, utf8(key), utf8(text));
  return out === "base64url" ? b64url(sig) : out === "base64" ? toB64(sig) : hex(sig);
}

// ── JWT ────────────────────────────────────────────────────────────────────────────────
export function decodeJwt(token) {
  const parts = String(token).trim().split(".");
  if (parts.length < 2) throw new Error("A JWT has three parts separated by dots");
  const part = (s) => parseJsonAt(fromUtf8(fromB64(s)));
  return { header: part(parts[0]), payload: part(parts[1]), signature: parts[2] ?? "", signed: `${parts[0]}.${parts[1]}` };
}
const HS = { HS256: "SHA-256", HS384: "SHA-384", HS512: "SHA-512" };
export async function signJwt(payload, secret, alg = "HS256") {
  const head = b64url(utf8(JSON.stringify({ alg, typ: "JWT" })));
  const body = b64url(utf8(typeof payload === "string" ? JSON.stringify(parseJsonAt(payload)) : JSON.stringify(payload)));
  return `${head}.${body}.${await hmac(HS[alg], secret, `${head}.${body}`, "base64url")}`;
}

const when = (sec) => {
  if (typeof sec !== "number") return null;
  const d = new Date(sec * 1000);
  return `${d.toISOString()} (${relative(d.getTime())})`;
};

// ── dates (no Intl here: by hand) ──────────────────────────────────────────────────────
export function relative(ms, now = Date.now()) {
  const s = Math.round((ms - now) / 1000);
  const a = Math.abs(s);
  const [n, unit] = a < 60 ? [a, "second"] : a < 3600 ? [Math.round(a / 60), "minute"] : a < 86400 ? [Math.round(a / 3600), "hour"] : a < 2592000 ? [Math.round(a / 86400), "day"] : a < 31536000 ? [Math.round(a / 2592000), "month"] : [Math.round(a / 31536000), "year"];
  if (a < 5) return "now";
  return s < 0 ? `${n} ${unit}${n === 1 ? "" : "s"} ago` : `in ${n} ${unit}${n === 1 ? "" : "s"}`;
}
const pad = (n, w = 2) => String(n).padStart(w, "0");
export function localStamp(d) {
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${off >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

// A number (s, ms, µs, ns guessed by size) or a date string -> the moment it names.
export function parseMoment(input, now = Date.now()) {
  const s = String(input ?? "").trim();
  if (!s || s.toLowerCase() === "now") return new Date(now);
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    const a = Math.abs(n);
    const ms = a < 1e11 ? n * 1000 : a < 1e14 ? n : a < 1e17 ? n / 1000 : n / 1e6;
    return new Date(ms);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error("Not a timestamp or a date I can read");
  return d;
}

// ── cron ───────────────────────────────────────────────────────────────────────────────
const CRON_NAMES = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const CRON_MACROS = { "@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *", "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *" };
function cronField(spec, min, max) {
  const out = new Set();
  for (const part of spec.toLowerCase().split(",")) {
    const [range, stepS] = part.split("/");
    const step = stepS ? Number(stepS) : 1;
    if (!step || step < 1) throw new Error(`Bad step in "${part}"`);
    let lo = min, hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-").map((x) => (CRON_NAMES[x] ?? Number(x)));
      if (Number.isNaN(a) || (b !== undefined && Number.isNaN(b))) throw new Error(`Can't read "${part}"`);
      lo = a;
      hi = b ?? (stepS ? max : a);
    }
    if (lo < min || hi > max + (max === 6 ? 1 : 0) || lo > hi) throw new Error(`"${part}" is out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(max === 6 && v === 7 ? 0 : v);
  }
  return out;
}
export function parseCron(expr) {
  const e = CRON_MACROS[String(expr).trim().toLowerCase()] ?? String(expr).trim();
  const f = e.split(/\s+/);
  if (f.length !== 5) throw new Error("A cron line has 5 fields: minute hour day-of-month month day-of-week");
  return { minute: cronField(f[0], 0, 59), hour: cronField(f[1], 0, 23), dom: cronField(f[2], 1, 31), month: cronField(f[3], 1, 12), dow: cronField(f[4], 0, 6), domStar: f[2] === "*", dowStar: f[4] === "*", fields: f };
}
export function cronNext(expr, from = new Date(), count = 5) {
  const c = parseCron(expr);
  const out = [];
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let guard = 0; out.length < count && guard < 600000; guard++) {
    const dayOk = c.domStar || c.dowStar ? c.dom.has(d.getDate()) && c.dow.has(d.getDay()) : c.dom.has(d.getDate()) || c.dow.has(d.getDay());
    if (!c.month.has(d.getMonth() + 1) || !dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (c.minute.has(d.getMinutes())) out.push(new Date(d.getTime()));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export function describeCron(expr) {
  const c = parseCron(expr);
  const [mi, ho, dm, mo, dw] = c.fields;
  const list = (set, names) => [...set].sort((a, b) => a - b).map((v) => (names ? names[v] : v)).join(", ");
  let time;
  if (mi === "*" && ho === "*") time = "every minute";
  else if (/^\*\/\d+$/.test(mi)) {
    const hs = [...c.hour].sort((a, b) => a - b);
    const run = hs.every((h, k) => k === 0 || h === hs[k - 1] + 1);
    time = `every ${mi.slice(2)} minutes${ho === "*" ? "" : run && hs.length > 1 ? `, ${pad(hs[0])}:00–${pad(hs[hs.length - 1])}:59` : ` during hour ${list(c.hour)}`}`;
  }
  else if (ho === "*") time = `at minute ${list(c.minute)} of every hour`;
  else if (c.minute.size === 1 && c.hour.size <= 6 && !/[/*]/.test(ho)) time = `at ${[...c.hour].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad([...c.minute][0])}`).join(", ")}`;
  else time = `at minute ${list(c.minute)} past hour ${list(c.hour)}`;
  const parts = [time];
  if (dm !== "*") parts.push(`on day ${list(c.dom)} of the month`);
  if (dw !== "*") parts.push(`${dm !== "*" ? "or " : ""}on ${list(c.dow, DOW)}`);
  if (mo !== "*") parts.push(`in ${list(c.month, MON)}`);
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── colours ────────────────────────────────────────────────────────────────────────────
export function parseColor(s) {
  const t = String(s).trim().toLowerCase();
  let m;
  if ((m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t))) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(t))) {
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
  }
  if ((m = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(t))) {
    const [r, g, b] = hslToRgb(Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100);
    const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
    return { r, g, b, a };
  }
  throw new Error("Enter #hex, rgb(…) or hsl(…)");
}
function hslToRgb(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, Math.round(l * 100)];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}
function toOklch(r, g, b) {
  const lin = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + Bb * Bb);
  const H = (Math.atan2(Bb, A) * 180) / Math.PI;
  return `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(3)} ${((H + 360) % 360).toFixed(1)})`;
}

// ── text case ──────────────────────────────────────────────────────────────────────────
export function words(s) {
  return String(s ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
export const CASES = {
  camel: (w) => w.map((x, i) => (i ? cap(x) : x.toLowerCase())).join(""),
  pascal: (w) => w.map(cap).join(""),
  snake: (w) => w.map((x) => x.toLowerCase()).join("_"),
  constant: (w) => w.map((x) => x.toUpperCase()).join("_"),
  kebab: (w) => w.map((x) => x.toLowerCase()).join("-"),
  title: (w) => w.map(cap).join(" "),
  sentence: (w) => w.map((x, i) => (i ? x.toLowerCase() : cap(x))).join(" "),
  dot: (w) => w.map((x) => x.toLowerCase()).join("."),
  path: (w) => w.map((x) => x.toLowerCase()).join("/"),
};
export const slugify = (s) => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// ── JSON -> TypeScript / Zod ───────────────────────────────────────────────────────────
export function jsonToTs(value, root = "Root") {
  const decls = [];
  const seen = new Map();
  const name = (k) => CASES.pascal(words(k)) || "Item";
  const typeOf = (v, key) => {
    if (v === null) return "null";
    if (Array.isArray(v)) {
      if (!v.length) return "unknown[]";
      const types = [...new Set(v.map((x) => typeOf(x, key.replace(/s$/, ""))))];
      return types.length === 1 ? `${types[0]}[]` : `(${types.join(" | ")})[]`;
    }
    if (typeof v === "object") {
      const body = Object.entries(v).map(([k, x]) => `  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${typeOf(x, k)};`).join("\n");
      if (seen.has(body)) return seen.get(body);
      let n = name(key);
      while (decls.some((d) => d.startsWith(`export interface ${n} `))) n += "2";
      seen.set(body, n);
      decls.push(`export interface ${n} {\n${body}\n}`);
      return n;
    }
    return typeof v;
  };
  const top = typeOf(value, root);
  if (!decls.length || top !== name(root)) decls.push(`export type ${name(root)} = ${top};`);
  return decls.join("\n\n");
}
export function jsonToZod(value) {
  const z = (v, ind) => {
    if (v === null) return "z.null()";
    if (Array.isArray(v)) return v.length ? `z.array(${z(v[0], ind)})` : "z.array(z.unknown())";
    if (typeof v === "object") return `z.object({\n${Object.entries(v).map(([k, x]) => `${ind}  ${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${z(x, `${ind}  `)},`).join("\n")}\n${ind}})`;
    return typeof v === "number" ? (Number.isInteger(v) ? "z.number().int()" : "z.number()") : typeof v === "boolean" ? "z.boolean()" : "z.string()";
  };
  return `import { z } from "zod";\n\nexport const Schema = ${z(value, "")};\nexport type Schema = z.infer<typeof Schema>;`;
}

// ── CSV ────────────────────────────────────────────────────────────────────────────────
export function parseCsv(text, sep = ",") {
  const out = [];
  let row = [], cell = "", q = false;
  const s = String(text ?? "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell); out.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.length > 1 || r[0] !== "");
}
const csvCell = (v, sep) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) || s.includes(sep) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function jsonToCsv(list, sep = ",") {
  const arr = Array.isArray(list) ? list : [list];
  const cols = [...new Set(arr.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : ["value"])))];
  return [cols.join(sep), ...arr.map((r) => cols.map((c) => csvCell(r && typeof r === "object" ? r[c] : r, sep)).join(sep))].join("\n");
}
export function csvToJson(text, sep = ",") {
  const [head, ...body] = parseCsv(text, sep);
  if (!head) return [];
  const num = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "true" ? true : v === "false" ? false : v);
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, num(r[i] ?? "")])));
}

// ── XML and SQL formatting ─────────────────────────────────────────────────────────────
export function formatXml(xml, indent = "  ") {
  const tokens = String(xml).replace(/>\s+</g, "><").trim().split(/(<[^>]+>)/).filter((t) => t.trim());
  const isOpen = (t) => /^<[^/!?][^>]*>$/.test(t) && !t.endsWith("/>");
  const out = [];
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    // <a>text</a> on one line.
    if (isOpen(tk) && tokens[i + 1] && !tokens[i + 1].startsWith("<") && /^<\//.test(tokens[i + 2] ?? "")) {
      out.push(indent.repeat(depth) + tk + tokens[i + 1].trim() + tokens[i + 2]);
      i += 2;
      continue;
    }
    if (/^<\//.test(tk)) depth = Math.max(0, depth - 1);
    out.push(indent.repeat(depth) + tk.trim());
    if (isOpen(tk)) depth++;
  }
  return out.join("\n");
}
const SQL_BREAK = ["SELECT", "FROM", "WHERE", "GROUP BY", "ORDER BY", "HAVING", "LIMIT", "OFFSET", "UNION ALL", "UNION", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE FROM", "LEFT JOIN", "RIGHT JOIN", "INNER JOIN", "FULL JOIN", "CROSS JOIN", "JOIN", "ON", "RETURNING", "WITH"];
export function formatSql(sql) {
  let s = String(sql).replace(/\s+/g, " ").trim();
  const re = new RegExp(`\\b(${SQL_BREAK.map((k) => k.replace(/ /g, "\\s+")).join("|")})\\b`, "gi");
  s = s.replace(re, (m) => `\n${m.toUpperCase().replace(/\s+/g, " ")}`);
  s = s.replace(/\b(AND|OR)\b/gi, (m) => `\n  ${m.toUpperCase()}`);
  s = s.replace(/,\s*/g, ",\n  ");
  return s.split("\n").map((l) => l.replace(/^(SELECT|SET|VALUES|RETURNING)\s+/, "$1\n  ")).join("\n").replace(/^\n/, "").replace(/\n{2,}/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
}

// ── .env ───────────────────────────────────────────────────────────────────────────────
export function envToJson(text) {
  const out = {};
  for (const line of lines(text)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    let v = m[2];
    if (/^"(.*)"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'(.*)'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
export const jsonToEnv = (obj) => Object.entries(obj).map(([k, v]) => {
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `${k}=${/[\s#"'=$]/.test(s) || s === "" ? JSON.stringify(s) : s}`;
}).join("\n");

// ── IDs ────────────────────────────────────────────────────────────────────────────────
export function uuidV4() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function uuidV7(now = Date.now()) {
  const b = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()) {
  let t = now, time = "";
  for (let i = 0; i < 10; i++) { time = CROCKFORD[t % 32] + time; t = Math.floor(t / 32); }
  return time + [...randomBytes(16)].map((x) => CROCKFORD[x % 32]).join("");
}
export function nanoid(size = 21) {
  const A = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyrzict";
  return [...randomBytes(size)].map((x) => A[x & 63]).join("");
}
export function inspectUuid(s) {
  const m = /^[0-9a-f]{8}-?[0-9a-f]{4}-?([0-9a-f])[0-9a-f]{3}-?([0-9a-f])[0-9a-f]{3}-?[0-9a-f]{12}$/i.exec(String(s).trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  const out = { version: v, variant: /[89ab]/i.test(m[2]) ? "RFC 4122" : "other" };
  if (v === 7) out.time = new Date(parseInt(String(s).replace(/-/g, "").slice(0, 12), 16)).toISOString();
  return out;
}
export function password(length = 20, { lower = true, upper = true, digits = true, symbols = true } = {}) {
  const sets = [lower && "abcdefghijkmnopqrstuvwxyz", upper && "ABCDEFGHJKLMNPQRSTUVWXYZ", digits && "23456789", symbols && "!@#$%^&*()-_=+[]{};:,.?"].filter(Boolean);
  if (!sets.length) throw new Error("Pick at least one kind of character");
  const all = sets.join("");
  const bytes = randomBytes(length * 2);
  const out = sets.map((set, i) => set[bytes[i] % set.length]);
  for (let i = out.length; i < length; i++) out.push(all[bytes[i] % all.length]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = bytes[length + i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, length).join("");
}

const LOREM = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum".split(" ");
export function lorem(count = 3, unit = "paragraphs") {
  const r = () => randomBytes(1)[0];
  const sentence = () => {
    const n = 8 + (r() % 10);
    const w = Array.from({ length: n }, () => LOREM[r() % LOREM.length]);
    return `${cap(w.join(" "))}.`;
  };
  const para = () => Array.from({ length: 4 + (r() % 3) }, sentence).join(" ");
  if (unit === "words") return Array.from({ length: count }, (_, i) => (i === 0 ? "Lorem" : LOREM[r() % LOREM.length])).join(" ");
  if (unit === "sentences") return Array.from({ length: count }, sentence).join(" ");
  return Array.from({ length: count }, (_, i) => (i === 0 ? `Lorem ipsum dolor sit amet, ${para().charAt(0).toLowerCase()}${para().slice(1)}` : para())).join("\n\n");
}

const FIRST = ["Aarav", "Maya", "Liam", "Sofia", "Noah", "Zara", "Ethan", "Isha", "Lucas", "Ava", "Rohan", "Mia", "Leo", "Priya", "Omar", "Elena"];
const LAST = ["Sharma", "Garcia", "Chen", "Smith", "Kumar", "Müller", "Silva", "Kim", "Brown", "Rossi", "Patel", "Novak", "Okafor", "Dubois"];
const CITY = ["Pune", "Lisbon", "Austin", "Berlin", "Toronto", "Osaka", "Nairobi", "Sydney", "Bengaluru", "Madrid"];
const STREET = ["Maple", "Oak", "Lake", "Hill", "Park", "Cedar", "River", "Station"];
export function fakePeople(count = 5) {
  const r = () => randomBytes(1)[0];
  return Array.from({ length: count }, () => {
    const first = FIRST[r() % FIRST.length], last = LAST[r() % LAST.length];
    return {
      id: uuidV4(), name: `${first} ${last}`, email: `${first}.${last}`.toLowerCase().normalize("NFKD").replace(/[^\w.]/g, "") + `@example.com`,
      phone: `+1-555-${String(100 + (r() % 900))}-${String(1000 + ((r() << 4) % 9000))}`,
      address: `${1 + (r() % 250)} ${STREET[r() % STREET.length]} Street, ${CITY[r() % CITY.length]}`,
      age: 18 + (r() % 60), active: r() % 2 === 0,
    };
  });
}

// ── text ───────────────────────────────────────────────────────────────────────────────
// A line diff (LCS): [{ op: " " | "-" | "+", text }].
export function diffLines(a, b) {
  const A = lines(a), B = lines(b);
  if (A.length * B.length > 4e6) throw new Error("Too long to diff here (over ~2000 × 2000 lines)");
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ op: " ", text: A[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: "-", text: A[i++] });
    else out.push({ op: "+", text: B[j++] });
  }
  while (i < n) out.push({ op: "-", text: A[i++] });
  while (j < m) out.push({ op: "+", text: B[j++] });
  return out;
}

export function regexTest(pattern, flags, text, replacement) {
  const f = [...new Set(String(flags ?? "").replace(/[^dgimsuy]/g, ""))].join("");
  const re = new RegExp(pattern, f.includes("g") ? f : `${f}g`);
  const matches = [];
  for (const m of String(text).matchAll(re)) {
    matches.push({ index: m.index, match: m[0], groups: m.slice(1), named: m.groups ?? null });
    if (matches.length >= 500) break;
    if (!f.includes("g")) break;
  }
  const out = { matches };
  if (replacement !== undefined && replacement !== null && replacement !== "") out.replaced = String(text).replace(new RegExp(pattern, f), replacement);
  return out;
}

export function textStats(s) {
  const t = String(s ?? "");
  const w = t.trim() ? t.trim().split(/\s+/).filter((x) => /[\p{L}\p{N}]/u.test(x)).length : 0;
  return {
    characters: [...t].length, "characters (no spaces)": [...t.replace(/\s/g, "")].length, words: w, lines: t ? lines(t).length : 0,
    sentences: (t.match(/[^.!?]+[.!?]+/g) ?? []).length, paragraphs: t.trim() ? t.trim().split(/\n\s*\n/).length : 0,
    bytes: utf8(t).length, "reading time": `${Math.max(1, Math.round(w / 230))} min`,
  };
}

export function lineTool(s, op) {
  const L = lines(s);
  const r = randomBytes(L.length * 2 + 2);
  switch (op) {
    case "sort": return [...L].sort((a, b) => a.localeCompare(b)).join("\n");
    case "sort desc": return [...L].sort((a, b) => b.localeCompare(a)).join("\n");
    case "sort numeric": return [...L].sort((a, b) => parseFloat(a) - parseFloat(b)).join("\n");
    case "unique": return [...new Set(L)].join("\n");
    case "reverse": return [...L].reverse().join("\n");
    case "shuffle": { const x = [...L]; for (let i = x.length - 1; i > 0; i--) { const j = r[i] % (i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x.join("\n"); }
    case "trim": return L.map((l) => l.trim()).join("\n");
    case "remove empty": return L.filter((l) => l.trim()).join("\n");
    case "number": return L.map((l, i) => `${i + 1}. ${l}`).join("\n");
    case "join with ,": return L.filter((l) => l.trim()).join(", ");
  }
  return s;
}

export function codePoints(s) {
  return [...String(s ?? "")].slice(0, 400).map((ch) => {
    const cp = ch.codePointAt(0);
    return { char: ch === " " ? "␠" : ch === "\n" ? "↵" : ch === "\t" ? "⇥" : ch, cp: `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`, dec: cp, utf8: hex(utf8(ch)).replace(/(..)/g, "$1 ").trim() };
  });
}

// ── numbers ────────────────────────────────────────────────────────────────────────────
export function parseNumber(s) {
  const t = String(s ?? "").trim().replace(/_/g, "").toLowerCase();
  if (!t) throw new Error("Enter a number (0x… hex, 0b… binary, 0o… octal, or decimal)");
  const neg = t.startsWith("-");
  const u = neg ? t.slice(1) : t;
  let n;
  if (/^0x[0-9a-f]+$/.test(u)) n = BigInt(u);
  else if (/^0b[01]+$/.test(u)) n = BigInt(u);
  else if (/^0o[0-7]+$/.test(u)) n = BigInt(u);
  else if (/^\d+$/.test(u)) n = BigInt(u);
  else throw new Error("Not a whole number");
  return neg ? -n : n;
}
export function formatBytesExact(n) {
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const iec = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  const f = (base, u) => { let v = n, i = 0; while (Math.abs(v) >= base && i < u.length - 1) { v /= base; i++; } return `${Number(v.toFixed(2))} ${u[i]}`; };
  return { decimal: f(1000, units), binary: f(1024, iec) };
}
export function parseBytes(s) {
  const m = /^\s*([\d.]+)\s*([kmgtp]?i?b?)?\s*$/i.exec(String(s));
  if (!m) throw new Error("e.g. 1.5 GB, 512 MiB, 2048");
  const u = (m[2] ?? "").toLowerCase();
  const pow = { "": 0, b: 0, k: 1, kb: 1, kib: 1, m: 2, mb: 2, mib: 2, g: 3, gb: 3, gib: 3, t: 4, tb: 4, tib: 4, p: 5, pb: 5, pib: 5 }[u];
  if (pow === undefined) throw new Error(`Unknown unit ${m[2]}`);
  return Number(m[1]) * (u.includes("i") ? 1024 : 1000) ** pow;
}
export function chmod(input) {
  const s = String(input ?? "").trim();
  const sym = (d) => `${d & 4 ? "r" : "-"}${d & 2 ? "w" : "-"}${d & 1 ? "x" : "-"}`;
  if (/^[0-7]{3,4}$/.test(s)) {
    const d = s.slice(-3).split("").map(Number);
    return { octal: s.padStart(4, "0"), symbolic: d.map(sym).join(""), owner: sym(d[0]), group: sym(d[1]), others: sym(d[2]), command: `chmod ${s} file` };
  }
  const m = /^[-dl]?([r-][w-][xsS-])([r-][w-][xsS-])([r-][w-][xtT-])$/.exec(s);
  if (!m) throw new Error("Enter 755, 0644, or rwxr-xr-x");
  const val = (t) => (t[0] === "r" ? 4 : 0) + (t[1] === "w" ? 2 : 0) + (/[xst]/.test(t[2]) ? 1 : 0);
  const oct = `${val(m[1])}${val(m[2])}${val(m[3])}`;
  return { octal: oct, symbolic: `${m[1]}${m[2]}${m[3]}`, command: `chmod ${oct} file` };
}

// ── network ────────────────────────────────────────────────────────────────────────────
const ip2n = (ip) => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !(x >= 0 && x <= 255) || Number.isNaN(x))) throw new Error(`Bad IPv4 address ${ip}`);
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
};
const n2ip = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
export function cidr(s) {
  const m = /^\s*([\d.]+)(?:\/(\d{1,2}))?\s*$/.exec(String(s));
  if (!m) throw new Error("e.g. 10.0.0.0/24");
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (bits > 32) throw new Error("The prefix is 0–32");
  const ip = ip2n(m[1]);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  const net = (ip & mask) >>> 0;
  const bcast = (net | (~mask >>> 0)) >>> 0;
  const total = 2 ** (32 - bits);
  return {
    network: `${n2ip(net)}/${bits}`, netmask: n2ip(mask), wildcard: n2ip(~mask >>> 0), broadcast: n2ip(bcast),
    "first host": n2ip(bits >= 31 ? net : net + 1), "last host": n2ip(bits >= 31 ? bcast : bcast - 1),
    hosts: String(bits >= 31 ? total : total - 2), "addresses": String(total),
    private: /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.)/.test(n2ip(net)) ? "yes (RFC 1918 / loopback)" : "no",
  };
}

export function parseUrl(s) {
  const u = new URL(String(s).trim());
  const q = [...u.searchParams.entries()];
  return [
    { label: "protocol", value: u.protocol.replace(/:$/, "") }, { label: "host", value: u.hostname }, { label: "port", value: u.port || "(default)" },
    { label: "path", value: decodeURIComponent(u.pathname) }, ...(u.username ? [{ label: "user", value: u.username }] : []),
    ...q.map(([k, v]) => ({ label: `?${k}`, value: v })), ...(u.hash ? [{ label: "hash", value: decodeURIComponent(u.hash.slice(1)) }] : []),
    { label: "origin", value: u.origin },
  ];
}

export const MIME = {
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", json: "application/json", xml: "application/xml",
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", yaml: "application/yaml", yml: "application/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/vnd.microsoft.icon",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  pdf: "application/pdf", zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm", bin: "application/octet-stream", sh: "application/x-sh", form: "application/x-www-form-urlencoded", multipart: "multipart/form-data",
};

export function parseUserAgent(ua) {
  const s = String(ua ?? "");
  const pick = (res) => { for (const [re, name] of res) { const m = re.exec(s); if (m) return `${name}${m[1] ? ` ${m[1].replace(/_/g, ".")}` : ""}`; } return "unknown"; };
  return {
    browser: pick([[/Edg\/([\d.]+)/, "Edge"], [/OPR\/([\d.]+)/, "Opera"], [/Firefox\/([\d.]+)/, "Firefox"], [/Chrome\/([\d.]+)/, "Chrome"], [/Version\/([\d.]+).*Safari/, "Safari"], [/curl\/([\d.]+)/, "curl"], [/PostmanRuntime\/([\d.]+)/, "Postman"]]),
    os: pick([[/Windows NT ([\d.]+)/, "Windows NT"], [/Mac OS X ([\d_]+)/, "macOS"], [/Android ([\d.]+)/, "Android"], [/(?:iPhone|CPU) OS ([\d_]+)/, "iOS"], [/CrOS/, "ChromeOS"], [/Linux/, "Linux"]]),
    engine: pick([[/AppleWebKit\/([\d.]+)/, "WebKit"], [/Gecko\/([\d]+)/, "Gecko"], [/Trident\/([\d.]+)/, "Trident"]]),
    device: /Mobile|iPhone|Android.*Mobile/.test(s) ? "mobile" : /iPad|Tablet/.test(s) ? "tablet" : /bot|crawl|spider/i.test(s) ? "bot" : "desktop",
  };
}

// ── the registry ───────────────────────────────────────────────────────────────────────
const T = (group, id, name, keys, spec) => ({ group, id, name, keys, inputs: [{ id: "in", label: "Input", multi: true }], options: [], ...spec });
const two = (label1, label2, ph1, ph2) => [{ id: "in", label: label1, multi: true, placeholder: ph1 }, { id: "in2", label: label2, multi: true, placeholder: ph2 }];
const opt = (id, label, choices, value) => ({ id, label, choices, value: value ?? choices[0] });

export const TOOLS = [
  // Encode
  T("Encode", "base64", "Base64", "b64 encode decode", { options: [opt("mode", "Mode", ["encode", "decode"]), opt("variant", "Alphabet", ["standard", "url-safe"])],
    run: (i, o) => tryRun(() => (o.mode === "decode" ? ok(fromUtf8(fromB64(i.in))) : ok(o.variant === "url-safe" ? b64url(utf8(i.in)) : toB64(utf8(i.in))))) }),
  T("Encode", "url", "URL Encode / Decode", "percent uri component", { options: [opt("mode", "Mode", ["encode", "decode"]), opt("scope", "Encode", ["component", "full URL"])],
    run: (i, o) => tryRun(() => ok(o.mode === "decode" ? decodeURIComponent(String(i.in).replace(/\+/g, " ")) : o.scope === "full URL" ? encodeURI(i.in) : encodeURIComponent(i.in))) }),
  T("Encode", "query", "Query String ⇄ JSON", "querystring params form", { options: [opt("mode", "Direction", ["query → JSON", "JSON → query"])],
    run: (i, o) => tryRun(() => {
      if (o.mode === "JSON → query") return ok(new URLSearchParams(Object.entries(parseJsonAt(i.in)).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, typeof v === "object" ? JSON.stringify(v) : String(v)]]))).toString());
      const q = String(i.in).trim().replace(/^[^?]*\?/, "");
      const out = {};
      for (const [k, v] of new URLSearchParams(q)) out[k] = k in out ? [].concat(out[k], v) : v;
      return ok(JSON.stringify(out, null, 2));
    }) }),
  T("Encode", "html", "HTML Entities", "escape unescape entity", { options: [opt("mode", "Mode", ["encode", "decode"])],
    run: (i, o) => {
      const s = String(i.in ?? "");
      if (o.mode === "encode") return ok(s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"));
      const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–" };
      return ok(s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : named[e.toLowerCase()] ?? all)));
    } }),
  T("Encode", "escape", "String Escape", "json string backslash quote unescape", { options: [opt("mode", "Mode", ["escape", "unescape"])],
    run: (i, o) => tryRun(() => ok(o.mode === "escape" ? JSON.stringify(String(i.in)).slice(1, -1) : JSON.parse(`"${String(i.in).replace(/(^|[^\\])"/g, '$1\\"')}"`))) }),
  T("Encode", "hex", "Hex ⇄ Text", "hexadecimal bytes", { options: [opt("mode", "Mode", ["text → hex", "hex → text"])],
    run: (i, o) => tryRun(() => {
      if (o.mode === "text → hex") return ok(hex(utf8(i.in)).replace(/(..)(?!$)/g, "$1 "));
      const h = String(i.in).replace(/0x|[\s:,-]/gi, "");
      if (!/^([0-9a-f]{2})*$/i.test(h)) throw new Error("Not hex bytes");
      return ok(fromUtf8(Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))));
    }) }),
  T("Encode", "binary", "Binary ⇄ Text", "bits 01", { options: [opt("mode", "Mode", ["text → binary", "binary → text"])],
    run: (i, o) => tryRun(() => {
      if (o.mode === "text → binary") return ok([...utf8(i.in)].map((b) => b.toString(2).padStart(8, "0")).join(" "));
      const bits = String(i.in).replace(/[^01]/g, "");
      if (bits.length % 8) throw new Error("Bits must come in groups of 8");
      return ok(fromUtf8(Uint8Array.from(bits.match(/.{8}/g) ?? [], (x) => parseInt(x, 2))));
    }) }),
  T("Encode", "jwt", "JWT Decode / Verify", "json web token bearer", { inputs: [{ id: "in", label: "Token", multi: true, placeholder: "eyJhbGciOi…" }, { id: "secret", label: "Secret (to verify HS256/384/512, optional)" }],
    run: async (i) => {
      try {
        const j = decodeJwt(i.in);
        const p = j.payload;
        let verified = null;
        if (i.secret && HS[j.header.alg]) verified = (await hmac(HS[j.header.alg], i.secret, j.signed, "base64url")) === j.signature ? "✓ signature valid" : "✕ signature does NOT match this secret";
        else if (i.secret) verified = `can't verify ${j.header.alg} with a shared secret here`;
        return rows([
          { label: "header", value: JSON.stringify(j.header, null, 2) }, { label: "payload", value: JSON.stringify(p, null, 2) },
          verified ? { label: "signature", value: verified } : null,
          p.exp ? { label: "expires", value: `${when(p.exp)}${p.exp * 1000 < Date.now() ? " · EXPIRED" : ""}` } : null,
          p.iat ? { label: "issued", value: when(p.iat) } : null, p.nbf ? { label: "not before", value: when(p.nbf) } : null,
        ]);
      } catch (e) {
        return fail(e);
      }
    } }),
  T("Encode", "jwt-sign", "JWT Encode (HS)", "sign create token", { inputs: [{ id: "in", label: "Payload (JSON)", multi: true, placeholder: '{ "sub": "123", "name": "Ada" }' }, { id: "secret", label: "Secret" }],
    options: [opt("alg", "Algorithm", ["HS256", "HS384", "HS512"])],
    run: async (i, o) => { try { if (!i.secret) return fail("Enter a secret"); return ok(await signJwt(i.in, i.secret, o.alg)); } catch (e) { return fail(e); } } }),

  // Format
  T("Format", "json", "JSON Format / Validate", "pretty minify beautify lint sort", { options: [opt("mode", "Output", ["pretty", "minify", "sort keys"]), opt("indent", "Indent", ["2", "4", "tab"])],
    run: (i, o) => tryRun(() => {
      const v = parseJsonAt(i.in);
      const ind = o.indent === "tab" ? "\t" : Number(o.indent);
      return ok(o.mode === "minify" ? JSON.stringify(v) : JSON.stringify(o.mode === "sort keys" ? sortKeys(v) : v, null, ind));
    }), language: "json" }),
  T("Format", "yaml", "JSON ⇄ YAML", "yml convert", { options: [opt("mode", "Direction", ["JSON → YAML", "YAML → JSON"])],
    exec: (i, o) => ({
      cmd: "ruby",
      args: ["-ryaml", "-rjson", "-rdate", "-e", o.mode === "JSON → YAML" ? "print JSON.parse(ARGV[0]).to_yaml" : "print JSON.pretty_generate(YAML.safe_load(ARGV[0], aliases: true, permitted_classes: [Date, Time, Symbol]))", String(i.in)],
      parse: (out, err, code) => (code === 0 ? ok(out.replace(/^---\n/, "")) : fail((err || "Can't convert").trim().split("\n")[0].replace(/^-e:\d+:in [^:]+: /, ""))),
    }), language: "yaml" }),
  T("Format", "csv", "JSON ⇄ CSV", "spreadsheet table tsv", { options: [opt("mode", "Direction", ["JSON → CSV", "CSV → JSON"]), opt("sep", "Separator", [",", ";", "tab"])],
    run: (i, o) => tryRun(() => {
      const sep = o.sep === "tab" ? "\t" : o.sep;
      return ok(o.mode === "JSON → CSV" ? jsonToCsv(parseJsonAt(i.in), sep) : JSON.stringify(csvToJson(i.in, sep), null, 2));
    }) }),
  T("Format", "json-types", "JSON → TypeScript / Zod", "interface type schema", { options: [opt("mode", "Output", ["TypeScript", "Zod"])],
    run: (i, o) => tryRun(() => ok(o.mode === "Zod" ? jsonToZod(parseJsonAt(i.in)) : jsonToTs(parseJsonAt(i.in)))), language: "ts" }),
  T("Format", "jq", "jq Playground", "json query filter select map", { inputs: [{ id: "filter", label: "Filter", placeholder: ".items[] | {id, name}" }, { id: "in", label: "JSON", multi: true }],
    exec: (i) => ({ cmd: "sh", args: ["-c", 'printf "%s" "$2" | jq "$1"', "vx", String(i.filter || "."), String(i.in ?? "")],
      parse: (out, err, code) => (code === 0 ? ok(out.trimEnd()) : fail((err || "jq failed").trim().replace(/^jq: (error \(at <stdin>:\d+\): )?/, ""))) }), language: "json" }),
  T("Format", "xml", "XML Format", "pretty indent html", { run: (i) => tryRun(() => ok(formatXml(i.in))), language: "xml" }),
  T("Format", "sql", "SQL Format", "query pretty", { run: (i) => tryRun(() => ok(formatSql(i.in))), language: "sql" }),
  T("Format", "env", ".env ⇄ JSON", "dotenv environment variables", { options: [opt("mode", "Direction", [".env → JSON", "JSON → .env"])],
    run: (i, o) => tryRun(() => ok(o.mode === ".env → JSON" ? JSON.stringify(envToJson(i.in), null, 2) : jsonToEnv(parseJsonAt(i.in)))) }),
  T("Format", "markdown", "Markdown Preview", "md render", { run: (i) => ({ markdown: String(i.in ?? "") }) }),

  // Generate
  T("Generate", "uuid", "UUID / ULID / Nano ID", "guid id random v4 v7", { inputs: [{ id: "in", label: "Inspect a UUID (optional)" }], options: [opt("kind", "Kind", ["UUID v4", "UUID v7", "ULID", "Nano ID"]), opt("count", "How many", ["1", "5", "10", "50"]), opt("case", "Case", ["lower", "UPPER"])],
    run: (i, o) => {
      const info = String(i.in ?? "").trim() ? inspectUuid(i.in) : null;
      if (String(i.in ?? "").trim()) return info ? rows([{ label: "version", value: info.version }, { label: "variant", value: info.variant }, info.time ? { label: "time (v7)", value: info.time } : null]) : fail("Not a UUID");
      const make = { "UUID v4": uuidV4, "UUID v7": () => uuidV7(), ULID: () => ulid(), "Nano ID": () => nanoid() }[o.kind];
      const list = Array.from({ length: Number(o.count) }, make).map((x) => (o.case === "UPPER" ? x.toUpperCase() : x));
      return ok(list.join("\n"));
    }, live: true, noInput: true }),
  T("Generate", "password", "Password / Random String", "secret token generator strong", { inputs: [], options: [opt("length", "Length", ["12", "16", "20", "32", "64"], "20"), opt("chars", "Characters", ["all", "letters + digits", "letters", "digits", "hex"]), opt("count", "How many", ["1", "5", "10"])],
    run: (_i, o) => tryRun(() => {
      const n = Number(o.length);
      const make = () => (o.chars === "hex" ? hex(randomBytes(Math.ceil(n / 2))).slice(0, n) : password(n, { lower: o.chars !== "digits", upper: o.chars !== "digits", digits: o.chars !== "letters", symbols: o.chars === "all" }));
      return ok(Array.from({ length: Number(o.count) }, make).join("\n"));
    }), noInput: true }),
  T("Generate", "lorem", "Lorem Ipsum", "placeholder dummy text", { inputs: [], options: [opt("count", "How many", ["1", "3", "5", "10"], "3"), opt("unit", "Of", ["paragraphs", "sentences", "words"])],
    run: (_i, o) => ok(lorem(Number(o.count) * (o.unit === "words" ? 10 : 1), o.unit)), noInput: true }),
  T("Generate", "fake", "Fake Data", "mock person user json seed", { inputs: [], options: [opt("count", "People", ["3", "5", "10", "25"], "5"), opt("format", "Format", ["JSON", "CSV"])],
    run: (_i, o) => { const p = fakePeople(Number(o.count)); return ok(o.format === "CSV" ? jsonToCsv(p) : JSON.stringify(p, null, 2)); }, noInput: true }),
  T("Generate", "hash", "Hash (MD5, SHA)", "md5 sha1 sha256 sha512 checksum digest", {
    run: async (i) => {
      const s = String(i.in ?? "");
      return rows([{ label: "MD5", value: md5(s) }, { label: "SHA-1", value: await digest("SHA-1", s) }, { label: "SHA-256", value: await digest("SHA-256", s) }, { label: "SHA-384", value: await digest("SHA-384", s) }, { label: "SHA-512", value: await digest("SHA-512", s) }]);
    } }),
  T("Generate", "hmac", "HMAC", "signature webhook sha256 mac", { inputs: [{ id: "in", label: "Message", multi: true }, { id: "secret", label: "Secret key" }], options: [opt("alg", "Hash", ["SHA-256", "SHA-1", "SHA-384", "SHA-512"]), opt("out", "Output", ["hex", "base64", "base64url"])],
    run: async (i, o) => { try { return ok(await hmac(o.alg, i.secret ?? "", i.in ?? "", o.out)); } catch (e) { return fail(e); } } }),
  T("Generate", "bcrypt", "Bcrypt Hash / Verify", "password hash htpasswd", { inputs: [{ id: "in", label: "Password" }, { id: "hash", label: "Hash to verify against (optional)" }], options: [opt("cost", "Cost", ["10", "12", "8", "14"])],
    exec: (i, o) => (String(i.hash ?? "").trim()
      ? { cmd: "sh", args: ["-c", 'f=$(mktemp) && printf "u:%s\\n" "$2" > "$f" && htpasswd -vb "$f" u "$1" >/dev/null 2>&1; c=$?; rm -f "$f"; exit $c', "vx", String(i.in ?? ""), String(i.hash).trim()], parse: (_o, _e, code) => ok(code === 0 ? "✓ The password matches the hash" : "✕ The password does not match") }
      : { cmd: "htpasswd", args: ["-nbBC", o.cost, "u", String(i.in ?? "")], parse: (out, err, code) => (code === 0 ? ok(out.trim().replace(/^u:/, "")) : fail(err.trim() || "htpasswd failed")) }) }),

  // Convert
  T("Convert", "timestamp", "Unix Timestamp ⇄ Date", "epoch time date iso utc", { inputs: [{ id: "in", label: "Timestamp (s, ms, µs) or a date", placeholder: "1700000000, 2026-11-19T10:00:00Z, or now" }],
    run: (i) => tryRun(() => {
      const d = parseMoment(i.in);
      return rows([{ label: "ISO (UTC)", value: d.toISOString() }, { label: "local", value: localStamp(d) }, { label: "relative", value: relative(d.getTime()) },
        { label: "unix seconds", value: Math.floor(d.getTime() / 1000) }, { label: "unix ms", value: d.getTime() }, { label: "RFC 2822", value: d.toUTCString() },
        { label: "day", value: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()] + " (UTC)" }]);
    }), live: true }),
  T("Convert", "timezone", "Time Zones", "tz convert utc ist pst", { inputs: [{ id: "in", label: "Date and time (or now)", placeholder: "now  ·  2026-11-19 15:30" }, { id: "zones", label: "Zones", placeholder: "UTC, Asia/Kolkata, America/New_York, Europe/London" }],
    exec: (i) => {
      const d = parseMoment(i.in || "now");
      const zones = String(i.zones || "UTC, Asia/Kolkata, America/New_York, America/Los_Angeles, Europe/London, Europe/Berlin, Asia/Tokyo, Australia/Sydney").split(/[,\s]+/).filter((z) => /^[\w/+-]+$/.test(z));
      return { cmd: "sh", args: ["-c", 'e=$1; shift; for z in "$@"; do printf "%s\\t" "$z"; TZ="$z" date -r "$e" "+%Y-%m-%d %H:%M:%S %Z (UTC%z)"; done', "vx", String(Math.floor(d.getTime() / 1000)), ...zones],
        parse: (out) => rows(out.trim().split("\n").map((l) => { const [z, v] = l.split("\t"); return { label: z, value: v }; })) };
    } }),
  T("Convert", "base", "Number Base", "hex binary octal decimal radix", { inputs: [{ id: "in", label: "Number", placeholder: "255, 0xff, 0b1010, 0o17" }],
    run: (i) => tryRun(() => {
      const n = parseNumber(i.in);
      const neg = n < 0n, a = neg ? -n : n, s = neg ? "-" : "";
      return rows([{ label: "decimal", value: `${s}${a.toString(10)}` }, { label: "hex", value: `${s}0x${a.toString(16)}` }, { label: "binary", value: `${s}0b${a.toString(2).replace(/\B(?=(\d{4})+(?!\d))/g, "_")}` }, { label: "octal", value: `${s}0o${a.toString(8)}` }, { label: "base 36", value: `${s}${a.toString(36)}` }]);
    }), live: true }),
  T("Convert", "color", "Color", "hex rgb hsl oklch css colour", { inputs: [{ id: "in", label: "Color", placeholder: "#8143FD, rgb(129 67 253), hsl(260 98% 63%)" }],
    run: (i) => tryRun(() => {
      const c = parseColor(i.in);
      const [h, s, l] = rgbToHsl(c.r, c.g, c.b);
      const hx = `#${hex([c.r, c.g, c.b])}${c.a < 1 ? hex([Math.round(c.a * 255)]) : ""}`;
      const lum = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const L = 0.2126 * lum(c.r) + 0.7152 * lum(c.g) + 0.0722 * lum(c.b);
      return { ...rows([{ label: "hex", value: hx }, { label: "rgb", value: c.a < 1 ? `rgb(${c.r} ${c.g} ${c.b} / ${+c.a.toFixed(2)})` : `rgb(${c.r} ${c.g} ${c.b})` }, { label: "hsl", value: `hsl(${h} ${s}% ${l}%)` }, { label: "oklch", value: toOklch(c.r, c.g, c.b) }, { label: "contrast on white", value: `${((1.05) / (L + 0.05)).toFixed(2)}:1` }, { label: "contrast on black", value: `${((L + 0.05) / 0.05).toFixed(2)}:1` }]), swatch: `#${hex([c.r, c.g, c.b])}` };
    }), live: true }),
  T("Convert", "case", "Text Case", "camel snake kebab pascal constant title", { inputs: [{ id: "in", label: "Text", placeholder: "userAccountId, user_account_id, User Account ID" }],
    run: (i) => { const w = words(i.in); return rows(Object.entries(CASES).map(([k, f]) => ({ label: k, value: f(w) }))); }, live: true }),
  T("Convert", "bytes", "Byte Size", "kb mb gb kib mib storage", { inputs: [{ id: "in", label: "Size", placeholder: "1.5 GB, 512 MiB, 1048576" }],
    run: (i) => tryRun(() => { const n = parseBytes(i.in); const f = formatBytesExact(n); return rows([{ label: "bytes", value: String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",") }, { label: "decimal (SI)", value: f.decimal }, { label: "binary (IEC)", value: f.binary }, { label: "bits", value: n * 8 }]); }), live: true }),
  T("Convert", "rem", "px ⇄ rem", "css units em", { inputs: [{ id: "in", label: "Value", placeholder: "24px or 1.5rem" }, { id: "base", label: "Root font size (px)", placeholder: "16" }],
    run: (i) => tryRun(() => {
      const base = Number(i.base) || 16;
      const m = /^\s*([\d.]+)\s*(px|rem|em)?\s*$/i.exec(String(i.in));
      if (!m) throw new Error("e.g. 24px or 1.5rem");
      const v = Number(m[1]);
      const px = (m[2] ?? "px").toLowerCase() === "px" ? v : v * base;
      return rows([{ label: "px", value: `${+px.toFixed(3)}px` }, { label: "rem", value: `${+(px / base).toFixed(4)}rem` }, { label: "pt", value: `${+(px * 0.75).toFixed(2)}pt` }]);
    }), live: true }),
  T("Convert", "chmod", "chmod Calculator", "permissions octal unix rwx", { inputs: [{ id: "in", label: "Mode", placeholder: "755 or rwxr-xr-x" }],
    run: (i) => tryRun(() => rows(Object.entries(chmod(i.in)).map(([label, value]) => ({ label, value })))), live: true }),
  T("Convert", "cron", "Cron Explainer", "crontab schedule next run", { inputs: [{ id: "in", label: "Cron line", placeholder: "*/15 9-18 * * 1-5" }],
    run: (i) => tryRun(() => rows([{ label: "means", value: describeCron(i.in) }, ...cronNext(i.in).map((d, n) => ({ label: n === 0 ? "next runs" : "", value: `${localStamp(d)}  (${relative(d.getTime())})` }))])), live: true }),
  T("Convert", "curl", "cURL → Code", "fetch axios python requests httpie convert", { inputs: [{ id: "in", label: "cURL command", multi: true }], options: [opt("lang", "To", Object.values(SNIPPETS).map(([l]) => l).filter((l) => l !== "cURL"))],
    run: (i, o) => tryRun(() => { const fn = Object.values(SNIPPETS).find(([l]) => l === o.lang)[1]; return ok(fn(resolveRequest(parseCurl(i.in), {}))); }) }),

  // Text
  T("Text", "diff", "Text Diff", "compare difference changes", { inputs: two("Original", "Changed"), run: (i) => tryRun(() => ({ diff: diffLines(i.in, i.in2) })) }),
  T("Text", "regex", "Regex Tester", "regular expression match replace", { inputs: [{ id: "pattern", label: "Pattern", placeholder: "(\\w+)@(\\w+)\\.com" }, { id: "flags", label: "Flags", placeholder: "gi" }, { id: "in", label: "Text", multi: true }, { id: "replace", label: "Replace with (optional, $1 for groups)" }],
    run: (i) => tryRun(() => {
      if (!i.pattern) return ok("");
      const r = regexTest(i.pattern, i.flags || "g", i.in ?? "", i.replace);
      return rows([{ label: "matches", value: String(r.matches.length) }, ...r.matches.slice(0, 100).map((m, n) => ({ label: `#${n + 1} @${m.index}`, value: m.groups.length ? `${m.match}   →  ${m.groups.map((g, k) => `$${k + 1}=${g ?? ""}`).join("  ")}` : m.match })), r.replaced !== undefined ? { label: "replaced", value: r.replaced } : null]);
    }) }),
  T("Text", "stats", "Text Statistics", "count words characters lines bytes", { run: (i) => rows(Object.entries(textStats(i.in)).map(([label, value]) => ({ label, value }))), live: true }),
  T("Text", "lines", "Sort / Dedupe Lines", "sort unique reverse shuffle trim lines", { options: [opt("op", "Do", ["sort", "sort desc", "sort numeric", "unique", "reverse", "shuffle", "trim", "remove empty", "number", "join with ,"])],
    run: (i, o) => ok(lineTool(i.in, o.op)) }),
  T("Text", "slug", "Slugify", "url slug kebab", { run: (i) => ok(lines(i.in).map(slugify).join("\n")), live: true }),
  T("Text", "inspect", "String Inspector", "unicode code point utf8 characters", { run: (i) => rows(codePoints(i.in).map((c) => ({ label: c.char, value: `${c.cp}  dec ${c.dec}  utf-8 ${c.utf8}` }))), live: true }),

  // Network
  T("Network", "urlparse", "URL Parser", "parse url query host path", { inputs: [{ id: "in", label: "URL", placeholder: "https://api.example.com:8443/v1/items?id=7#top" }], run: (i) => tryRun(() => rows(parseUrl(i.in))), live: true }),
  T("Network", "cidr", "IP / CIDR Calculator", "subnet netmask ip range ipv4", { inputs: [{ id: "in", label: "CIDR", placeholder: "10.0.0.0/24" }], run: (i) => tryRun(() => rows(Object.entries(cidr(i.in)).map(([label, value]) => ({ label, value })))), live: true }),
  T("Network", "dns", "DNS Lookup", "dig nslookup a aaaa mx txt cname ns", { inputs: [{ id: "in", label: "Domain", placeholder: "example.com" }], options: [opt("type", "Record", ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA"])],
    exec: (i, o) => ({ cmd: "dig", args: ["+noall", "+answer", "+time=4", "+tries=1", String(i.in).trim().replace(/^https?:\/\//, "").split("/")[0], o.type], parse: (out, err, code) => (code !== 0 ? fail(err.trim() || "dig failed") : out.trim() ? ok(out.trim().replace(/[ \t]+/g, "  ")) : ok(`No ${o.type} records`)) }) }),
  T("Network", "status", "HTTP Status Codes", "status code reference 404 500", { inputs: [{ id: "in", label: "Code or word", placeholder: "404, 5, gateway" }],
    run: (i) => { const q = String(i.in ?? "").trim().toLowerCase(); return rows(Object.entries(STATUS).filter(([c, t]) => !q || c.startsWith(q) || t.toLowerCase().includes(q)).map(([c, t]) => ({ label: c, value: t }))); }, live: true }),
  T("Network", "mime", "MIME Types", "content type extension", { inputs: [{ id: "in", label: "Extension or type", placeholder: "png, json, application/pdf" }],
    run: (i) => { const q = String(i.in ?? "").trim().toLowerCase().replace(/^\./, ""); return rows(Object.entries(MIME).filter(([e, m]) => !q || e.startsWith(q) || m.includes(q)).map(([e, m]) => ({ label: `.${e}`, value: m }))); }, live: true }),
  T("Network", "ua", "User-Agent Parser", "browser os device", { inputs: [{ id: "in", label: "User-Agent", multi: true }], run: (i) => rows(Object.entries(parseUserAgent(i.in)).map(([label, value]) => ({ label, value }))), live: true }),
];

export const toolById = (id) => TOOLS.find((t) => t.id === id) ?? null;
export const defaultOptions = (tool) => Object.fromEntries((tool.options ?? []).map((o) => [o.id, o.value]));

export function searchTools(q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return TOOLS;
  return TOOLS.filter((t) => `${t.name} ${t.keys} ${t.group}`.toLowerCase().includes(s));
}

// ── what a pasted value looks like (the popup offers matching tools with results) ──────
export function detect(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  const out = [];
  const add = (tool, input = {}, options = {}) => out.push({ tool, input: { in: s, ...input }, options });
  if (/^eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*$/.test(s)) add("jwt");
  if (/^-?\d{9,19}(\.\d+)?$/.test(s) || /^\d{4}-\d{2}-\d{2}([T ][\d:.]+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) add("timestamp");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) add("uuid");
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(s)) add("color");
  if (/^[a-z][\w+.-]*:\/\/\S+$/i.test(s)) add("urlparse");
  if (/^curl\s/.test(s)) add("curl");
  if (/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(s)) add("cidr");
  if (/^(@\w+|(\S+\s+){4}\S+)$/.test(s) && /^[\d*/,@a-z\s-]+$/i.test(s) && !/^\d+$/.test(s)) { try { parseCron(s); add("cron"); } catch {} }
  if (/^[[{]/.test(s)) { try { JSON.parse(s); add("json"); add("json-types"); } catch {} }
  if (/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+)$/i.test(s)) add("base");
  if (/^[0-7]{3,4}$/.test(s) || /^[-dl]?([r-][w-][xsS-]){3}$/.test(s)) add("chmod");
  if (s.length >= 8 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s) && !/^\d+$/.test(s)) {
    try {
      const t = fromUtf8(fromB64(s));
      if (/^[\x09\x0a\x0d\x20-\x7e\u00a0-\uffff]*$/.test(t) && !t.includes("\ufffd")) add("base64", {}, { mode: "decode" });
    } catch {}
  }
  if (/%[0-9a-f]{2}/i.test(s)) add("url", {}, { mode: "decode" });
  if (/&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s)) add("html", {}, { mode: "decode" });
  if (/^\d+(\.\d+)?\s*(k|m|g|t)i?b$/i.test(s)) add("bytes");
  if (/^\d+(\.\d+)?\s*(px|rem)$/i.test(s)) add("rem");
  if (/^[1-5]\d\d$/.test(s)) add("status");
  if (/Mozilla\/|AppleWebKit|curl\/\d/.test(s)) add("ua");
  if (!out.length && s.length < 200) { add("hash"); add("case"); add("base64"); }
  return out.slice(0, 6);
}

// Runs a pure tool, or says the tool needs a program (the mod runs exec tools itself).
export async function runTool(tool, input, options) {
  if (tool.run) return tool.run(input, { ...defaultOptions(tool), ...options });
  return { needsExec: true };
}
