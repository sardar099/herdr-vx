#!/bin/sh
# Installs the vx mods into the Herdr app, which hot-reloads them.
#
#   ./sync.sh                     every mod in mods/, the themes, and our layouts you have
#   ./sync.sh vx-status           just these mods (themes and layouts too)
#   ./sync.sh --layout vx-code    also add that layout (layouts/vx-code.json + .svg)
#
# bin/ (vx-edit) goes to ~/.local/bin.
#
# Themes (themes/*.json) are copied when they differ. A layout is copied when it's new (asked
# for with --layout) or when the repo's file changed since the last sync: Herdr keeps clicks
# (sizes, hidden) apart, but vx-panel edits the installed layout itself (layout.set), so an
# unchanged source never overwrites it.
#
# Each mod is put together in a hidden staging folder (Herdr doesn't watch hidden folders) with
# its mod.json and a copy of shared/ (a mod can only import files from its own folder), checked
# with `herdr-app check`, then swapped in with one rename. So Herdr never sees a half-copied mod
# (a folder seen without its mod.json gets docked into the layout), and an unchanged mod is not
# touched at all (every reload keeps the old build's code for the app's life).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
home_dir=${HERDR_APP_HOME:-"$HOME/.config/herdr-app"}
stage="$home_dir/mods/.vx-stage"
[ -d "$home_dir/mods" ] || { echo "no Herdr app home at $home_dir" >&2; exit 1; }

add_layouts=""
names=""
while [ $# -gt 0 ]; do
  case "$1" in
    --layout) add_layouts="$add_layouts $2"; shift 2 ;;
    *) names="$names $1"; shift ;;
  esac
done
node "$here/tools/build.mjs"
[ -n "$names" ] || names=$(cd "$here/mods" && ls -d vx-* | tr '\n' ' ')
rm -rf "$stage" && mkdir -p "$stage"
trap 'rm -rf "$stage"' EXIT
status=0
for name in $names; do
  src="$here/mods/$name"
  [ -f "$src/mod.json" ] || { echo "skip   $name (no mod.json)"; continue; }
  dst="$stage/$name"
  mkdir -p "$dst"
  cp "$src/mod.json" "$dst/mod.json"
  # Settings saved in the app (a mod's settings dialog writes its installed mod.json) win
  # over the source's, so a sync never resets them.
  if [ -f "$home_dir/mods/$name/mod.json" ]; then
    node -e '
      const fs = require("fs");
      const [src, inst] = process.argv.slice(1).map((p) => JSON.parse(fs.readFileSync(p, "utf8")));
      if (inst.settings && Object.keys(inst.settings).length) {
        src.settings = { ...(src.settings ?? {}), ...inst.settings };
        fs.writeFileSync(process.argv[1], JSON.stringify(src, null, 2) + "\n");
      }' "$dst/mod.json" "$home_dir/mods/$name/mod.json" || true
  fi
  (cd "$src" && tar cf - --exclude mod.json --exclude jsconfig.json --exclude '*.d.ts' --exclude .DS_Store .) | (cd "$dst" && tar xf -)
  if ! herdr-app check "$dst" >/dev/null 2>"$stage/$name.err"; then
    echo "FAIL   $name: herdr-app check"; sed 's/^/       /' "$stage/$name.err" | tail -20; status=1; continue
  fi
  target="$home_dir/mods/$name"
  if [ -d "$target" ] && diff -rq -x jsconfig.json -x '*.d.ts' -x '.*' -x cache "$dst" "$target" >/dev/null 2>&1; then
    echo "same   $name"; continue
  fi
  if [ -d "$target" ]; then mv "$target" "$stage/.old-$name"; fi
  mv "$dst" "$target"
  echo "synced $name"
done

# Themes: copy when different (atomic: temp file, then rename).
mkdir -p "$home_dir/themes"
for f in "$here"/themes/*.json; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if cmp -s "$f" "$home_dir/themes/$n"; then echo "same   theme $n"; continue; fi
  cp "$f" "$home_dir/themes/.$n.tmp" && mv "$home_dir/themes/.$n.tmp" "$home_dir/themes/$n" && echo "synced theme $n"
done

# Helper programs (bin/: vx-edit) into ~/.local/bin, when different.
mkdir -p "$HOME/.local/bin"
for f in "$here"/bin/*; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if cmp -s "$f" "$HOME/.local/bin/$n"; then echo "same   bin $n"; continue; fi
  cp "$f" "$HOME/.local/bin/.$n.tmp" && chmod +x "$HOME/.local/bin/.$n.tmp" && mv "$HOME/.local/bin/.$n.tmp" "$HOME/.local/bin/$n" && echo "synced bin $n"
done

# Layouts: ours that are installed (or asked for), when the source changed since last sync.
seen="$home_dir/layouts/.vx-synced"
mkdir -p "$seen"
for f in "$here"/layouts/*.json; do
  n=$(basename "$f" .json)
  installed="$home_dir/layouts/$n.json"
  asked=0
  for a in $add_layouts; do [ "$a" = "$n" ] && asked=1; done
  if [ ! -f "$installed" ] && [ $asked = 0 ]; then continue; fi
  if [ -f "$installed" ] && [ $asked = 0 ] && cmp -s "$f" "$seen/$n.json"; then echo "same   layout $n"; continue; fi
  [ -f "$here/layouts/$n.svg" ] && cp "$here/layouts/$n.svg" "$home_dir/layouts/$n.svg"
  cp "$f" "$home_dir/layouts/.$n.json.tmp" && mv "$home_dir/layouts/.$n.json.tmp" "$installed" && cp "$f" "$seen/$n.json"
  echo "synced layout $n"
done
exit $status
