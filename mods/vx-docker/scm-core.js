// Source Control decisions as plain data: what the Commit button does, what Discard touches, one
// diff hunk as a patch git can apply, the AI commit-message prompt. Pure: tested under node.

// The big button under the message box, VS Code's way: Commit, or Commit All when nothing is
// staged, or, with nothing to commit, Sync Changes / Publish Branch.
// s = { amend, staged, unstaged, conflicts, ahead, behind, upstream, branch, head, message, busy }
export function primaryAction(s) {
  const msg = Boolean(String(s.message ?? "").trim());
  if (s.conflicts) return { kind: "commit", label: "Commit", enabled: false, tip: "Resolve the merge conflicts first" };
  if (s.amend) return { kind: "amend", label: "Amend Commit", enabled: Boolean(s.head && msg && !s.busy), tip: "Rewrite the latest commit with the staged changes and this message" };
  if (s.staged) return { kind: "commit", label: "Commit", enabled: msg && !s.busy, tip: msg ? `Commit ${s.staged} staged file${s.staged === 1 ? "" : "s"}` : "Type a message first" };
  if (s.unstaged) return { kind: "commitAll", label: "Commit All", enabled: msg && !s.busy, tip: msg ? `Stage all ${s.unstaged} change${s.unstaged === 1 ? "" : "s"}, then commit` : "Type a message first" };
  if (s.branch && s.head && !s.upstream) return { kind: "publish", label: "Publish Branch", enabled: !s.busy, tip: `Push ${s.branch} to origin and track it` };
  if (s.upstream && (s.ahead || s.behind)) return { kind: "sync", label: "Sync Changes", enabled: !s.busy, tip: `Pull ${s.behind} and push ${s.ahead} with ${s.upstream}`, ahead: s.ahead, behind: s.behind };
  return { kind: "commit", label: "Commit", enabled: false, tip: "Nothing to commit" };
}

// Discard for rows of Changes: tracked files go back to the index's copy (`git restore
// --worktree`), new files go to the Trash. Conflicted files are left alone.
export function discardPlan(files) {
  const restore = [];
  const trash = [];
  for (const f of files ?? []) {
    if (f.conflict) continue;
    if (f.untracked) trash.push(f.path);
    else if (f.unstaged) restore.push(f.path);
  }
  return { restore, trash };
}

// `git diff` output lines -> the header (diff --git, index, ---, +++) and its hunks.
export function splitHunks(lines) {
  const head = [];
  const hunks = [];
  for (const l of lines ?? []) {
    if (l.startsWith("@@")) hunks.push([l]);
    else if (hunks.length) hunks[hunks.length - 1].push(l);
    else head.push(l);
  }
  return { head, hunks };
}

// One hunk as a patch for `git apply --cached` (add --reverse to unstage a staged hunk).
export function hunkPatch(head, hunk) {
  const keep = head.filter((l) => /^(diff --git |index |--- |\+\+\+ |old mode |new mode )/.test(l));
  return `${[...keep, ...hunk].join("\n")}\n`;
}

// "Maya Chen" -> "MC", "leo" -> "LE".
export function initials(name) {
  const words = String(name ?? "").replace(/[<(].*$/, "").trim().split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

// GitHub's five little blocks for +add -del: ["+", "+", "-", " ", " "].
export function statBlocks(add, del, n = 5) {
  const total = (add ?? 0) + (del ?? 0);
  if (!total) return Array(n).fill(" ");
  const filled = Math.min(n, Math.max(add && del ? 2 : 1, Math.ceil(Math.log2(total + 1) / 2)));
  let plus = Math.round((filled * add) / total);
  if (add && !plus) plus = 1;
  if (del && plus === filled) plus = Math.max(add ? 1 : 0, filled - 1);
  return [...Array(plus).fill("+"), ...Array(filled - plus).fill("-"), ...Array(n - filled).fill(" ")];
}

// The subject line's length against the usual 50 / 72 limits.
export function subjectInfo(message) {
  const subject = String(message ?? "").split("\n")[0];
  const len = subject.trim().length;
  return { len, level: len > 72 ? "over" : len > 50 ? "long" : "ok" };
}

// The prompt for `claude -p` that writes a commit message from a diff.
export function commitPrompt({ diff, stat = "", subjects = [], branch = "", max = 40000 }) {
  const d = String(diff ?? "");
  const cut = d.length > max ? `${d.slice(0, max)}\n… (diff cut at ${max} characters)` : d;
  return [
    "Write the git commit message for the changes below.",
    subjects.length ? `Match the style of this repository's recent commit subjects (prefixes, case, language):\n${subjects.map((s) => `- ${s}`).join("\n")}` : "",
    "Rules: one subject line, imperative mood, under 72 characters. Add a blank line and a short body (wrapped at 72) only when the change needs explaining. Say what changed and why, not how. Output only the message: no code fences, no quotes, no preamble.",
    branch ? `Branch: ${branch}` : "",
    stat ? `Files:\n${stat}` : "",
    `Diff:\n${cut}`,
  ].filter(Boolean).join("\n\n");
}

// The model's answer -> a clean message (fences, quotes and "Commit message:" removed).
export function cleanMessage(out) {
  let s = String(out ?? "").trim();
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  s = s.replace(/^(?:commit message|message)\s*:\s*/i, "").trim();
  if (/^["'`].*["'`]$/s.test(s) && !s.slice(1, -1).includes("\n")) s = s.slice(1, -1).trim();
  return s.replace(/\n{3,}/g, "\n\n");
}

// A web link to a commit for GitHub / GitLab remotes, else null. remote = parseRemote(url) with
// its host already resolved from an SSH alias.
export function commitUrl(remote, sha) {
  if (!remote?.host || !sha) return null;
  const host = remote.host;
  if (/github/i.test(host)) return `https://${host}/${remote.path}/commit/${sha}`;
  if (/gitlab/i.test(host)) return `https://${host}/${remote.path}/-/commit/${sha}`;
  return null;
}

// A branch name git would accept (the common rules of `git check-ref-format --branch`).
export function badBranchName(name) {
  const n = String(name ?? "");
  if (!n.trim()) return "Type a name";
  if (/\s/.test(n)) return "No spaces";
  if (/\.\.|[~^:?*[\\]|@\{|\/\/|\/$|^\/|\.lock$|\.$|^-/.test(n)) return "Not a valid branch name";
  return null;
}
