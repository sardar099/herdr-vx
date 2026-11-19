// Loads vx-icons' table once per copy. Pass the view: it sets view.icons and redraws.
import { appHome, readTextFile } from "herdr";

export function loadIcons(view, cx) {
  view.icons ??= null;
  cx.spawn(async (cx) => {
    try {
      view.icons = JSON.parse((await readTextFile(`${appHome()}/mods/vx-icons/icons.json`)) ?? "null");
    } catch {
      view.icons = null;
    }
    cx.notify();
  });
}
