// One reusable centre tab per space for a mod's viewer (a file preview, a diff).
// What it shows lives in shared(`${mod}.view`)[spaceId]; the tab is a pane of the same mod opened
// with props { mode: "view", space }. Opening again only updates the shared value, renames the
// tab and selects it, so browsing never piles up tabs.
import { panes, spaces, run, shared, setShared } from "herdr";

const PENDING_MS = 2000;

// Tabs you kept (double-click a preview in vx-tabs): they hold their own file and are never
// reused for the next preview. shared("vx.tabs.kept") = { [tabId]: { mod, value } }.
export const keptTabs = () => shared("vx.tabs.kept") ?? {};

export function viewerTab(mod, spaceId) {
  const space = spaces().find((s) => s.id === spaceId);
  const ids = new Set((space?.tabs ?? []).map((t) => t.id));
  const kept = keptTabs();
  return panes().find((p) => p.mod === mod && ids.has(p.tab) && !kept[p.tab])?.tab ?? null;
}

// Is this tab the reused (italic) preview of a viewer mod?
export const isPreviewTab = (tabId, mod) => ["vx-files", "vx-changes"].includes(mod) && !keptTabs()[tabId];

export function showInViewer(mod, value, name) {
  const space = spaces().find((s) => s.active);
  if (!space) return;
  // Quick Open's "recently opened": every file previewed, from anywhere.
  if (mod === "vx-files" && value?.root && value.rel && !value.on) {
    const rest = (shared("vx.goto.recent") ?? []).filter((r) => !(r?.root?.path === value.root && r.rel === value.rel));
    setShared("vx.goto.recent", [{ root: { name: value.root.split("/").pop(), path: value.root }, rel: value.rel }, ...rest].slice(0, 50));
  }
  const key = `${mod}.view`;
  const all = shared(key) ?? {};
  const prev = all[space.id];
  setShared(key, { ...all, [space.id]: { ...value, at: Date.now(), opening: prev?.opening ?? 0 } });
  const tab = viewerTab(mod, space.id);
  if (tab) {
    run("tab.rename", { id: tab, name });
    run("tab.select", { id: tab });
    return;
  }
  // A tab asked for a moment ago may not be listed yet: don't open a second one.
  if (prev?.opening && Date.now() - prev.opening < PENDING_MS) return;
  const now = shared(key) ?? {};
  setShared(key, { ...now, [space.id]: { ...now[space.id], opening: Date.now() } });
  run("tab.new", { space: space.id, name, mod, props: { mode: "view", space: space.id } });
}

export const viewerValue = (mod, spaceId) => (shared(`${mod}.view`) ?? {})[spaceId] ?? null;
