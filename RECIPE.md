# herdr-vx

A layout that turns Herdr into a VS Code-style workspace: the Files panel is a multi-root Explorer of a `.code-workspace`, Changes is GitLens-style git, CI shows GitLab pipelines and GitHub Actions, Graph is a commit graph, and the tab bar runs package scripts. Every panel follows one **active repo**: the one you pick, else the repo of the focused terminal.

![herdr-vx](preview.png)

## What you see

Herdr's `main` window, with these changes:

- **Tab bar** (`tabs` block, 42px, `chrome`): tab pills as in Herdr (29px, radius 7, agent icon, spinner while working, a `blocked`/`done` dot, × on the active one), then `+`, then the script control `[pm logo] script ▾ │ ▶` (26px, border `border`, ▶ in `ansi2`), a 1px divider, and on the right edge **Files · Changes · CI · Graph** (26px pills, 12px text; the open panel's on `selected`).
- **Right panel** (`panel` column, 368px, a `stack`): `files` = vx-workspace, `changes` = vx-changes, `ci` = vx-ci `{panel: true}`.
  - **Files**: a 36px header (layers icon, workspace name, + add folder, dotfiles, collapse, refresh, ⋯), a 26px filter box, then one 24px row per root: chevron, Material folder icon, name, branch in `dim` on the right, and one 7px dot: `ansi1` failing CI or conflicts, `ansi4` running CI, `ansi3` changes, none when clean. Under an open root, its tree in 22px rows indented 12px, git letters and colours (`ansi2` new, `ansi3` modified, `ansi1` deleted / conflict), a dot on folders holding changes, git-ignored entries in `dim`.
  - **Changes** (Source Control): header `[repo ▾]` + list/tree, refresh, ⋯ (pull, push, sync, fetch, stash, new branch); a branch pill and `↓n ↑n`; the commit card (message, ✨ Claude message, an `accent` Commit button with ⌄ for Commit & Push / Sync / Amend); groups Merge / Staged / Changes (icon, name, folder in `dim`, +/− blocks, a letter chip; on hover Open File, Discard, Stage); collapsible sections Commits (graph lanes, authors, ref pills, incoming / outgoing), Branches, Remotes, Stashes, Tags, Search & Compare. See [vx-changes/RECIPE.md](vx-changes/RECIPE.md).
  - **CI**: header `[repo ▾]`, a GitLab or GitHub badge, run ▶, open-web, refresh; filter chips All / Running / Failed / Passed with counts and a branch toggle; runs as two-line rows (status glyph ✓ ✕ ● ○ ▸ in `ansi2/ansi1/ansi4/dim/ansi5`, commit subject, `#n · ref · trigger · age`); a run opens its jobs grouped by stage.
- **Centre tabs** (mod panes): file preview (vx-files), diff (vx-changes), Commit Graph (vx-graph). Code rows are 1.55× the terminal font size with line numbers; additions tinted `ansi2`, removals `ansi1` (alpha `1f`); syntax colours: keywords `ansi5`, strings `ansi2`, numbers `ansi1`, types `ansi3`, calls `ansi4`, constants `ansi6`, comments `dim`. Blame adds a 230px column (author · age · summary on the first line of each commit block) and a 4px heat strip (`ansi1` newest → `ansi3` → `ansi2` → `ansi4` → `border` oldest).
- **Status bar** (`status`, 28px, `chrome`, top border): folder (accent layers icon when it comes from your pick), branch, ↑↓ / sync, changed (`ansi3`), staged (`ansi2`), conflicts (`ansi1`), stashes (`dim`), `clean`; on a Claude Code pane, model · effort and `ctx` / `5h` / `7d` meters (44×4 tracks; `ansi3` at 80%, `ansi1` at 95%).

## How it behaves

- **The active repo** (shared `vx.active` = `{root, on, name, by}`), first that applies: a repo you just picked (Explorer click, or a `repo ▾` switcher; `by: "pick"`) until focus moves to another terminal or it `cd`s; the workspace root holding the focused terminal; another repo the focused terminal is in; the last pick; the focused folder.
- **Explorer**: click a root to make it active and fold it open; double-click for a terminal there (an existing one is focused); drag any row (a root, a file or folder, a filter hit) onto a terminal to paste its quoted path; right-click for Open in Terminal, Reveal in Finder, Copy Path, Rename…, Move Up / Down, Remove Folder from Workspace, Fetch…; click a file for its preview; right-click a file for Open Preview, Open with Default App, Reveal, Copy Path / Relative Path. ⋯: Add Folder…, New Workspace… (name, where to save, folders), Open Workspace…, Save Workspace As… (for a plain folder of repos), Reveal Workspace File, Close Workspace, Recent. Edits rewrite the `.code-workspace` with tabs and relative paths, re-reading it first and keeping its other keys.
- **Changes**: stage / unstage per file, per hunk (diff tab) or all (conflicts excluded); commit takes what's staged (Commit All stages everything first); Amend loads the last message and refuses if HEAD moved. Discard, pull, push, sync, publish, switch / delete branch and apply / pop / drop stash ask first; new branch and stash are dialogs. Section files open their diff (commit vs first parent, stash, or `base...HEAD`). Switch branch and Apply stash ask first. Search finds commits by message, author, file or hash across all branches; Compare shows commits and files of the current branch vs `origin/HEAD` (else origin/staging, main, master), or any branch / tag you pick.
- **CI**: the project comes from `git remote get-url origin` (SSH aliases resolved with `ssh -G`), then `glab api projects/<path>` or `gh api repos/<path>`. Running runs refresh every 5 s. Retry, cancel, retry job, play a manual job, run pipeline (GitLab: branch + the `.gitlab-ci.yml` variables that have a description, plus extra `KEY=value`), dispatch (GitHub: workflow + inputs) and artifact downloads (to `~/Downloads/vx-ci/<repo>/<run>/`) all ask first. Once a minute the latest run of each root's branch goes to shared `vx.ci.summary` for the Explorer dots.
- **Scripts**: `package.json` at the active repo or up to 6 folders above; workspace packages from `workspaces` or `pnpm-workspace.yaml`. Package manager: `packageManager`, else the lockfile, else npm; the list switches among the installed ones per project. ▶ runs the chosen script in a new tab in its folder.
- **Status bar**: Fetch / Pull `--ff-only` / Push from the ↑↓ menu, each confirmed.
- Keys: `mod.open:vx-ci` toggles the CI panel; `mod.open:vx-scripts` opens the script list; `mod.open:vx-workspace` the workspace menu.

## Built from

- `layouts/vx.json`: Herdr's `main` clone; `tabs` → `vx-tabs`; `panel-body` children `files` (vx-workspace), `changes` (vx-changes), `ci` (vx-ci `{panel: true}`); `status` → vx-status. `layouts/vx.svg` is its picture.
- `mods/vx-*`: each folder carries a copy of `shared/` (`ws-core.js` context rules and workspace edits, `ws.js`, `git-core.js`, `ci-core.js`, `graph-core.js`, `blame-core.js`, `syntax-core.js`, `icons-core.js`, `jsonc.js`, `ui.js`, `actions.js` confirm-then-run, `tabs.js` one reusable centre tab per space, `repo-picker.js`, `scripts.js`, `icons.js`). `vx-icons` holds `icons/` (1,184 Material SVGs), `icons.json` and `ui/`.
- Shared state: `vx.workspace` (written only by vx-workspace), `vx.active`, `vx.changed` (a repo changed: reread), `vx.git`, `vx.ci.summary`, `vx.ws.cmd` / `vx.ws.reply` (popups ask the Explorer to act), `vx.changes.cmd` (Source Control's popups), `vx-files.view`, `vx-changes.view`, `vx-graph.view`, `vx.scripts`.
- Herdr calls: `exec` (git, glab, gh, sh, ssh -G, open, test), `readTextFile`, `watchFolder` (the active repo only), `openOverlay` / `closeOverlay`, `setShared`, `run` (`tab.new`, `tab.select`, `tab.rename`, `tab.move`, `tab.close`, `pane.focus`, `pane.split`, `layout.select`, `layout.show`, `layout.hide`, `layout.resize`), `pickFolder`, `notify`, `hc send` (insert `@path` into an agent).
- `claude-plugin/vx-status`: a module hook (`session.start`, `turn.step`, `turn.complete`, `session.measure`) writing `{model, effort, window, meters, at}` to `~/.local/state/vx-status/<HC_TERMINAL_ID>.json`.

## Watch out

- A Herdr mod imports only its own folder: keep `shared/` the one source and copy it (`tools/build.mjs`); a test fails on a stale copy.
- Write `mod.json` before anything else in a new mod folder: Herdr docks a folder it sees without `"place": "none"`.
- A popup sizes to its content: a scrolling list in one needs an explicit height. A virtual list needs a definite height from its parent (`h_full()` in a row).
- `child(null)` throws: filter optional children. `flex_shrink()` needs a number.
- `--literal-pathspecs` is a global git option: it goes before the subcommand.
- Only one vx-workspace copy per layout: it is the single writer of `vx.workspace` and runs the popups' commands.
- Never start work from `render()`; poll with `cx.timer` (400 ms context check), use `checking()` to skip side effects in `herdr-app check`.
- GitLab's pipeline list has no titles: subjects come from the local `git log`.

## Done when

- `npm test` passes and `herdr-app check` passes for every `mods/vx-*`.
- With the focused terminal in a non-repo folder holding a `.code-workspace`, the Files panel lists its roots with branches; clicking one switches Changes, CI, Graph, the script control and the status bar to it.
- Add / remove / rename / reorder change the `.code-workspace` exactly as VS Code would and keep its `settings`.
- A modified file shows `M` in the Explorer and the Changes list, and its diff opens with syntax colours, inline or side by side.
- A GitLab repo lists its pipelines; a GitHub repo behind an SSH alias lists its Actions runs; retry asks first.
- The Commit Graph draws a merged feature branch as a second lane joining back.
- Blame shows author · age · summary blocks and the heat strip; line history lists the commits of the clicked line.
- The tab bar's ▶ runs the chosen script in a new tab in the package's folder with the detected package manager.
