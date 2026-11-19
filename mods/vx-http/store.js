// Where vx-http keeps things.
//   <repo>/.vx/http/<slug>.json      collections (shareable: commit them)
//   <repo>/.vx/http/environments.json  { envs: { name: { var: value } } } (shareable)
//   <repo>/.vx/http/.secrets.json    the values you marked secret, same shape (gitignored)
//   ~/.config/herdr-app/data/vx-http/state.json   per user: active env per repo, captured values
//   ~/.config/herdr-app/data/vx-http/history.json per user: the last 100 requests sent
// Copies talk through shared state: vx.http.rev (bumped after any write: re-read), vx.http.env
// ({ [repo]: env name }), vx.http.runtime ({ [repo]: { var: value } } captured by tests).
import { exec, readTextFile, appHome, shared, setShared } from "herdr";
import { writeText } from "./ws.js";
import { GITIGNORE, slugify, newCollection, envVars } from "./http-core.js";

export const httpDir = (repo) => `${repo}/.vx/http`;
const dataDir = () => `${appHome()}/data/vx-http`;
const RESERVED = new Set(["environments.json", ".secrets.json"]);

export const bumpRev = () => setShared("vx.http.rev", Date.now());
export const rev = () => shared("vx.http.rev") ?? 0;

async function readJson(path, fallback) {
  const text = await readTextFile(path).catch(() => null);
  if (text === null || text === undefined || !text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path.split("/").pop()} isn't valid JSON`);
  }
}

async function ensureDir(repo) {
  const dir = httpDir(repo);
  await exec("mkdir", ["-p", dir]);
  // The secrets file never goes into git: a .gitignore next to it says so (written once).
  const gi = await readTextFile(`${dir}/.gitignore`).catch(() => null);
  if (gi === null) await writeText(`${dir}/.gitignore`, GITIGNORE);
  return dir;
}

const pretty = (v) => `${JSON.stringify(v, null, 2)}\n`;

// Every collection of a repo: [{ file, slug, collection }] sorted by name.
export async function loadCollections(repo) {
  const dir = httpDir(repo);
  const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; for f in *.json; do [ -f "$f" ] && printf "%s\\n" "$f"; done', "vx-http", dir]).catch(() => null);
  const files = (r?.stdout ?? "").split("\n").filter((f) => f && !RESERVED.has(f) && !f.endsWith(".postman.json"));
  const out = [];
  for (const f of files) {
    try {
      const c = await readJson(`${dir}/${f}`, null);
      if (c && Array.isArray(c.items)) out.push({ file: `${dir}/${f}`, slug: f.replace(/\.json$/, ""), collection: c });
    } catch (e) {
      out.push({ file: `${dir}/${f}`, slug: f.replace(/\.json$/, ""), collection: { name: f, items: [] }, error: String(e.message ?? e) });
    }
  }
  return out.sort((a, b) => a.collection.name.localeCompare(b.collection.name));
}

export async function readCollection(file) {
  return readJson(file, null);
}

export async function writeCollection(file, collection) {
  await exec("mkdir", ["-p", file.slice(0, file.lastIndexOf("/"))]);
  await writeText(file, pretty(collection));
  bumpRev();
}

// A new collection file with a free name: <slug>.json, <slug>-2.json, …
export async function createCollection(repo, name, items = []) {
  const dir = await ensureDir(repo);
  const base = slugify(name);
  let file = `${dir}/${base}.json`;
  for (let i = 2; (await readTextFile(file).catch(() => null)) !== null; i++) file = `${dir}/${base}-${i}.json`;
  const c = { ...newCollection(name), items };
  await writeCollection(file, c);
  return file;
}

// Read, change, write: what another copy saved meanwhile is kept.
export async function editCollection(file, fn) {
  const c = (await readCollection(file)) ?? newCollection("Collection");
  const next = fn(c) ?? c;
  await writeCollection(file, next);
  return next;
}

export async function deleteCollection(file) {
  const r = await exec("trash", [file]).catch(() => null);
  if (r?.code !== 0) await exec("rm", ["-f", "--", file]);
  bumpRev();
}

