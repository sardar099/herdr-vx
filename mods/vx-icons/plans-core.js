// Claude Code plan files (~/.claude/plans/*.md): list, title and order them. Pure: no herdr
// imports, so node tests can load it.

// The `stat` script lists every plan as "<mtime seconds>/<bytes>/<name>", one per line.
// $1 is the plans folder. BSD stat (macOS) first, GNU stat as the fallback.
export const LIST_PLANS = 'cd "$1" 2>/dev/null || exit 0; set -- *.md; [ -e "$1" ] || exit 0; stat -f "%m/%z/%N" -- "$@" 2>/dev/null || stat -c "%Y/%s/%n" -- "$@"';

export function parsePlanList(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const m = /^(\d+)\/(\d+)\/(.+\.md)$/.exec(line.trim());
    if (m) out.push({ name: m[3], at: Number(m[1]) * 1000, size: Number(m[2]) });
  }
  return out.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
}

// The first Markdown heading (any level), without #s and trailing #s; else the file name made
// readable ("foamy-wibbling-treasure.md" -> "foamy wibbling treasure").
export function planTitle(text, name) {
  for (const line of String(text ?? "").split("\n").slice(0, 60)) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[1].trim()) return m[1].replace(/[*_`]/g, "").trim();
  }
  return String(name ?? "").replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim() || "Untitled plan";
}

// Modified in the last two minutes: Claude is probably still writing it.
export const LIVE_MS = 120000;
export const isLive = (plan, now = Date.now()) => now - plan.at < LIVE_MS;

// Which plans changed between two listings (new, or a newer mtime).
export function changedPlans(before, after) {
  const was = new Map((before ?? []).map((p) => [p.name, p.at]));
  return (after ?? []).filter((p) => !was.has(p.name) || was.get(p.name) < p.at);
}

export function matchPlan(plan, query) {
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return true;
  return `${plan.title ?? ""} ${plan.name}`.toLowerCase().includes(q);
}
