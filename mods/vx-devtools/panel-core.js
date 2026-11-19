// The bottom panel's data, as pure functions (tested under node): listening ports from lsof,
// workspace problems from what vx-workspace / vx-ci publish, and problems parsed from the
// output of a repo's lint / typecheck scripts.

// lsof -F pcn: p<pid> / c<command> / f<fd> / n<host:port> lines -> one entry per port.
export function parsePorts(text) {
  const out = new Map();
  let pid = null;
  let cmd = null;
  for (const line of String(text ?? "").split("\n")) {
    const k = line[0];
    const v = line.slice(1);
    if (k === "p") pid = Number(v);
    else if (k === "c") cmd = v;
    else if (k === "n") {
      const m = /^(.*):(\d+)$/.exec(v);
      if (!m) continue;
      const port = Number(m[2]);
      const prev = out.get(port);
      if (prev) {
        if (!prev.hosts.includes(m[1])) prev.hosts.push(m[1]);
      } else out.set(port, { port, pid, cmd, hosts: [m[1]] });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

// roots [{name, path}], git = shared("vx.git"), ci = shared("vx.ci.summary") -> problems.
export function workspaceProblems(roots, git = {}, ci = {}) {
  const out = [];
  for (const r of roots ?? []) {
    const s = git?.[r.path];
    if (s?.error) out.push({ id: `err-${r.path}`, root: r, level: "error", text: s.error, view: "explorer" });
    if (s?.conflicts) out.push({ id: `cf-${r.path}`, root: r, level: "error", text: `${s.conflicts} file${s.conflicts === 1 ? "" : "s"} with merge conflicts`, view: "scm" });
    const last = ci?.[r.path];
    if (last?.kind === "failure") out.push({ id: `ci-${r.path}`, root: r, level: "error", text: `Pipeline${last.number ? ` #${last.number}` : ""} failed on ${s?.branch ?? "its branch"}`, view: "ci" });
    if (s?.behind) out.push({ id: `bh-${r.path}`, root: r, level: "warning", text: `${s.behind} commit${s.behind === 1 ? "" : "s"} behind on ${s.branch ?? "its branch"}`, view: "scm" });
  }
  return out;
}

// The scripts worth running for problems, in order: type checks first, then linters.
export const CHECK_SCRIPTS = ["typecheck", "type-check", "check-types", "types", "tsc", "lint:check", "lint"];
export function pickChecks(scripts) {
  const names = new Set((scripts ?? []).map((s) => s.name));
  const types = CHECK_SCRIPTS.slice(0, 5).find((n) => names.has(n));
  const lint = CHECK_SCRIPTS.slice(5).find((n) => names.has(n));
  return [types, lint].filter(Boolean);
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const relTo = (root, file) => {
  const f = file.replace(/^\.\//, "");
  if (root && f.startsWith(`${root}/`)) return f.slice(root.length + 1);
  return f;
};

// Problems in a check's output, for the files under `dir` (the script's folder) of a repo at
// `root`. Understands tsc (both formats), ESLint's stylish output, and file:line:col: lines.
// -> [{ rel, line, col, level: "error" | "warning", message, rule }]
export function parseCheckOutput(text, { root, dir = root } = {}) {
  const out = [];
  const seen = new Set();
  const add = (file, line, col, level, message, rule = "") => {
    let abs = file.startsWith("/") ? file : `${dir}/${file.replace(/^\.\//, "")}`;
    abs = abs.replace(/\/\.\//g, "/");
    const rel = relTo(root, abs);
    const key = `${rel}:${line}:${col}:${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ rel, line: Number(line), col: Number(col) || 1, level, message: message.trim(), rule });
  };
  let eslintFile = null;
  for (const raw of String(text ?? "").split("\n")) {
    const line = stripAnsi(raw).replace(/\r$/, "");
    let m;
    if ((m = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line))) {
      add(m[1], m[2], m[3], m[4], m[6], m[5]);
      eslintFile = null;
    } else if ((m = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.*)$/.exec(line))) {
      add(m[1], m[2], m[3], m[4], m[6], m[5]);
      eslintFile = null;
    } else if ((m = /^(\/\S.*|[\w.@-][\w./@-]*\.\w+)$/.exec(line.trim())) && !/\s/.test(line.trim())) {
      eslintFile = m[1];
    } else if (eslintFile && (m = /^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s{2,}(\S+))?\s*$/.exec(line))) {
      add(eslintFile, m[1], m[2], m[3], m[4], m[5] ?? "");
    } else if ((m = /^([^\s:][^:]*):(\d+):(\d+):?\s+(?:(error|warning)\b:?\s*)?(.*)$/.exec(line)) && /\.\w+$/.test(m[1])) {
      add(m[1], m[2], m[3], m[4] ?? "error", m[5]);
      eslintFile = null;
    } else if (!line.trim()) {
      eslintFile = null;
    }
  }
  return out;
}

// Errors and warnings across workspace problems and check results (vx.checks), for the
// status bar and the Problems tab.
export function countProblems(list, checks = {}) {
  let errors = 0;
  let warnings = 0;
  for (const p of list ?? []) p.level === "error" ? errors++ : warnings++;
  for (const c of Object.values(checks ?? {})) for (const i of c?.items ?? []) i.level === "error" ? errors++ : warnings++;
  return { errors, warnings };
}
