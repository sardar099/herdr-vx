# herdr-vx

A VS Code-style workspace for [Herdr Desktop](https://herdr.dev): a multi-root Explorer, Search across
every repo, GitLens-style git, GitLab and GitHub CI, a commit graph, file preview and editing, a
package-script runner, and a bottom panel with Problems, Terminal and Ports, all following the repo
you're working in.

![herdr-vx](preview.png)

Herdr's own panels follow the focused terminal's folder, so a terminal sitting in a folder of several
repos shows nothing useful. herdr-vx reads your `*.code-workspace` (or a folder of repos) and keeps
one **active repo** that every panel follows: the one you pick, else the repo your terminal is in.

Two layouts:

- **`vx-code`**: the whole window laid out like the current VS Code: title bar with a command
  center (Go to File), activity bar, side bar, editor and bottom panel as rounded cards, and a status
  bar. Ships the **One Monokai** theme. See [vx-code/RECIPE.md](vx-code/RECIPE.md).
- **`vx`**: Herdr's own window with the vx panels on the right.

![vx-code](vx-code/preview.png)

## What's in it

| Mod | Where | What |
|---|---|---|
| **vx-workspace** | Explorer | The Explorer: every root of the workspace (Material root-folder icons, branch, status dot) with its file tree, git colours, ignored folders dimmed and a filter across all roots. Drag any row (root, file, folder, filter hit) onto a terminal to paste its path. Add / remove / rename / reorder roots (written to the `.code-workspace` the way VS Code writes it); Open, Recent, New, Save As and Close workspace. |
| **vx-changes** | Source Control | VS Code's Source Control: a commit box with Commit All, Commit & Push / Sync, Amend and a ✨ message written by Claude (`claude -p`); staged / unstaged / merge changes with stage, unstage and discard per file (hover or right-click) and **per hunk** in the diff tab; pull, push, publish, sync, fetch, stash and new branch. Plus GitLens-style Commits (graph lanes, authors, branch and tag pills, incoming / outgoing), Branches (switch, delete), Remotes (check out), Stashes (apply, pop, drop), Tags, and Search & Compare. |
| **vx-ci** | CI panel (⌘⌥C) | GitLab pipelines (via `glab`) and GitHub Actions runs (via `gh`): runs, jobs by stage, retry, cancel, run a pipeline or dispatch a workflow, download artifacts. |
| **vx-graph** | centre tab | Commit Graph: branch lanes, branch and tag labels, commit details and their diffs. |
| **vx-files** | centre tab | File preview: syntax colours, Markdown, images, GitLens blame with an age heatmap, file and line history, and **Edit** (Herdr's code editor, ⌘S saves). Also the Timeline side-bar section. |
| **vx-tabs** | tab bar | Tabs with icons and repo context, italic preview tabs (double-click keeps one), pinned tabs, a right-click menu (Keep Open, Pin, Rename, Close Others / to the Right, Put Away), drag to reorder, all-tabs list and ⌘E switcher in recent order, a dot for unsaved edits, the package-script runner; in vx-code also the breadcrumbs. |
| **vx-scripts** | popup | Every `package.json` script (workspace packages too), run in a new tab or beside you, with npm / pnpm / yarn / bun detected and switchable. Also the NPM Scripts side-bar section. |
| **vx-status** | bottom bar | Repo, branch, ↑↓ with fetch / pull / push, changes, conflicts, stashes; in vx-code also `✕ errors ⚠ warnings` (opens Problems), the listening-port count (opens Ports) and the repo's last pipeline; with the Claude Code plugin, the model and context / usage meters. |
| **vx-search** | side bar (vx-code) | Search across every repo of the workspace (`git grep`): Match Case, Whole Word, Regex, files to include; a match opens the file at its line. |
| **vx-panel** | bottom panel (vx-code) | Problems (conflicts, failing pipelines, branches behind, and **Run checks**: the repo's typecheck / lint scripts as file:line rows), Terminal (shells that never become tabs), Ports (listening programs: open, or stop after asking). |
| **vx-activity** | activity bar (vx-code) | Explorer, Search, Source Control, CI, Spaces, Agents with badges; Graph and Settings. Also the side bar's title. |
| **vx-titlebar** | title bar (vx-code) | Workspace name, ← → through visited tabs, the command center and **Quick Open** like VS Code's: files of every repo with the matched letters highlighted (recently opened first, `name:42` opens at a line), `:` go to line, `@` go to symbol, `>` every Herdr and vx command with its key, `%` search text, `?` help; ⌘Enter opens to the side. Layout toggles. |
| **vx-icons** | assets | [Material Icon Theme](https://github.com/material-extensions/vscode-material-icon-theme) icons (MIT) and the UI icons. |

Changes, CI and Graph each have a `repo ▾` switcher in their header.

![Changes and a diff](docs/changes.png)

## Install

### With your agent

Paste this into your agent inside Herdr:

```text
Read ~/.config/herdr-app/AGENTS.md, then add this layout: https://github.com/sardar099/herdr-vx/tree/main/vx-code
Also copy its themes/ folder into ~/.config/herdr-app/themes/.
```

The agent copies the layout and its mods, merges its `keys.json` (asking before it replaces a key you
already use), checks every mod and switches to it. For the other layout (Herdr's window with the vx
panels on the right) use `https://github.com/sardar099/herdr-vx` instead.

### By hand

Needs Node 18+ and Herdr's `herdr-app` command (both only for installing).

```sh
git clone https://github.com/sardar099/herdr-vx
cd herdr-vx
./sync.sh --layout vx-code           # every mod (checked first), the One Monokai theme, the layout
node tools/add-keys.mjs vx-code      # the keys below; keys you already set win
herdr-app do layout.switch '{"name":"vx-code"}'
```

`sync.sh` installs into `~/.config/herdr-app` (or `$HERDR_APP_HOME`). For the other layout:
`./sync.sh --layout vx`. Your own layout stays as it was: `ctrl-shift-l` (⌘⇧L on macOS) switches
between layouts.

**Just one piece?** Each folder at the top of this repo is its own gallery entry with its own
recipe: `vx-workspace/` (Explorer + preview tab), `vx-changes/` (+ Commit Graph), `vx-ci/`,
`vx-tabs/` (+ script runner), `vx-status/`, and `vx-icons/` (the icon pack every vx mod needs).
`vx-code/` is the VS Code layout with every mod it uses.

### Theme

One Monokai is in Settings › Look once `themes/one-monokai.json` is in `~/.config/herdr-app/themes/`
(`sync.sh` puts it there), or set `"theme": "one-monokai"` in `settings.json`. vx-code works with any
theme, light ones too.

### Keys (vx-code)

| Key | Does |
|---|---|
| ⌘P | Quick Open: files; `:` line, `@` symbol, `>` commands, `%` text, `?` help |
| ⌘⇧O | Go to Symbol in the open file |
| ⌘⇧F | Search |
| ⌘⇧E / ⌘⇧G | Explorer / Source Control |
| ⌘J or `` ctrl-` `` | Show or hide the bottom panel |
| ⌘E | Switch tab (recent first) |
| ⌘\ | Split right |
| ⌘S | Save the file you're editing |
| ⌘B | Show or hide the side bar (Herdr's) |

They live in the `layout:vx-code` section of `~/.config/herdr-app/keys.json`, so other layouts keep
Herdr's keys (⌘P stays Herdr's picker there). Optional, any layout: `"cmd-alt-c": "mod.open:vx-ci"`
toggles CI.

### Claude Code meters

The Claude Code plugin that fills the status bar's model and usage meters:

```sh
claude plugin marketplace add sardar099/herdr-vx
claude plugin install vx-status@vx
```

### Update and remove

Update: `git pull && ./sync.sh` (unchanged mods aren't touched; Herdr reloads the rest). Remove:
switch to another layout, then delete `layouts/vx-code.json` and `.svg`, the `mods/vx-*` folders,
`themes/one-monokai.json` and the `layout:vx-code` section of `keys.json` in `~/.config/herdr-app/`.

## Needs

- **git**. Claude Code's `claude` command for the ✨ commit message (optional). **glab** (logged in) for GitLab CI, **gh** (logged in) for GitHub CI. SSH host aliases in
  `~/.ssh/config` (e.g. `Host work-github`) are resolved to their real host.
- Run checks uses your repo's own `typecheck` / `lint` scripts (and its package manager); Ports uses
  `lsof` (built into macOS).
- macOS is tested. Folder listings use `sh`, so Linux should work; Windows isn't supported.

## Safety

Reads use `git --no-optional-locks -c core.fsmonitor=false`, so nothing writes under `.git` behind
your back. Programs get argument lists, never shell strings built from file names or API data.
Anything that changes a repo or CI asks first and shows the commands it will run: push, pull,
sync, publish, fetch, retry, cancel, run pipeline, dispatch, switch or delete branch (`branch -d`,
which refuses unmerged work), apply / pop / drop stash, and **discard**. Discard puts edited files
back to their last staged or committed copy and moves new files to the macOS Trash (staged changes
stay). Stage and unstage (also per hunk) touch only the index; commit is a button; new branch and
stash are dialogs you fill in. The ✨ commit message sends your diff and recent commit subjects to
Claude (`claude -p`), only when you click it.

What vx-code adds: **Edit** writes the file you're editing only when you press Save (⌘S), and
refuses if the file changed on disk since you opened it. **Run checks** runs the repo's own
`typecheck` / `lint` scripts from `package.json` when you click it. **Ports** lists listening
programs with `lsof`; Stop sends SIGTERM and asks first. Search is read-only (`git grep`).

## Development

`shared/` holds the code every mod uses; `tools/build.mjs` copies it into each mod folder (a Herdr mod
can only import from its own folder, and people install a mod by copying it). `*-core.js` files are
pure and tested under node.

```sh
npm test       # node --test tests/
./sync.sh      # build, herdr-app check, install mods + themes + our installed layouts (atomic; unchanged skipped)
node tools/add-keys.mjs vx-code   # merge a layout card's keys
```

How it's put together, for an agent rebuilding it: [RECIPE.md](RECIPE.md).

## Licence

MIT, see [LICENSE](LICENSE). The Material Icon Theme icons in `mods/vx-icons/icons/` are MIT,
copyright Material Extensions; their licence is in `mods/vx-icons/LICENSE-material-icon-theme.txt`.
