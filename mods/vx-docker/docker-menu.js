// vx-docker's right-click menus. A menu is a popup copy of the mod (props { menu }); each item
// posts a command to the panel copy (shared vx.docker.cmd), so the work outlives the popup.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, openOverlay, closeOverlay, props, setShared } from "herdr";
import { TEXT, Icon } from "./ui.js";

const MOD = "vx-docker";
const ITEM = 26;
const SEP = 9;
const post = (cmd) => setShared("vx.docker.cmd", { ...cmd, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });

export function menuItems(m) {
  const sep = { sep: true };
  switch (m.kind) {
    case "container": {
      const up = m.running || m.state === "paused";
      return [
        { icon: "list", label: "View Logs", cmd: { cmd: "logs", container: m.id } },
        m.running ? { icon: "terminal", label: "Attach Shell", cmd: { cmd: "shell", container: m.id } } : null,
        sep,
        !up ? { icon: "play", label: "Start", cmd: { cmd: "start", container: m.id } } : null,
        up ? { icon: "stop", label: "Stop", cmd: { cmd: "stop", container: m.id } } : null,
        up ? { icon: "retry", label: "Restart", cmd: { cmd: "restart", container: m.id } } : null,
        m.state === "running" ? { icon: "pause", label: "Pause", cmd: { cmd: "pause", container: m.id } } : null,
        m.state === "paused" ? { icon: "play", label: "Unpause", cmd: { cmd: "unpause", container: m.id } } : null,
        ...(m.ports ?? []).slice(0, 3).map((p) => ({ icon: "globe", label: `Open localhost:${p}`, cmd: { cmd: "open", port: p } })),
        sep,
        { icon: "eye", label: "Inspect", cmd: { cmd: "inspect", kind: "container", ref: m.id, name: m.name } },
        { icon: "copy", label: "Copy Container ID", copy: m.id },
        { icon: "copy", label: "Copy Name", copy: m.name },
        sep,
        { icon: "trash", label: "Remove…", danger: true, cmd: { cmd: "remove", kind: "container", ref: m.id, name: m.name, running: m.running } },
      ];
    }
    case "project":
      return [
        { icon: "play", label: "Compose Up (detached)", cmd: { cmd: "compose", project: m.project, verb: "up" } },
        m.running ? { icon: "stop", label: "Compose Stop", cmd: { cmd: "compose", project: m.project, verb: "stop" } } : null,
        !m.running ? { icon: "play", label: "Compose Start", cmd: { cmd: "compose", project: m.project, verb: "start" } } : null,
        { icon: "retry", label: "Compose Restart", cmd: { cmd: "compose", project: m.project, verb: "restart" } },
        { icon: "list", label: "Compose Logs", cmd: { cmd: "compose", project: m.project, verb: "logs" } },
        { icon: "download", label: "Compose Pull", cmd: { cmd: "compose", project: m.project, verb: "pull" } },
        m.workdir ? { icon: "copy", label: "Copy Project Folder", copy: m.workdir } : null,
        sep,
        { icon: "trash", label: "Compose Down…", danger: true, cmd: { cmd: "compose", project: m.project, verb: "down" } },
      ];
    case "image":
      return [
        { icon: "play", label: "Run…", cmd: { cmd: "runImage", ref: m.ref } },
        !m.dangling ? { icon: "download", label: "Pull", cmd: { cmd: "pull", ref: m.ref } } : null,
        { icon: "eye", label: "Inspect", cmd: { cmd: "inspect", kind: "image", ref: m.ref, name: m.ref } },
        { icon: "copy", label: "Copy Image ID", copy: m.id },
        !m.dangling ? { icon: "copy", label: "Copy Name", copy: m.ref } : null,
        sep,
        { icon: "trash", label: "Remove…", danger: true, cmd: { cmd: "remove", kind: "image", ref: m.ref, name: m.ref } },
      ];
    case "volume":
      return [
        { icon: "eye", label: "Inspect", cmd: { cmd: "inspect", kind: "volume", ref: m.name, name: m.name } },
        { icon: "copy", label: "Copy Name", copy: m.name },
        sep,
        { icon: "trash", label: "Remove…", danger: true, cmd: { cmd: "remove", kind: "volume", ref: m.name, name: m.name } },
      ];
    case "network":
      return [
        { icon: "eye", label: "Inspect", cmd: { cmd: "inspect", kind: "network", ref: m.id, name: m.name } },
        { icon: "copy", label: "Copy Name", copy: m.name },
        ...(m.builtin ? [] : [sep, { icon: "trash", label: "Remove…", danger: true, cmd: { cmd: "remove", kind: "network", ref: m.id, name: m.name } }]),
      ];
    case "prune":
      return [
        { icon: "trash", label: "Stopped Containers…", cmd: { cmd: "prune", what: "containers" } },
        { icon: "trash", label: "Dangling Images…", cmd: { cmd: "prune", what: "images" } },
        { icon: "trash", label: "All Unused Images…", cmd: { cmd: "prune", what: "images-all" } },
        { icon: "trash", label: "Unused Volumes…", cmd: { cmd: "prune", what: "volumes" } },
        { icon: "trash", label: "Unused Networks…", cmd: { cmd: "prune", what: "networks" } },
        sep,
        { icon: "trash", label: "System Prune…", danger: true, cmd: { cmd: "prune", what: "system" } },
      ];
  }
  return [];
}

// Drops leading, trailing and doubled separators left by items that don't apply.
export function cleanItems(list) {
  const out = [];
  for (const it of list.filter(Boolean)) {
    if (it.sep && (!out.length || out[out.length - 1].sep)) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].sep) out.pop();
  return out;
}

export const menuMethods = {
  openMenu(menu) {
    const items = cleanItems(menuItems(menu));
    const seps = items.filter((i) => i.sep).length;
    openOverlay({ mod: MOD, kind: "popup", width: 240, height: (items.length - seps) * ITEM + seps * SEP + 12, props: { menu } });
  },

  renderMenu() {
    const t = theme();
    const close = () => closeOverlay(props()?.overlay);
    const items = cleanItems(menuItems(this.menu));
    return v_flex().id("dk-menu").size_full().p(6).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(TEXT.small)
      .children(items.map((it, i) => it.sep
        ? div().h(SEP).flex_none().flex().items_center().child(div().h(1).w_full().bg(t.border))
        : h_flex().id(`dkm-${i}`).h(ITEM).flex_none().px(8).gap(8).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => {
            if (it.copy) cx.write_to_clipboard(it.copy);
            else post(it.cmd);
            close();
          })
          .child(Icon(it.icon, 13).text_color(it.danger ? t.ansi1 : t.dim))
          .child(div().truncate().text_color(it.danger ? t.ansi1 : t.foreground).child(it.label))));
  },
};
