// Quick Open (⌘P), VS Code's: what a query asks for, file ranking with the matched letters,
// symbols of a file, and command / key labels. Pure: tested under node.
//
// A word matches a path when its letters appear in order; a contiguous hit in the file name ranks
// first, then in the path, then scattered ones (fewer gaps, more in the name). Words separated by
// spaces must all match (one may match the repo's name instead).

// One word against a path -> { score, at: [indexes in path] } or null.
function matchWord(p, q) {
  const slash = p.lastIndexOf("/");
  const name = p.slice(slash + 1);
  const range = (from, n) => Array.from({ length: n }, (_, i) => from + i);
  const inName = name.indexOf(q);
  if (inName >= 0) return { score: 10000 - (inName === 0 ? 0 : 500) - name.length - p.length / 100, at: range(slash + 1 + inName, q.length) };
  const inPath = p.indexOf(q);
  if (inPath >= 0) return { score: 5000 - p.length, at: range(inPath, q.length) };
  // Scattered: as much as possible in the name (match the tail of the query there, from the end).
  const at = [];
  let j = p.length;
  let k = q.length - 1;
  for (; k >= 0 && j > slash + 1; k--) {
    const hit = p.lastIndexOf(q[k], j - 1);
    if (hit <= slash) break;
    at.unshift(hit);
    j = hit;
  }
  let i = -1;
  const head = [];
  for (let m = 0; m <= k; m++) {
    const hit = p.indexOf(q[m], i + 1);
    if (hit < 0 || hit >= (at[0] ?? p.length)) return null;
    head.push(hit);
    i = hit;
  }
  const all = [...head, ...at];
  let gaps = 0;
  for (let n = 1; n < all.length; n++) if (all[n] !== all[n - 1] + 1) gaps++;
  return { score: 1000 + at.length * 10 - gaps * 25 - p.length / 10, at: all };
}

// -> { score, at } or null; `alsoName` (a repo name) can satisfy a word on its own.
export function matchPath(path, query, alsoName = "") {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return { score: 0, at: [] };
  const p = path.toLowerCase();
  const extra = alsoName.toLowerCase();
  let score = 0;
  const at = new Set();
  for (const w of words) {
    const m = matchWord(p, w);
    if (m) {
      score += m.score;
      for (const x of m.at) at.add(x);
    } else if (extra && extra.includes(w)) score += 500;
    else return null;
  }
  return { score, at: [...at].sort((a, b) => a - b) };
}

export function scorePath(path, query) {
  return matchPath(path, query)?.score ?? -1;
}

// Ranking thousands of files, fast: paths are lowercased once (prepareFiles), every file gets a
// cheap score (no positions), and only the best `limit` get their matched letters (matchPath).
export function prepareFiles(items) {
  return items.map((it) => {
    const p = it.rel.toLowerCase();
    return { it, p, slash: p.lastIndexOf("/"), root: (it.root?.name ?? "").toLowerCase() };
  });
}

function quickWord(p, slash, q) {
  const ni = p.indexOf(q, slash + 1);
  if (ni >= 0) return 10000 - (ni === slash + 1 ? 0 : 500) - (p.length - slash - 1) - p.length / 100;
  const pi = p.indexOf(q);
  if (pi >= 0) return 5000 - p.length;
  let at = -1;
  let gaps = 0;
  let nameHits = 0;
  for (let k = 0; k < q.length; k++) {
    const n = p.indexOf(q[k], at + 1);
    if (n < 0) return -1;
    if (k > 0 && n !== at + 1) gaps++;
    if (n > slash) nameHits++;
    at = n;
  }
  return 1000 + nameHits * 10 - gaps * 25 - p.length / 10;
}

export const queryWords = (query) => String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);

// Scores prepared[from..to) into `out` as [score, index]; call it in slices to stay responsive.
export function scoreSlice(prepared, words, from, to, out) {
  for (let i = from; i < to; i++) {
    const e = prepared[i];
    let score = 0;
    for (const w of words) {
      const s = quickWord(e.p, e.slash, w);
      if (s >= 0) score += s;
      else if (e.root && e.root.includes(w)) score += 500;
      else {
        score = -1;
        break;
      }
    }
    if (score >= 0) out.push([score, i]);
  }
  return out;
}

// The scored [score, index] pairs -> the best `limit` items, each with `score` and `at`.
export function topFiles(prepared, scored, query, limit = 60) {
  scored.sort((a, b) => b[0] - a[0] || prepared[a[1]].p.length - prepared[b[1]].p.length);
  return scored.slice(0, limit).map(([score, i]) => {
    const it = prepared[i].it;
    return { ...it, score, at: matchPath(it.rel, query, it.root?.name ?? "")?.at ?? [] };
  });
}

// items: [{ root, rel }] -> best `limit` matches, highest score first, each with `at`.
export function rankFiles(items, query, limit = 60) {
  const prepared = prepareFiles(items);
  return topFiles(prepared, scoreSlice(prepared, queryWords(query), 0, prepared.length, []), query, limit);
}

