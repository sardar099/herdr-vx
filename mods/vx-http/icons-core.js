// Which Material Icon Theme picture a file or folder gets. Pure (the table is passed in).
// VS Code's rules: names match case-insensitively; a path rule (".github/workflows") beats a
// name, a name beats an extension, and the longest extension wins ("spec.ts" over "ts").
// A light theme checks the light table first. Open folders use "<id>-open".

export const ICON_DIR = "mods/vx-icons/icons";

const strip = (name) => name.replace(/^__(.+)__$/, "$1").replace(/^[._-]/, "");
const openOf = (id) => (id.endsWith("_light") ? `${id.slice(0, -6)}-open_light` : `${id}-open`);

export function iconFor(table, path, { dir = false, open = false, light = false } = {}) {
  if (!table) return null;
  const get = (kind, key) => (light ? table.light?.[kind]?.[key] : undefined) ?? table[kind]?.[key];
  const parts = String(path).toLowerCase().split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  const kind = dir ? "folderNames" : "fileNames";
  const find = (key) => get(kind, key) ?? (dir ? get(kind, strip(key)) : undefined);
  let id;
  for (let i = Math.max(0, parts.length - 3); !id && i < parts.length - 1; i++) id = find(parts.slice(i).join("/"));
  if (dir) {
    id ??= find(name) ?? table.folder;
    return `${ICON_DIR}/${open ? openOf(id) : id}.svg`;
  }
  id ??= get(kind, name);
  for (let dot = name.indexOf("."); !id && dot !== -1; dot = name.indexOf(".", dot + 1))
    id = get("fileExtensions", name.slice(dot + 1));
  return `${ICON_DIR}/${id ?? table.file}.svg`;
}

// Herdr's theme() has no light flag: a theme is light when its background is.
export function isLight(hex) {
  const m = /^#([0-9a-f]{6})/i.exec(hex ?? "");
  if (!m) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 128;
}
