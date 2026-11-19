// `git blame --porcelain` as one entry per line, and line ages as heat. Pure.

// -> [{ line, sha, author, time, summary, boundary }] in file order (line from 1).
export function parseBlame(stdout) {
  const commits = new Map();
  const out = [];
  let cur = null;
  for (const text of String(stdout ?? "").split("\n")) {
    const head = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/.exec(text);
    if (head) {
      const sha = head[1];
      if (!commits.has(sha)) commits.set(sha, { sha, author: "", time: 0, summary: "", boundary: false });
      cur = { sha, line: Number(head[3]) };
      continue;
    }
    if (!cur) continue;
    const info = commits.get(cur.sha);
    if (text.startsWith("\t")) {
      out.push({ line: cur.line, ...info });
      cur = null;
    } else if (text.startsWith("author ")) info.author = text.slice(7);
    else if (text.startsWith("author-time ")) info.time = Number(text.slice(12));
    else if (text.startsWith("summary ")) info.summary = text.slice(8);
    else if (text === "boundary") info.boundary = true;
  }
  return out.sort((a, b) => a.line - b.line);
}

export const NOT_COMMITTED = /^0+$/;

// 0 (oldest in the file) .. 1 (newest), by rank so one ancient line doesn't flatten the rest.
export function heat(entries) {
  const times = [...new Set(entries.map((e) => e.time))].sort((a, b) => a - b);
  const rank = new Map(times.map((t, i) => [t, times.length > 1 ? i / (times.length - 1) : 1]));
  return entries.map((e) => (NOT_COMMITTED.test(e.sha) ? 1 : rank.get(e.time) ?? 0));
}

// `git log -L` / `--follow` records: hash, short, author, unix time, subject (LOG_FORMAT order).
export function shortAge(unix, now = Date.now()) {
  const s = Math.max(0, now / 1000 - unix);
  for (const [u, n] of [["y", 31536000], ["mo", 2592000], ["w", 604800], ["d", 86400], ["h", 3600], ["m", 60]])
    if (s >= n) return `${Math.floor(s / n)}${u}`;
  return "now";
}
