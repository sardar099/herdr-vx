// Docker, as the docker CLI prints it with --format '{{json .}}' (one JSON object per line).
// Pure: no herdr imports, so node tests can load it.

export const FORMAT = "{{json .}}";

export function jsonLines(stdout) {
  const out = [];
  for (const line of String(stdout ?? "").split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      out.push(JSON.parse(s));
    } catch {}
  }
  return out;
}

// "a=1,b=x=y,c=" -> { a: "1", b: "x=y", c: "" }. Values may hold "=", never ",".
export function parseLabels(s) {
  const out = {};
  if (s && typeof s === "object") return { ...s };
  for (const part of String(s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1);
  }
  return out;
}

// "0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp" -> published ports once each (IPv4 and IPv6
// bindings of the same port merge), then the exposed-only ones.
export function parsePorts(s) {
  const seen = new Map();
  const exposed = [];
  for (const raw of String(s ?? "").split(",")) {
    const p = raw.trim();
    if (!p) continue;
    const m = /^(?:(.*):)?(\d+)(?:-(\d+))?->(\d+)(?:-(\d+))?\/(\w+)$/.exec(p);
    if (m) {
      const host = !m[1] || m[1] === "::" || m[1] === "[::]" ? "0.0.0.0" : m[1];
      const key = `${m[2]}->${m[4]}/${m[6]}`;
      if (!seen.has(key)) seen.set(key, { host, hostPort: Number(m[2]), containerPort: Number(m[4]), proto: m[6] });
      continue;
    }
    const e = /^(\d+)(?:-(\d+))?\/(\w+)$/.exec(p);
    if (e) exposed.push({ host: null, hostPort: null, containerPort: Number(e[1]), proto: e[3] });
  }
  const dedupe = new Map(exposed.map((x) => [`${x.containerPort}/${x.proto}`, x]));
  for (const x of seen.values()) dedupe.delete(`${x.containerPort}/${x.proto}`);
  return [...seen.values(), ...dedupe.values()];
}

export const portLabel = (p) => (p.hostPort ? `${p.hostPort}→${p.containerPort}` : `${p.containerPort}/${p.proto}`);

// One container from `docker ps -a`.
export function toContainer(raw) {
  const labels = parseLabels(raw.Labels);
  const names = String(raw.Names ?? "").split(",")[0];
  return {
    id: String(raw.ID ?? ""),
    name: names || String(raw.ID ?? "").slice(0, 12),
    image: String(raw.Image ?? ""),
    state: String(raw.State ?? "").toLowerCase() || stateFromStatus(raw.Status),
    status: String(raw.Status ?? ""),
    ports: parsePorts(raw.Ports),
    command: String(raw.Command ?? "").replace(/^"|"$/g, ""),
    created: String(raw.RunningFor ?? raw.CreatedAt ?? ""),
    networks: String(raw.Networks ?? "").split(",").filter(Boolean),
    project: labels["com.docker.compose.project"] ?? null,
    service: labels["com.docker.compose.service"] ?? null,
    workdir: labels["com.docker.compose.project.working_dir"] ?? null,
    configFiles: (labels["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean),
    labels,
  };
}

// Older engines have no State column: derive it from "Up 2 hours", "Exited (0) …", "Up … (Paused)".
export function stateFromStatus(status) {
  const s = String(status ?? "");
  if (/\(Paused\)/i.test(s)) return "paused";
  if (/^Up/i.test(s)) return "running";
  if (/^Restarting/i.test(s)) return "restarting";
  if (/^Exited/i.test(s)) return "exited";
  if (/^Created/i.test(s)) return "created";
  if (/^Dead/i.test(s)) return "dead";
  if (/^Removal/i.test(s)) return "removing";
  return "unknown";
}

export const isRunning = (c) => c.state === "running" || c.state === "restarting";

// Running first, then by name.
export const byStateThenName = (a, b) => Number(isRunning(b)) - Number(isRunning(a)) || a.name.localeCompare(b.name);

// Compose projects (by label) with their containers, then the containers of no project.
export function groupContainers(list) {
  const groups = new Map();
  const loose = [];
  for (const c of list) {
    if (!c.project) {
      loose.push(c);
      continue;
    }
    if (!groups.has(c.project)) groups.set(c.project, { project: c.project, workdir: c.workdir, configFiles: c.configFiles, containers: [] });
    const g = groups.get(c.project);
    g.workdir ??= c.workdir;
    if (!g.configFiles.length) g.configFiles = c.configFiles;
    g.containers.push(c);
  }
  const projects = [...groups.values()].map((g) => ({
    ...g,
    containers: g.containers.sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name)),
    running: g.containers.filter(isRunning).length,
    total: g.containers.length,
  }));
  projects.sort((a, b) => Number(b.running > 0) - Number(a.running > 0) || a.project.localeCompare(b.project));
  return { projects, loose: loose.sort(byStateThenName) };
}

