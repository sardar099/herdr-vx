// The workspace model, pure: which folders a workspace has, and which repo a mod should show.
// No Herdr calls here (ws.js has those), so the rules are tested under node.

export const baseName = (p) => String(p ?? "").replace(/\/+$/, "").split("/").pop() || "/";
export const parentOf = (p) => {
  const s = String(p ?? "").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i <= 0 ? "/" : s.slice(0, i);
};

// An absolute path with "." and ".." folded away. `rel` may itself be absolute.
export function resolvePath(base, rel) {
  const r = String(rel ?? "");
  const parts = r.startsWith("/") ? [] : String(base ?? "/").split("/");
  for (const part of r.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.length > 1 && parts.pop();
    else parts.push(part);
  }
  const out = parts.filter((x, i) => x || i === 0).join("/");
  return out.startsWith("/") ? out : `/${out}`;
}

// A parsed .code-workspace file as roots, in the file's order. Paths are relative to the file.
export function rootsFromWorkspace(file, json) {
  const dir = parentOf(file);
  const seen = new Set();
  const roots = [];
  for (const folder of Array.isArray(json?.folders) ? json.folders : []) {
    if (!folder || typeof folder.path !== "string") continue;
    const path = resolvePath(dir, folder.path);
    if (seen.has(path)) continue;
    seen.add(path);
    roots.push({ name: typeof folder.name === "string" && folder.name ? folder.name : baseName(path), path });
  }
  return roots;
}

export const workspaceName = (file) => baseName(file).replace(/\.code-workspace$/, "");

// The workspace root holding `cwd` (the deepest, for nested roots), or null.
export function rootFor(cwd, roots) {
  if (!cwd) return null;
  let best = null;
  for (const root of roots ?? []) {
    if (cwd === root.path || cwd.startsWith(`${root.path}/`)) {
      if (!best || root.path.length > best.path.length) best = root;
    }
  }
  return best;
}

/**
 * Which folder a mod shows, and why.
 * focus: { cwd, branch, on } for the focused terminal (cwd null for a mod pane or none).
 * active: { root, on, name, by } -- by "pick" when you chose it (a panel's repo switcher, a
 * click in Files); vx-workspace turns a pick into "click" as soon as focus moves elsewhere.
 * Rules, first that applies:
 *   0. a repo you just picked                           -> that repo      ("picked")
 *   1. the focused terminal is inside a workspace root  -> that root      ("root")
 *   2. the focused terminal is inside some other repo   -> its folder     ("repo")
 *   3. the repo picked earlier                          -> that repo      ("active")
 *   4. the focused terminal's folder, else the space's  -> that folder    ("focus" | "space")
 */
export function chooseContext({ focus, roots, active, spaceFolder }) {
  const on = focus?.on ?? null;
  const cwd = focus?.cwd ?? null;
  if (active?.root && active.by === "pick") {
    return { cwd: active.root, on: active.on ?? null, source: "picked", root: rootFor(active.root, roots) };
  }
  const root = on === null ? rootFor(cwd, roots) : null;
  if (root) return { cwd: root.path, on: null, source: "root", root };
  if (cwd && focus?.branch) return { cwd, on, source: "repo", root: null };
  if (active?.root) {
    return { cwd: active.root, on: active.on ?? null, source: "active", root: rootFor(active.root, roots) };
  }
  if (cwd) return { cwd, on, source: "focus", root: null };
  return { cwd: spaceFolder ?? null, on: null, source: "space", root: null };
}

export const contextKey = (c) => JSON.stringify([c?.cwd ?? null, c?.on ?? null]);

// ── editing a .code-workspace, the way VS Code does ─────────────────────────────────────

// `to` relative to `fromDir` ("../x"), for folders written into a workspace file.
export function relativePath(fromDir, to) {
  const a = resolvePath("/", fromDir).split("/").filter(Boolean);
  const b = resolvePath("/", to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  return [...up, ...b.slice(i)].join("/") || ".";
}

// A folder as VS Code writes it: relative to the file when that's no more than two levels up,
// absolute otherwise; `name` only when it differs from the folder's own name.
export function folderEntry(fileDir, path, name) {
  const rel = relativePath(fileDir, path);
  const entry = { path: rel.split("/").filter((p) => p === "..").length > 2 ? path : rel };
  if (name && name !== baseName(path)) entry.name = name;
  return entry;
}

// One edit to a parsed workspace file; folders are matched by their resolved path.
//   { type: "add", paths }  { type: "remove", path }  { type: "rename", path, name }
//   { type: "move", path, to }   (to: the new index)
export function editFolders(json, fileDir, op) {
  const out = { ...json, folders: [...(Array.isArray(json?.folders) ? json.folders : [])] };
  const at = (path) => out.folders.findIndex((f) => typeof f?.path === "string" && resolvePath(fileDir, f.path) === path);
  if (op.type === "add") {
    for (const p of op.paths) if (at(p) < 0) out.folders.push(folderEntry(fileDir, p));
  } else if (op.type === "remove") {
    const i = at(op.path);
    if (i >= 0) out.folders.splice(i, 1);
  } else if (op.type === "rename") {
    const i = at(op.path);
    if (i >= 0) {
      const f = { ...out.folders[i] };
      if (op.name && op.name !== baseName(op.path)) f.name = op.name;
      else delete f.name;
      out.folders[i] = f;
    }
  } else if (op.type === "move") {
    const i = at(op.path);
    if (i >= 0) {
      const [f] = out.folders.splice(i, 1);
      out.folders.splice(Math.max(0, Math.min(out.folders.length, op.to)), 0, f);
    }
  }
  return out;
}

// VS Code writes workspace files with tabs.
export const stringifyWorkspace = (json) => `${JSON.stringify(json, null, "\t")}\n`;

// A new workspace file's JSON for some folders.
export const newWorkspace = (fileDir, paths) => ({ folders: paths.map((p) => folderEntry(fileDir, p)), settings: {} });
