// The workspace context every vx mod shares (the Herdr side; the rules are in ws-core.js).
//   shared("vx.workspace") = { file, name, roots: [{ name, path }] }   written by vx-workspace only
//   shared("vx.active")    = { root, on, name, by, at }                 the repo picked in Workspace
//   shared("vx.changed")   = { root, at }                                someone changed a repo: reread
import { spaces, panes, focused, shared, setShared, exec, readTextFile } from "herdr";
import { chooseContext, contextKey, rootsFromWorkspace, workspaceName, rootFor, baseName } from "./ws-core.js";
import { parseJsonc } from "./jsonc.js";
import { READ } from "./git-core.js";

export { contextKey, rootFor, baseName };

// What has focus: a terminal (pane or layout block) with its folder and branch, or a mod pane.
export function focusInfo() {
  const f = focused();
  const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active) ?? null;
  const machine = space?.machine ?? null;
  if (f && f.pane === null && f.terminal) {
    const on = f.terminal.includes("/") ? f.terminal.split("/")[0] : null;
    return { cwd: f.cwd ?? null, branch: null, on, terminal: f.terminal, pane: null, space };
  }
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) ?? null : null;
  if (!pane || pane.mod || !pane.terminal) return { cwd: null, branch: null, on: machine, terminal: null, pane, space };
  return { cwd: pane.cwd ?? null, branch: pane.branch ?? null, on: machine, terminal: pane.terminal, pane, space };
}

export const workspace = () => shared("vx.workspace") ?? null;
export const active = () => shared("vx.active") ?? null;

// The folder this mod shows, why ("root" | "repo" | "active" | "focus" | "space"), and the focus.
export function ctx() {
  const focus = focusInfo();
  return {
    ...chooseContext({ focus, roots: workspace()?.roots ?? [], active: active(), spaceFolder: focus.space?.folder ?? null }),
    focus,
  };
}

// by "pick": you chose it (wins over the focused terminal until focus moves); "focus": followed.
export function setActive(root, by = "pick") {
  const cur = active();
  if (cur?.root === root.path && cur?.by === by) return;
  setShared("vx.active", { root: root.path, on: root.on ?? null, name: root.name, by, at: Date.now() });
}

// Tell every vx mod that a repo changed (after stage, commit, pull...).
export const bump = (root) => setShared("vx.changed", { root: root ?? null, at: Date.now() });
export const changedAt = () => shared("vx.changed")?.at ?? 0;

export const git = (args, { cwd, on = null, timeout } = {}) =>
  exec("git", [...READ, ...args], { cwd, on, ...(timeout ? { timeout } : {}) });

// The repository top for a folder, or null. Cached per copy (pass the copy's own Map).
export async function repoTop(cache, cwd, on) {
  const key = `${on ?? ""}|${cwd}`;
  if (cache.has(key)) return cache.get(key);
  const r = await git(["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
  const top = r?.code === 0 ? r.stdout.trim() : null;
  cache.set(key, top);
  return top;
}

// The nearest *.code-workspace at or above `dir` (stopping at home), or null.
const FIND_WS = 'd="$1"; while :; do for f in "$d"/*.code-workspace; do [ -f "$f" ] && { printf "%s" "$f"; exit 0; }; done; [ "$d" = "$HOME" ] || [ "$d" = "/" ] || [ -z "$d" ] && exit 1; d=$(dirname "$d"); done';
export async function findWorkspaceFile(dir) {
  if (!dir) return null;
  const r = await exec("sh", ["-c", FIND_WS, "vx-ws", dir]).catch(() => null);
  return r?.code === 0 && r.stdout ? r.stdout : null;
}

// A folder with no workspace file: its immediate subfolders that are git repos.
const GIT_CHILDREN = 'for d in "$1"/*/; do [ -e "${d}.git" ] && printf "%s\\n" "${d%/}"; done; exit 0';
export async function folderRoots(dir) {
  const r = await exec("sh", ["-c", GIT_CHILDREN, "vx-ws", dir]).catch(() => null);
  return (r?.stdout ?? "").split("\n").filter(Boolean).map((path) => ({ name: baseName(path), path }));
}

export async function loadWorkspace(file) {
  const text = await readTextFile(file);
  if (text === null) throw new Error(`${file} is gone`);
  return { file, name: workspaceName(file), roots: rootsFromWorkspace(file, parseJsonc(text)) };
}

// ── writing workspace files ─────────────────────────────────────────────────────────────
import { editFolders, stringifyWorkspace, parentOf } from "./ws-core.js";
import { stripJsonc } from "./jsonc.js";

// Atomic write (temp file, then rename); the text goes as an argument, never into the script.
const WRITE = 'tmp="$1.vx-tmp" && printf "%s" "$2" > "$tmp" && mv -f -- "$tmp" "$1"';
export async function writeText(path, text, on = null) {
  const r = await exec("sh", ["-c", WRITE, "vx-write", path, text], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `Couldn't write ${path}`);
}

// Applies one edit (see ws-core editFolders) to a .code-workspace file and returns the new
// workspace. The file is read again right before writing, so whatever VS Code saved meanwhile
// (settings, other folders) is kept; only the one edit is applied on top.
export async function editWorkspaceFile(file, op) {
  const text = await readTextFile(file);
  if (text === null) throw new Error(`${file} is gone`);
  const json = parseJsonc(text);
  const next = editFolders(json, parentOf(file), op);
  const lostComments = stripJsonc(text).replace(/\s/g, "") !== text.replace(/\s/g, "");
  await writeText(file, stringifyWorkspace(next));
  return { ws: { file, name: workspaceName(file), roots: rootsFromWorkspace(file, next) }, lostComments };
}
