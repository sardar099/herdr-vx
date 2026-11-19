// CI runs from GitLab (pipelines) and GitHub (Actions runs) as one shape. Pure: tested under node.
//   run = { id, number, title, ref, sha, kind, label, created, started, finished, url, event, actor, workflow }
//   job = { id, name, stage, kind, label, started, finished, seconds, url, artifacts }
// kind: running | queued | success | failure | warning | canceled | skipped | manual

const GL = {
  running: "running", created: "queued", waiting_for_resource: "queued", preparing: "queued",
  pending: "queued", scheduled: "queued", success: "success", failed: "failure",
  canceled: "canceled", canceling: "canceled", skipped: "skipped", manual: "manual",
};

export function glKind(status, allowFailure = false) {
  const k = GL[status] ?? "queued";
  return k === "failure" && allowFailure ? "warning" : k;
}

export function ghKind(status, conclusion) {
  if (status === "in_progress") return "running";
  if (status && status !== "completed") return "queued";
  return {
    success: "success", failure: "failure", timed_out: "failure", startup_failure: "failure",
    cancelled: "canceled", skipped: "skipped", action_required: "manual", neutral: "skipped", stale: "skipped",
  }[conclusion] ?? "skipped";
}

const LABEL = { running: "running", queued: "queued", success: "passed", failure: "failed", warning: "passed with warnings", canceled: "canceled", skipped: "skipped", manual: "manual" };
export const labelOf = (kind) => LABEL[kind] ?? kind;
export const isDone = (kind) => !["running", "queued"].includes(kind);

export function glRun(p) {
  const kind = glKind(p.status);
  return {
    id: p.id, number: p.iid ?? p.id, title: p.name || p.commit?.title || null, ref: p.ref, sha: p.sha,
    kind, label: labelOf(kind), created: p.created_at, started: p.started_at ?? null, finished: p.finished_at ?? null,
    url: p.web_url, event: p.source ?? null, actor: p.user?.username ?? null, workflow: null,
  };
}

export function glJob(j) {
  const kind = glKind(j.status, j.allow_failure);
  return {
    id: j.id, name: j.name, stage: j.stage ?? "jobs", kind, label: labelOf(kind),
    started: j.started_at ?? null, finished: j.finished_at ?? null, seconds: j.duration ?? null, url: j.web_url,
    artifacts: (j.artifacts ?? []).some((a) => a.file_type === "archive"),
  };
}

export function ghRun(r) {
  const kind = ghKind(r.status, r.conclusion);
  return {
    id: r.id, number: r.run_number, title: r.display_title ?? r.name, ref: r.head_branch, sha: r.head_sha,
    kind, label: labelOf(kind), created: r.created_at, started: r.run_started_at ?? null,
    finished: isDone(kind) ? r.updated_at : null, url: r.html_url, event: r.event, actor: r.actor?.login ?? null, workflow: r.name,
  };
}

export function ghJob(j) {
  const kind = ghKind(j.status, j.conclusion);
  const s = j.started_at ? Date.parse(j.started_at) : null;
  const f = j.completed_at ? Date.parse(j.completed_at) : null;
  return {
    id: j.id, name: j.name, stage: j.workflow_name ?? "jobs", kind, label: labelOf(kind),
    started: j.started_at ?? null, finished: j.completed_at ?? null, seconds: s && f ? (f - s) / 1000 : null, url: j.html_url, artifacts: false,
  };
}

// Jobs grouped by stage, in first-seen stage order (GitLab returns newest first, so reverse).
export function byStage(jobs) {
  const order = [];
  const map = new Map();
  for (const j of jobs) {
    if (!map.has(j.stage)) {
      map.set(j.stage, []);
      order.push(j.stage);
    }
    map.get(j.stage).push(j);
  }
  return order.map((stage) => ({ stage, jobs: map.get(stage) }));
}

export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function since(iso, now = Date.now()) {
  if (!iso) return "";
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  for (const [u, n] of [["d", 86400], ["h", 3600], ["m", 60]]) if (s >= n) return `${Math.floor(s / n)}${u} ago`;
  return "just now";
}

const unquote = (v) => {
  const s = String(v ?? "").trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
};

// Top-level `variables:` of a .gitlab-ci.yml: [{ key, value, description, options }].
// Enough YAML for that block: `KEY: value`, or `KEY:` with value/description/options under it.
export function gitlabVariables(yaml) {
  const lines = String(yaml ?? "").replace(/\r/g, "").split("\n");
  const start = lines.findIndex((l) => /^variables:\s*(#.*)?$/.test(l));
  if (start < 0) return [];
  const out = [];
  let cur = null;
  let indent = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const lead = line.length - line.trimStart().length;
    if (lead === 0) break;
    indent ??= lead;
    const m = /^\s*([A-Za-z_][\w.-]*):\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (lead === indent) {
      cur = { key: m[1], value: m[2] && !m[2].startsWith("#") ? unquote(m[2].replace(/\s+#.*$/, "")) : "", description: null, options: null };
      out.push(cur);
    } else if (cur && lead > indent) {
      const v = m[2].replace(/\s+#.*$/, "");
      if (m[1] === "value") cur.value = unquote(v);
      else if (m[1] === "description") cur.description = unquote(v);
      else if (m[1] === "options") cur.options = v.replace(/^\[|\]$/g, "").split(",").map(unquote).filter(Boolean);
    }
  }
  return out;
}
