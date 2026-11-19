// Gallery cards: folder -> the mods it carries (copied from mods/ by tools/build.mjs).
export const CARDS = {
  "vx-workspace": ["vx-workspace", "vx-files"],
  "vx-changes": ["vx-changes", "vx-graph"],
  "vx-ci": ["vx-ci"],
  "vx-tabs": ["vx-tabs", "vx-scripts"],
  "vx-status": ["vx-status"],
  "vx-icons": ["vx-icons"],
};

// Layout cards: folder -> its layout, the themes it ships and the keys it expects. Its mods are
// every vx mod the layout names, plus vx-icons (they all draw their icons from it).
export const LAYOUT_CARDS = {
  "vx-code": {
    layout: "vx-code",
    // Opened as tabs at runtime, so the layout doesn't name them.
    extra: ["vx-graph", "vx-devtools"],
    themes: ["one-monokai"],
    keys: {
      "layout:vx-code": {
        "cmd-p": "vx-titlebar.goto",
        "cmd-shift-o": "vx-titlebar.symbols",
        "cmd-shift-f": "vx-activity.search",
        "cmd-shift-e": "vx-activity.explorer",
        "cmd-shift-g": "vx-activity.scm",
        "cmd-j": "vx-activity.panel",
        "ctrl-`": "vx-activity.panel",
        "cmd-e": "vx-tabs.switch",
        "cmd-\\": "pane.split:right",
        "cmd-s": "vx-files.save",
        "cmd-alt-d": "vx-activity.docker",
        "cmd-alt-r": "vx-activity.http",
        "cmd-alt-t": "mod.open:vx-devtools",
        "cmd-alt-i": "vx-titlebar.chat",
      },
    },
  },
};

// The vx mods a layout tree names (content.mod), plus vx-icons and any extra ones.
export function layoutMods(tree, extra = []) {
  const out = new Set(["vx-icons", ...extra]);
  const walk = (n) => {
    const m = n?.content?.mod;
    if (m && m.startsWith("vx-")) out.add(m);
    for (const c of n?.children ?? []) walk(c);
  };
  walk(tree);
  return [...out].sort();
}