// ── environments ───────────────────────────────────────────────────────────────────────
export async function loadEnvs(repo) {
  const dir = httpDir(repo);
  const [envs, secrets] = await Promise.all([readJson(`${dir}/environments.json`, { envs: {} }), readJson(`${dir}/.secrets.json`, { envs: {} })]);
  return { envs: { envs: envs.envs ?? {} }, secrets: { envs: secrets.envs ?? {} } };
}

// rows: [{ key, value, secret }] for one env; secrets go to .secrets.json, the rest to environments.json.
export async function saveEnv(repo, name, rows, { rename } = {}) {
  const dir = await ensureDir(repo);
  const { envs, secrets } = await loadEnvs(repo);
  const open = {}, hidden = {};
  for (const r of rows) {
    if (!String(r.key ?? "").trim()) continue;
    if (r.secret) hidden[r.key.trim()] = r.value ?? "";
    else open[r.key.trim()] = r.value ?? "";
  }
  if (rename && rename !== name) {
    delete envs.envs[rename];
    delete secrets.envs[rename];
  }
  envs.envs[name] = open;
  secrets.envs[name] = hidden;
  await writeText(`${dir}/environments.json`, pretty(envs));
  await writeText(`${dir}/.secrets.json`, pretty(secrets));
  bumpRev();
}

export async function deleteEnv(repo, name) {
  const dir = httpDir(repo);
  const { envs, secrets } = await loadEnvs(repo);
  delete envs.envs[name];
  delete secrets.envs[name];
  await writeText(`${dir}/environments.json`, pretty(envs));
  await writeText(`${dir}/.secrets.json`, pretty(secrets));
  if (activeEnv(repo) === name) setActiveEnv(repo, null);
  bumpRev();
}

// ── per-user state ─────────────────────────────────────────────────────────────────────
export const activeEnv = (repo) => (shared("vx.http.env") ?? {})[repo] ?? null;
export const runtimeVars = (repo) => (shared("vx.http.runtime") ?? {})[repo] ?? {};

export function setActiveEnv(repo, name) {
  setShared("vx.http.env", { ...(shared("vx.http.env") ?? {}), [repo]: name });
  saveState();
}

export function addRuntime(repo, vars) {
  if (!Object.keys(vars).length) return;
  const all = shared("vx.http.runtime") ?? {};
  setShared("vx.http.runtime", { ...all, [repo]: { ...(all[repo] ?? {}), ...vars } });
  saveState();
}

export function clearRuntime(repo) {
  const all = { ...(shared("vx.http.runtime") ?? {}) };
  delete all[repo];
  setShared("vx.http.runtime", all);
  saveState();
}

function saveState() {
  const state = { env: shared("vx.http.env") ?? {}, runtime: shared("vx.http.runtime") ?? {} };
  exec("mkdir", ["-p", dataDir()]).then(() => writeText(`${dataDir()}/state.json`, pretty(state))).catch(() => {});
}

// Once per app start: shared state is empty, so fill it from state.json.
export async function loadState() {
  if (shared("vx.http.env") || shared("vx.http.runtime")) return;
  const s = await readJson(`${dataDir()}/state.json`, {}).catch(() => ({}));
  setShared("vx.http.env", s.env ?? {});
  setShared("vx.http.runtime", s.runtime ?? {});
}

// Variables for a repo: the active environment (with its secrets), then captured values on top.
export function varsFor(repo, envData) {
  return { ...envVars(envData?.envs, envData?.secrets, activeEnv(repo)), ...runtimeVars(repo) };
}

// ── history ────────────────────────────────────────────────────────────────────────────
export async function loadHistory() {
  return readJson(`${dataDir()}/history.json`, []).catch(() => []);
}

export async function addHistory(entry) {
  const list = await loadHistory();
  const next = [entry, ...list].slice(0, 100);
  await exec("mkdir", ["-p", dataDir()]);
  await writeText(`${dataDir()}/history.json`, pretty(next));
  setShared("vx.http.history", Date.now());
}

export async function clearHistory() {
  await exec("mkdir", ["-p", dataDir()]);
  await writeText(`${dataDir()}/history.json`, "[]\n");
  setShared("vx.http.history", Date.now());
}