// Split a label into runs for drawing: [{ text, hit }], `at` being indexes into it.
export function runsOf(text, at = [], offset = 0) {
  const hits = new Set(at.map((x) => x - offset).filter((x) => x >= 0 && x < text.length));
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}

// What the box asks for. Prefixes as in VS Code: > commands, @ symbols, : line, % text, ? help.
export function parseQuery(raw) {
  const s = String(raw ?? "");
  const t = s.trimStart();
  if (t.startsWith(">")) return { mode: "commands", text: t.slice(1).trim() };
  if (t.startsWith("@")) return { mode: "symbols", text: t.slice(1).trim() };
  if (t.startsWith("%")) return { mode: "text", text: t.slice(1).trim() };
  if (t.startsWith("?")) return { mode: "help", text: "" };
  if (t.startsWith("~")) return { mode: "plans", text: t.slice(1).trim() };
  if (t.startsWith(":")) {
    const m = /^:(\d+)?(?::(\d+))?/.exec(t);
    return { mode: "line", text: "", line: m?.[1] ? Number(m[1]) : null, col: m?.[2] ? Number(m[2]) : null };
  }
  const m = /^(.*?)[:(](\d+)(?:[:,](\d+))?\)?\s*$/.exec(t);
  if (m && m[1].trim()) return { mode: "files", text: m[1].trim(), line: Number(m[2]), col: m[3] ? Number(m[3]) : null };
  return { mode: "files", text: t.trim() };
}

// Symbols of a source file, the way an outline would list them: classes, functions, methods,
// types, top-level consts. -> [{ name, kind, line }]
const SYMBOL_RES = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^\s*(?:export\s+)?(?:default\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=]*>)?\s*=/, "type"],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, "function"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, "variable"],
  [/^\s+(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+|get\s+|set\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\([^)]*\)?\s*(?::\s*[^={;]+)?\{\s*$/, "method"],
  [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
  [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "function"],
  [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|trait|impl)\s+([A-Za-z_]\w*)/, "class"],
  [/^#{1,6}\s+(.+?)\s*#*\s*$/, "heading"],
];
const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "else", "do", "with"]);

export function symbolsOf(text, max = 2000) {
  const out = [];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length && out.length < max; i++) {
    for (const [re, kind] of SYMBOL_RES) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (kind === "method" && NOT_METHODS.has(m[1])) break;
      out.push({ name: m[1], kind, line: i + 1 });
      break;
    }
  }
  return out;
}

// "tab.new" -> "Tab: New"; "layout.toggle:sidebar" -> "Layout: Toggle (sidebar)".
export function commandLabel(action) {
  const [name, arg] = String(action).split(/:(.*)/s);
  const parts = name.split(".");
  const word = (w) => w.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const label = parts.length > 1 ? `${word(parts[0])}: ${word(parts.slice(1).join(" "))}` : word(name);
  return arg ? `${label} (${arg})` : label;
}

// "cmd-shift-p" -> "⇧⌘P" (macOS order: ⌃ ⌥ ⇧ ⌘); other platforms "Ctrl+Shift+P".
export function keyLabel(keys, mac = true) {
  const parts = String(keys).split("-");
  // "cmd--" is cmd + minus: the empty part after a dash is the "-" key.
  const fixed = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && i === parts.length - 1) fixed.push("-");
    else if (parts[i] !== "") fixed.push(parts[i]);
  }
  const key = fixed.pop() ?? "";
  const mods = new Set(fixed);
  const pretty = { left: "←", right: "→", up: "↑", down: "↓", enter: "↵", escape: "⎋", backspace: "⌫", tab: "⇥", space: "Space" }[key] ?? (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1));
  if (mac) return `${mods.has("ctrl") ? "⌃" : ""}${mods.has("alt") ? "⌥" : ""}${mods.has("shift") ? "⇧" : ""}${mods.has("cmd") ? "⌘" : ""}${pretty}`;
  return [mods.has("ctrl") || mods.has("cmd") ? "Ctrl" : null, mods.has("alt") ? "Alt" : null, mods.has("shift") ? "Shift" : null, pretty].filter(Boolean).join("+");
}

// A key action ("tab.select:3", "vx-activity.search") -> run(name, args), using the command
// list (commands()) to name the argument. null for a command that needs more than it gets.
export function actionToRun(action, list = []) {
  const [name, arg] = String(action).split(/:(.*)/s);
  const cmd = list.find((c) => c.name === name);
  if (!cmd) return name.includes(".") && !arg ? { name, args: undefined } : null;
  const required = cmd.args.filter((a) => a.required);
  if (arg === undefined) return required.length ? null : { name, args: undefined };
  const target = required[0] ?? cmd.args[0];
  if (!target || required.length > 1) return null;
  return { name, args: { [target.name]: /^-?\d+$/.test(arg) ? Number(arg) : arg } };
}
