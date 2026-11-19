# vx-workspace

A VS Code-style Explorer for Herdr's Files panel: every folder of a `*.code-workspace` (or a folder of repos) with its file tree, git colours and a filter across all of them, plus the file preview tab (syntax colours, Markdown, images, GitLens blame with an age heatmap, file and line history).

![vx-workspace](preview.png)

## What you see

- **Header** (36px): workspace name, + (Add Folder…), dotfiles toggle, collapse, refresh, ⋯ (Add Folder…, New Workspace…, Open Workspace…, Save Workspace As…, Reveal Workspace File, Close Workspace, Recent).
- **Filter box** (26px): typing lists matching files of every root, grouped by root (300 at most).
- **One 24px row per root**: chevron, Material folder icon, name, branch in `dim` on the right, and one 7px dot: `ansi1` failing CI or conflicts, `ansi4` running CI, `ansi3` changes; none when clean. Hover shows path, upstream, ↑↓, counts, pipeline.
- **The tree** under an open root: 22px rows indented 12px, Material icons, git letters (`A` `ansi2`, `M` `ansi3`, `D`/`U` `ansi1`), a dot on folders holding changes, git-ignored entries in `dim`.
- **Preview tab** (vx-files, one reused centre tab per space): code as rows with line numbers and syntax colours, a bar on lines changed since HEAD; Markdown rendered (Code toggles back); images. Blame adds a 230px column (author · age · summary per commit block) and a 4px heat strip; History and Line history open a 320px drawer of commits.

## How it behaves

- Click a root: it becomes the **active repo** (shared `vx.active`, which the other vx mods follow) and folds open; double-click opens or focuses a terminal there; drag any row (a root, a file or folder, a filter hit) onto a terminal to paste its quoted path; right-click: Open in Terminal, Reveal in Finder, Copy Path, Rename…, Move Up / Down, Remove Folder from Workspace, Fetch… (asks first).
- Click a file: preview. Right-click a file: Open Preview, Open with Default App, Reveal, Copy Path / Relative Path.
- In the preview, ✎ switches to Herdr's code editor; ⌘S (key `vx-files.save`) or Save writes the file only if it didn't change on disk since it was opened; Revert drops the edits. Editing keeps the tab (it stops being the reused preview) and vx-tabs shows a dot while there are unsaved changes (shared `vx.dirty`). A viewer value with `line` (Search, Problems) scrolls there.
- vx-files `{section: "timeline", block}` is a collapsible side-bar section: the commits of the file in the active tab; a click opens that commit's diff.
- Workspace edits rewrite the `.code-workspace` like VS Code (tabs, relative paths, other keys kept), reading it again just before writing. A pick wins over the focused terminal until focus moves to another terminal.
- `mod.open:vx-workspace` opens the ⋯ menu.

## Built from

`mods/vx-workspace` (main.js, explorer.js, menus.js + the shared files) and `mods/vx-files` (the preview tab). Block: `{ "id": "files", "type": "block", "content": { "mod": "vx-workspace" } }` (only one copy per layout: it writes the workspace state and runs its popups' commands). Runs `git`, `sh` (folder listing), `open`.

**Install:** copy `mods/*` from this folder into `~/.config/herdr-app/mods/`, and also copy
`vx-icons/mods/vx-icons` from this repo (every vx mod draws its icons from it). Then put the
block in a layout you own (below). The whole set as a ready layout: the repo root (`layouts/vx.json`).

## Watch out

Every vx mod needs `vx-icons` next to it (icons go blank without it). The mods share state through Herdr's `shared()` keys `vx.*`, so they work alone but follow each other when installed together. Only one copy of each panel mod per layout.

## Done when

- Opening a folder with a `.code-workspace` lists its roots with branches; clicking one makes it active.
- Add / remove / rename / reorder change the file exactly as VS Code would.
- A modified file shows `M` and its folder a dot; the preview shows blame and file history.
- `herdr-app check` passes for every mod in this folder.