// `docker compose` arguments for a project: by name for most verbs; `up` needs its files.
export function composeArgs(g, verb, extra = []) {
  const args = ["compose", "-p", g.project];
  if (verb === "up" || verb === "pull" || verb === "build") {
    if (g.workdir) args.push("--project-directory", g.workdir);
    for (const f of g.configFiles ?? []) args.push("-f", f);
  }
  return [...args, verb, ...extra];
}

export function toImage(raw) {
  const repo = String(raw.Repository ?? "");
  const tag = String(raw.Tag ?? "");
  const dangling = repo === "<none>";
  return {
    id: String(raw.ID ?? ""),
    repo, tag, dangling,
    ref: dangling ? String(raw.ID ?? "") : tag && tag !== "<none>" ? `${repo}:${tag}` : repo,
    size: String(raw.Size ?? ""),
    created: String(raw.CreatedSince ?? raw.CreatedAt ?? ""),
  };
}

// Images by repository, newest tag first as docker lists them; dangling ones last.
export function sortImages(list) {
  return [...list].sort((a, b) => Number(a.dangling) - Number(b.dangling) || a.repo.localeCompare(b.repo) || 0);
}

export const toVolume = (raw) => ({ name: String(raw.Name ?? ""), driver: String(raw.Driver ?? ""), labels: parseLabels(raw.Labels), mountpoint: String(raw.Mountpoint ?? "") });
export const toNetwork = (raw) => ({ id: String(raw.ID ?? ""), name: String(raw.Name ?? ""), driver: String(raw.Driver ?? ""), scope: String(raw.Scope ?? "") });
export const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);
export const toContext = (raw) => ({ name: String(raw.Name ?? ""), current: raw.Current === true || raw.Current === "true", endpoint: String(raw.DockerEndpoint ?? ""), description: String(raw.Description ?? "") });

// `docker stats --no-stream` -> { [id or name]: { cpu, mem, memPerc } }.
export function parseStats(stdout) {
  const out = {};
  for (const s of jsonLines(stdout)) {
    const row = { cpu: String(s.CPUPerc ?? ""), mem: String(s.MemUsage ?? "").split("/")[0].trim(), memPerc: String(s.MemPerc ?? "") };
    if (s.ID) out[s.ID] = row;
    if (s.Container) out[s.Container] = row;
    if (s.Name) out[s.Name] = row;
  }
  return out;
}

// The CLI couldn't reach a daemon (stopped Docker Desktop / OrbStack / colima).
export function daemonDown(stderr) {
  return /cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|error during connect|docker\.sock.*(no such file|connection refused)/i.test(String(stderr ?? ""));
}

// Does a row match the filter box? Name, image, service, project, ports.
export function matchesFilter(c, q) {
  const s = String(q ?? "").trim().toLowerCase();
  if (!s) return true;
  return [c.name, c.image, c.service, c.project, c.ref, c.repo, c.tag, c.driver, ...(c.ports ?? []).map(portLabel)]
    .filter(Boolean).some((v) => String(v).toLowerCase().includes(s));
}

// "8080:80, 5432:5432" + "A=1, B=two" -> docker run arguments (no shell).
export function runArgs({ image, name, ports, env, detached, command }) {
  const args = ["run"];
  if (detached) args.push("-d");
  else args.push("--rm", "-it");
  if (name && name.trim()) args.push("--name", name.trim());
  for (const p of String(ports ?? "").split(/[,\s]+/).filter(Boolean)) args.push("-p", p);
  for (const e of String(env ?? "").split(/,\s*(?=[A-Za-z_][A-Za-z0-9_]*=)/).map((x) => x.trim()).filter(Boolean)) args.push("-e", e);
  args.push(image);
  if (command && command.trim()) args.push(...splitWords(command));
  return args;
}

// Splits a command line into words, honouring '…' and "…" quotes (no expansion).
export function splitWords(s) {
  const out = [];
  let word = null, quote = "";
  for (const ch of String(s ?? "")) {
    if (quote) {
      if (ch === quote) quote = "";
      else word = (word ?? "") + ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= "";
    } else if (/\s/.test(ch)) {
      if (word !== null) out.push(word);
      word = null;
    } else word = (word ?? "") + ch;
  }
  if (word !== null) out.push(word);
  return out;
}
