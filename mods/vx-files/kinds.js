// What a tab is, for drawing it: its kind (terminal, agent, preview, diff, graph, mod), its icon,
// its label, a faint context (repo · branch, or the file's folder) and a repo colour.
import { div, svg, image } from "gpui-kit";
import { panes, shared, theme } from "herdr";
import { workspace, rootFor, baseName } from "./ws.js";
import { viewerValue, keptTabs } from "./tabs.js";
import { colorSlot } from "./colors-core.js";
import { FileIcon, Icon } from "./ui.js";

// A status glyph or "[ ! ]" prefix an agent puts in its title, dropped.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab nobody named follows its agent's live title; a name you gave stays.
function liveLabel(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  const looksLikePath = /^[~/]/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const useful = live && live !== lead.terminal && live !== prog && !looksLikePath && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && useful ? live : base;
}

const VIEWERS = new Set(["vx-files", "vx-changes", "vx-graph"]);
// Other vx mods that open as tabs, by their Material icon.
const MOD_TAB_ICONS = { "vx-docker": "docker", "vx-http": "http", "vx-devtools": "console", "vx-chat": "claude" };

export function describeTab(tab, spaceId) {
  const inTab = panes().filter((p) => p.tab === tab.id);
  const lead = inTab.find((p) => p.program?.agent) ?? inTab.find((p) => p.terminal) ?? inTab[0];
  const kept = keptTabs()[tab.id];
  const modPane = inTab.find((p) => p.mod && VIEWERS.has(p.mod));
  if (modPane && !inTab.some((p) => p.terminal)) {
    const mod = modPane.mod;
    const value = kept?.value ?? (mod === "vx-graph" ? null : viewerValue(mod, spaceId));
    const rel = value?.rel ?? value?.path ?? null;
    const root = value?.root ?? null;
    const preview = !kept && mod !== "vx-graph";
    return {
      kind: mod === "vx-graph" ? "graph" : mod === "vx-changes" ? "diff" : "preview",
      mod, preview, value,
      label: tab.named ? tab.name : rel ? baseName(rel) : tab.name,
      context: rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : root ? baseName(root) : "",
      repo: root ? (rootFor(root, workspace()?.roots)?.name ?? baseName(root)) : null,
      file: rel,
    };
  }
  const cwd = lead?.cwd ?? null;
  const root = cwd ? rootFor(cwd, workspace()?.roots) : null;
  const repo = root?.name ?? (cwd && lead?.branch ? baseName(cwd) : null);
  return {
    kind: lead?.program?.agent ? "agent" : lead?.terminal ? "terminal" : "mod",
    lead,
    label: liveLabel(tab, lead),
    context: [repo, lead?.branch].filter(Boolean).join(" · "),
    repo,
  };
}

export function tabIcon(d, icons, size = 14) {
  const t = theme();
  if (d.kind === "preview" || d.kind === "diff") return d.file ? FileIcon(icons, d.file, { size }) : Icon("file", size).text_color(t.muted);
  if (d.kind === "graph") return Icon("git-commit", size).text_color(t.accent);
  const modIcon = MOD_TAB_ICONS[d.lead?.mod];
  if (d.kind === "mod" && modIcon) return image(`mods/vx-icons/icons/${modIcon}.svg`).size(size).flex_none();
  const program = d.lead?.program;
  if (program?.icon) return program.tint ? svg(program.icon).size(size).flex_none().text_color(t.muted) : image(program.icon).size(size).flex_none();
  return Icon("terminal", size).text_color(t.muted);
}

export const repoColor = (repo, t = theme()) => (repo ? t[colorSlot(repo)] ?? t.accent : null);
