// Git output as plain data. Pure: no Herdr calls, tested under node.

// Every read: no optional index locks, no fsmonitor daemon, no index refresh, so a read never
// writes under .git (which would wake our own folder watch and loop).
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const NO_HELPERS = ["--no-ext-diff", "--no-textconv", "--no-color"];

const CONFLICT = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const CONFLICT_KIND = {
  UU: "both edited", AA: "both added", DD: "both deleted",
  DU: "deleted by you", UD: "deleted incoming", AU: "added by you", UA: "added incoming",
};

// `git status --porcelain=v1 -z -b --no-renames --untracked-files=all`.
export function parseStatus(stdout) {
  const out = {
    branch: null, detached: false, upstream: null, ahead: 0, behind: 0, noCommits: false,
    files: [], staged: 0, unstaged: 0, untracked: 0, conflicts: 0,
  };
  for (const rec of String(stdout ?? "").split("\0")) {
    if (!rec) continue;
    if (rec.startsWith("## ")) {
      const head = rec.slice(3);
      if (head.startsWith("HEAD (no branch)")) out.detached = true;
      const fresh = /^(?:No commits yet on|Initial commit on) (\S+)/.exec(head);
      if (fresh) {
        out.noCommits = true;
        out.branch = fresh[1];
      } else if (!out.detached) {
        out.branch = /^(.+?)(?:\.\.\.|\s|$)/.exec(head)?.[1] ?? head;
      }
      out.upstream = /\.\.\.(\S+)/.exec(head)?.[1] ?? null;
      out.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      out.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
      continue;
    }
    if (rec.length < 4) continue;
    const x = rec[0];
    const y = rec[1];
    const xy = x + y;
    const path = rec.slice(3);
    const untracked = xy === "??";
    const conflict = CONFLICT.has(xy);
    const file = {
      path, x, y, untracked, conflict,
      conflictKind: conflict ? CONFLICT_KIND[xy] : null,
      staged: !untracked && !conflict && x !== " " && x !== "!",
      unstaged: untracked || conflict || y !== " ",
      // One letter for a row: A new, D gone, U conflict, M otherwise.
      mark: conflict ? "U" : untracked || x === "A" ? "A" : x === "D" || y === "D" ? "D" : "M",
    };
    out.files.push(file);
    if (untracked) out.untracked++;
    if (conflict) out.conflicts++;
    if (file.staged) out.staged++;
    if (file.unstaged && !untracked && !conflict) out.unstaged++;
  }
  out.changed = out.files.length;
  return out;
}

// `git diff --numstat -z`: { path: {add, del, binary} }.
export function parseNumstat(stdout) {
  const stats = Object.create(null);
  for (const entry of String(stdout ?? "").split("\0")) {
    const [add, del, ...rest] = entry.split("\t");
    if (!rest.length) continue;
    stats[rest.join("\t")] = { add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" };
  }
  return stats;
}

// A remote URL as { host, path } (path without .git), for https, ssh:// and scp-like forms.
export function parseRemote(url) {
  const u = String(url ?? "").trim();
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(u);
  if (m) return { host: m[1], path: m[2] };
  m = /^(?:[^@]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(u);
  if (m) return { host: m[1], path: m[2].replace(/^\/+/, "") };
  return null;
}

export const providerOf = (host) =>
  /(^|\.)github\.com$/i.test(host ?? "") ? "github" : /gitlab/i.test(host ?? "") ? "gitlab" : null;

// `@@ -a,b +c,d @@` hunks of `git diff -U0` (or any -U), by line in the new file.
export function parseHunks(diff) {
  const hunks = [];
  let cur = null;
  for (const text of String(diff ?? "").split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (h) {
      const gone = h[2] === undefined ? 1 : Number(h[2]);
      const fresh = h[4] === undefined ? 1 : Number(h[4]);
      cur = {
        oldStart: Number(h[1]), newStart: Number(h[3]), gone, fresh,
        kind: !fresh ? "removed" : gone ? "changed" : "added",
        old: [],
      };
      hunks.push(cur);
    } else if (cur && text.startsWith("-")) cur.old.push(text.slice(1));
  }
  return hunks;
}

// Unified diff lines -> rows with old/new line numbers ("@" hunk headers, "+", "-", " ").
export function diffRows(lines) {
  let oldN = 0;
  let newN = 0;
  const rows = [];
  for (const text of lines) {
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(text);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[2]);
      rows.push({ kind: "@", text });
      continue;
    }
    const k = text[0];
    if (k === "+") rows.push({ kind: "+", next: newN++, text: text.slice(1) });
    else if (k === "-") rows.push({ kind: "-", old: oldN++, text: text.slice(1) });
    else if (k === " ") rows.push({ kind: " ", old: oldN++, next: newN++, text: text.slice(1) });
    else if (text && !text.startsWith("\\")) rows.push({ kind: "", text });
  }
  return rows;
}

// Side by side: removals and additions of one change paired by position.
export function splitRows(rows) {
  const out = [];
  let minus = [];
  let plus = [];
  const flush = () => {
    for (let i = 0; i < Math.max(minus.length, plus.length); i++)
      out.push({ kind: "pair", left: minus[i] ?? null, right: plus[i] ?? null });
    minus = [];
    plus = [];
  };
  for (const r of rows) {
    if (r.kind === "-") minus.push(r);
    else if (r.kind === "+") plus.push(r);
    else {
      flush();
      out.push(r.kind === " " ? { kind: "pair", left: r, right: r } : r);
    }
  }
  flush();
  return out;
}

// `git log` with records split by \x1e and fields by \0: hash, short, author, unix time, subject.
export const LOG_FORMAT = "--format=%H%x00%h%x00%an%x00%at%x00%s%x1e";
export function parseLog(stdout) {
  return String(stdout ?? "")
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.includes("\0"))
    .map((r) => {
      const [hash, short, author, at, subject] = r.split("\0");
      return { hash, short, author, at: Number(at), subject };
    });
}

export function timeAgo(ms, now = Date.now()) {
  const s = Math.max(0, (now - ms) / 1000);
  for (const [unit, size] of [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]])
    if (s >= size) return `${Math.floor(s / size)}${unit}`;
  return "now";
}
