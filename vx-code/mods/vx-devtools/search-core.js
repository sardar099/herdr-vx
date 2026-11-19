// The Search view (vx-search), as pure functions: git grep arguments for a query, and its
// output parsed into files and matches.

// opts { caseSensitive, word, regex, include, perl } -> git grep arguments. Regular expressions
// use -P (Perl-compatible, like JavaScript's: \w, \d, lookahead) unless perl is false (a git
// built without PCRE), then -E.
export function grepArgs(query, { caseSensitive = false, word = false, regex = false, include = "", perl = true } = {}) {
  const args = ["grep", "-n", "-I", "--column", "--no-color", "--untracked", "--full-name"];
  if (!caseSensitive) args.push("-i");
  if (word) args.push("-w");
  args.push(regex ? (perl ? "-P" : "-E") : "-F", "-e", query, "--");
  const globs = String(include ?? "").split(",").map((g) => g.trim()).filter(Boolean);
  for (const g of globs) args.push(g.includes("/") || g.startsWith("*") ? `:(glob)${g.startsWith("*") ? `**/${g}` : g}` : `:(glob)**/${g}`);
  return args;
}

// "path:line:col:text" lines -> [{ rel, matches: [{ line, col, text }] }] in output order.
export function parseGrep(stdout, { maxMatches = 2000 } = {}) {
  const files = new Map();
  let total = 0;
  for (const row of String(stdout ?? "").split("\n")) {
    const m = /^(.*?):(\d+):(\d+):(.*)$/.exec(row);
    if (!m) continue;
    if (total >= maxMatches) return { files: [...files.values()], total, truncated: true };
    const file = files.get(m[1]) ?? { rel: m[1], matches: [] };
    file.matches.push({ line: Number(m[2]), col: Number(m[3]), text: m[4] });
    files.set(m[1], file);
    total++;
  }
  return { files: [...files.values()], total, truncated: false };
}

// The text before, in, and after the match, trimmed around it so long lines stay readable.
export function matchSnippet(text, col, length, { before = 30, width = 160 } = {}) {
  const start = Math.max(0, col - 1);
  const from = Math.max(0, start - before);
  const lead = from > 0 ? "…" : "";
  const head = lead + text.slice(from, start).replace(/^\s+/, from > 0 ? "" : "");
  const hit = text.slice(start, start + length);
  const tail = text.slice(start + length, start + length + width);
  return { head, hit, tail };
}
