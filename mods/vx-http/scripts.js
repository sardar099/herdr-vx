// package.json scripts for a repo: find the project (and workspace packages), the package
// manager (packageManager, else the lockfile, else npm; switchable per project among the ones
// installed), and run a script in a new tab or beside the focused pane. Used by vx-scripts
// (the full list) and vx-tabs (the inline ▾ script ▶ control).
import { readTextFile, exec, run, shared, setShared, home, spaces } from "herdr";
import { baseName } from "./ws.js";

const MOD = "vx-scripts";
const UP = 6;
export const PMS = ["npm", "pnpm", "bun", "yarn"];
export const PM_ICON = (pm) => `mods/vx-icons/icons/${pm === "npm" ? "npm" : pm}.svg`;
const LOCKS = 'for f in bun.lock bun.lockb pnpm-lock.yaml yarn.lock package-lock.json; do [ -e "$1/$f" ] && { printf "%s" "$f"; exit 0; }; done; exit 0';
const BY_LOCK = { "bun.lock": "bun", "bun.lockb": "bun", "pnpm-lock.yaml": "pnpm", "yarn.lock": "yarn", "package-lock.json": "npm" };
const INSTALLED = 'for p in npm pnpm bun yarn; do command -v "$p" >/dev/null 2>&1 && printf "%s\\n" "$p"; done; exit 0';
// Workspace package folders: each pattern's matches that hold a package.json ($1 root, then patterns).
const EXPAND = 'cd -- "$1" && shift && for pat in "$@"; do for d in $pat; do [ -f "$d/package.json" ] && printf "%s\\n" "$d"; done; done; exit 0';

export const store = () => shared("vx.scripts") ?? { chosen: {}, recent: {}, pm: {} };
export const save = (patch) => setShared("vx.scripts", { ...store(), ...patch });

async function readPkg(dir, on) {
  const text = await readTextFile(`${dir}/package.json`, { on }).catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const scriptsOf = (pkg) => Object.entries(pkg?.scripts ?? {}).map(([name, cmd]) => ({ name, cmd: String(cmd) }));

export async function findProject(start, on) {
  let dir = start;
  for (let i = 0; dir && i <= UP; i++) {
    const pkg = await readPkg(dir, on);
    if (pkg && (scriptsOf(pkg).length || pkg.workspaces)) {
      const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager ?? "")?.[1] ?? null;
      const lock = await exec("sh", ["-c", LOCKS, MOD, dir], { on }).catch(() => null);
      const detected = declared ?? BY_LOCK[lock?.stdout?.trim()] ?? "npm";
      const inst = await exec("sh", ["-lc", INSTALLED], { on }).catch(() => null);
      const installed = (inst?.stdout ?? "").split("\n").filter((p) => PMS.includes(p));
      // Workspace packages (npm / yarn / bun "workspaces", pnpm-workspace.yaml "packages").
      let patterns = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
      if (!patterns.length) {
        const yaml = await readTextFile(`${dir}/pnpm-workspace.yaml`, { on }).catch(() => null);
        patterns = [...(yaml ?? "").matchAll(/^\s*-\s*['"]?([^'"\n#]+?)['"]?\s*$/gm)].map((m) => m[1]);
      }
      const groups = [{ name: pkg.name ?? baseName(dir), dir, scripts: scriptsOf(pkg) }];
      if (patterns.length) {
        const r = await exec("sh", ["-c", EXPAND, MOD, dir, ...patterns.map((p) => p.replace(/\/\*\*$/, "/*"))], { on }).catch(() => null);
        for (const rel of [...new Set((r?.stdout ?? "").split("\n").filter(Boolean))].slice(0, 60)) {
          const sub = await readPkg(`${dir}/${rel}`, on);
          if (scriptsOf(sub).length) groups.push({ name: sub.name ?? rel, dir: `${dir}/${rel}`, rel, scripts: scriptsOf(sub) });
        }
      }
      if (!groups.some((g) => g.scripts.length)) return null;
      return { root: dir, on, name: groups[0].name, detected, declared: Boolean(declared), installed: installed.length ? installed : [detected], groups };
    }
    if (dir === home() || dir === "/") break;
    dir = dir.replace(/\/[^/]+\/?$/, "") || "/";
  }
  return null;
}

export const pmOf = (p) => {
  const pick = store().pm?.[p.root];
  return pick && p.installed.includes(pick) ? pick : p.detected;
};
export const keyOf = (g, s) => `${g.rel ?? ""}::${s.name}`;
export const allScripts = (p) => p.groups.flatMap((g) => g.scripts.map((s) => ({ g, s, key: keyOf(g, s) })));

export function chosenOf(p) {
  const all = allScripts(p);
  const pick = store().chosen?.[p.root];
  return all.find((x) => x.key === pick) ?? ["dev", "start", "serve"].map((n) => all.find((x) => !x.g.rel && x.s.name === n)).find(Boolean) ?? all[0];
}

export function runScript(p, x, beside = false) {
  const st = store();
  const recent = [x.key, ...(st.recent?.[p.root] ?? []).filter((k) => k !== x.key)].slice(0, 3);
  save({ chosen: { ...st.chosen, [p.root]: x.key }, recent: { ...st.recent, [p.root]: recent } });
  const argv = [pmOf(p), "run", x.s.name];
  const name = x.g.rel ? `${baseName(x.g.rel)}:${x.s.name}` : x.s.name;
  if (beside) run("pane.split", { direction: "right", argv, folder: x.g.dir });
  else run("tab.new", { name, folder: x.g.dir, argv, space: spaces().find((s) => s.active)?.id });
}

