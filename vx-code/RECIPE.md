# vx-code

Herdr laid out like the current VS Code: a title bar with a command center, an activity bar, and three rounded cards (side bar, editor, bottom panel) on a dark canvas, with a plain status bar. The side bar holds a multi-root Explorer of your `.code-workspace`, Search, GitLens-style Source Control, CI, Spaces and Agents; the editor shows terminals, agents, file previews you can edit, diffs and a commit graph. Ships the One Monokai theme.

![vx-code](preview.png)

## What you see

Top to bottom, on the theme's `canvas`:

- **Title bar** (`titlebar`, 38px, `window_drag`, vx-titlebar): room for the traffic lights, the workspace name in `muted`; centred ← → (26px, 40% opacity when there's nowhere to go) and the **command center** (24px, up to 520px, radius 6, `border`, search icon + workspace name); on the right Customize Layout, Toggle Side Bar, Toggle Panel (15px icons, `dim`, `foreground` when on).
- **Body** (row, 2px top and bottom padding):
  - **Activity bar** (48px, `canvas`): 22px icons in 48px cells: Explorer, Search, Source Control, CI / CD, Docker, HTTP Client, Spaces, Agents; at the bottom Dev Tools, Commit Graph and Settings. The shown view is `foreground`, others `dim`. Badges: a 15px `accent` pill with the number of changed files on Source Control, agents waiting on Agents; an 8px dot on CI (`ansi1` a failed pipeline, `ansi4` running).
  - **Side bar card** (300px, 200–640, radius 12, 1px `raised` border, `chrome`, 4px padding): a 32px title (`EXPLORER`, `SEARCH`, `SOURCE CONTROL`, `CI / CD`, …, 11px medium) over a stack of the views. Explorer = the workspace tree (header `name (Workspace)` + buttons, a filter, one row per root with the Material root-folder ring, its branch, a status dot) above three collapsible sections, **Claude Plans**, **Timeline · file** and **NPM Scripts · package** (22px headers, chevron, uppercase).
  - **Work column** (6px side padding, 6px gap):
    - **Editor card** (radius 12, `raised` border, `background`): the **tab bar** (35px, `chrome`, rounded top, a 10px inset strip): flush tabs with 1px separators: a 3px repo-colour mark, the program or file icon, the name (italic while it's the reused preview), a faint context (`repo · branch` or the file's folder), and × on hover / on the active tab (a dot when the file has unsaved edits; a spinner or status dot for agents). Active tab: `background`; others `chrome`. Right: `+`, Split Right, ⋯ (all tabs) and the package-script control. Under it the **breadcrumbs** (24px, `background`): root ring › folders › file icon + name. Then the active tab's panes, inset 4px.
    - **Bottom panel card** (260px, hidden at first, same card look, 4px padding): a 34px header with tabs **Problems** (count pill), **Terminal**, **Ports** (count), the active one underlined in `foreground`; on Terminal also `shell - folder`, +, 🗑; then ⌃ maximise and ×. Under it the chosen tab.
- **Status bar** (24px, `canvas`): a remote glyph, the repo, branch, sync, changes, staged, conflicts, `✕ errors ⚠ warnings`, the port count; right: Claude Code model and meters (with the vx-status plugin), the repo's last pipeline (CI icon in its state colour + `passed` / `failed` / `running` / `manual`), the workspace name. 12px text, 14px icons.

## How it behaves

- **Activity bar**: clicking a view shows it in the side bar; clicking the shown one hides the side bar. Graph opens the Commit Graph tab of the active repo; Settings opens Herdr's settings.
- **Active repo**: every view follows the repo you picked (Explorer click, a `repo ▾` switcher) or else the repo of the focused terminal.
- **Quick Open** (⌘P or the command center): a popup over the command center (up to 720px wide, sized to its rows, 24px rows, 18 shown). Input: VS Code's placeholder, `accent` border, no icon. Rows: 16px icon, name in `foreground` with matched letters `accent` and semibold, then `repo • folder` in `dim`; the first row of a group carries its label on the right (`recently opened`, `file results`, `recently used`, `other commands`, `symbols (n)`) and a top border; the selected row (`selected`) shows Open to the Side and, for a recent file, × Remove from Recently Opened. Modes: files of every root (`git ls-files`, words must all match, name hits first; `name:42` opens at line 42), `:` line in the active file, `@` symbols of it (classes, functions, methods, types, consts, headings; ⌘⇧O), `>` Herdr's commands (`commands()`, those needing no arguments, plus bound actions like `pane.split:right`) and vx's own, with their key from `keys()`, recently used first, `%` text across every root (`git grep`), `?` the list of prefixes. ↑↓ wrap, PageUp / PageDown, Enter, ⌘Enter to the side, Esc. Every file previewed anywhere joins "recently opened" (`vx.goto.recent`).
- **Search** (⌘⇧F): `git grep --untracked` in each root (respects `.gitignore`, skips binaries); Aa / ab / .* toggles (regex is Perl-compatible), ⋯ for "files to include" (`*.ts, src/`); results by repo › file › line with the match highlighted, capped at 2,000; a match opens the preview at that line.
- **Tabs**: the file and diff tabs are reused previews (italic); double-click or Keep Open makes one stay, and the next file opens a new preview; editing keeps it too. Drag to reorder, right-click for Keep Open, Pin / Unpin (pinned tabs are icon-only, on the left), Rename, Close, Close Others / to the Right (click twice), Put Away. ⋯ lists every tab with a filter; ⌘E is the same list in recent order with the previous tab preselected. Wheel or swipe switches tabs.
- **Preview**: syntax colours, changed-line bars, blame with heatmap, file / line history; ✎ switches to Herdr's code editor; ⌘S (or Save) writes the file only if it didn't change on disk since; Revert drops the edits.
- **Claude Plans**: `~/.claude/plans/*.md` newest first, titled by the first heading, with age and an `accent` dot while modified in the last 2 minutes; a click opens it rendered in the preview tab, right-click for Open, Edit, Reveal in Finder, Copy Path and Delete… (to the Trash, asks first). The folder is watched: a new or rewritten plan posts a toast "Plan updated: title" whose click opens it; an open preview reloads, and an editor over a file that changed on disk shows "Load disk version / Keep mine". Quick Open `~` lists plans, and they join file results as "claude plans". `bin/vx-edit FILE` (installed to `~/.local/bin`) opens FILE editing, with a "Waiting for you… Done" bar, and exits on Done or when the tab closes, so `VISUAL=vx-edit` makes Claude's Ctrl+G edit in Herdr.
- **Timeline**: the commits of the file in the active tab; a click opens that commit's diff. **NPM Scripts**: every script of the active repo's `package.json`; a click or ▶ runs it in a new tab.
- **Bottom panel** (⌘J, `` ctrl-` ``): Terminal starts a shell in the active repo the first time (`hc run`, label `vx.panel=1`, never a tab), keeps it across hide / show, hides when the last one exits. Problems lists conflicts, failing pipelines, branches behind and unreadable repos (a click opens that view) and, after **Run checks**, the output of the repo's `typecheck` and `lint` scripts parsed into file:line rows (tsc, ESLint and `file:line:col:` formats); a click opens the file at the line. Ports lists `lsof` listeners with their folder; 🌐 opens `http://localhost:port`, ■ stops the process after asking.
- **Status bar**: ✕ ⚠ opens Problems, the port count opens Ports, the pipeline opens CI / CD, the branch copies itself, ↑↓ offers fetch / pull / push (asks first).
- **Docker** (⌘⌥D, side bar): see vx-docker in the README. **HTTP Client** (⌘⌥R, side bar and request tabs, Thunder Client's layout). **Dev Tools** (the wrench at the bottom of the activity bar opens the tab; ⌘⌥T the paste-anything popup, a centred dialog). **Chat** (⌘⌥I or the ✨ Chat button right of the command center, which also toggles the right side bar): a 400px card (300–760) right of the editor, hidden at first.
- **Keys** (`keys.json` section `layout:vx-code`): ⌘P, ⌘⇧O, ⌘⇧F, ⌘⇧E, ⌘⇧G, ⌘J / `` ctrl-` ``, ⌘E, ⌘\ split right, ⌘S save, ⌘⌥D Docker, ⌘⌥R HTTP, ⌘⌥T Dev Tools popup, ⌘⌥I Chat; ⌘B toggles the side bar (Herdr's).

## Built from

- `layouts/vx-code.json`: root `column` (`background: canvas`, `titlebar: none`, `traffic_lights: [12, 12]`): `titlebar` block (vx-titlebar) · `body` row (`padding: [2, 0]`): `activity` (vx-activity) · `sidebar` column (`radius 12`, `border raised`, `padding 4`): `sidebar-title` (vx-activity `{title: true}`) and stack `sidebar-views`: `explorer` column [`explorer-tree` vx-workspace, `plans` vx-files `{section: "plans", block: "plans"}`, `timeline` vx-files `{section: "timeline", block: "timeline"}`, `npm` vx-scripts `{section: "npm", block: "npm"}`], `search` vx-search, `scm` vx-changes, `ci` vx-ci `{panel: true}`, `docker` vx-docker, `http` vx-http, `spaces` and `agents` (Herdr's) · `work` column (`padding [0, 6]`, `gap 6`): `editor` column (card) [`tabs` vx-tabs `{style: "vscode"}`, `breadcrumbs` vx-tabs `{breadcrumbs: true}`, `editor-body` (`padding [4, 4]`) → `main` `{tab: "active"}` with flat pane frames], `bottom` column (card, hidden) [`panel-head` vx-panel, `term` vx-panel `{empty: true}`] · `chat` column (card, `size 400`, `min 300`, `max 760`, hidden) → `chat-view` vx-chat · `status` block (vx-status `{style: "vscode"}`).
- Mods: vx-titlebar, vx-activity, vx-workspace, vx-files (preview, Claude Plans, Timeline), vx-search, vx-changes, vx-graph (opened as a tab), vx-ci, vx-tabs, vx-scripts, vx-panel, vx-status, vx-docker, vx-http, vx-devtools (opened as a tab and a popup), vx-chat, vx-icons (icons for all). Each carries a copy of `shared/`.
- The bottom panel swaps what `term` shows with `layout.set` (the current `layout()` tree with that block's `content` replaced): `{terminal: "t7"}` for a shell, `{mod: "vx-panel", props: {view: "problems" | "ports"}}`.
- Shared state: `vx.workspace`, `vx.active`, `vx.git`, `vx.ci.summary`, `vx.panel` `{view, shown, list}`, `vx.checks` (per repo), `vx.ports`, `vx.tabs.kept` / `.pinned` / `.mru`, `vx.dirty`, `vx-files.view` (per space, `{root, rel, line?}`), `vx.goto.recent`.
- Programs: `git` (status, ls-files, grep, log, blame, diff), `glab` / `gh` for CI, `lsof`, `hc run`, the package manager for scripts and checks, `open`.
- `themes/one-monokai.json`: One Monokai (background `#282c34`, chrome `#21252b`, canvas `#16181c`, border `#181a1f`, raised `#2c313a`, accent `#528bff`, ANSI from the VS Code theme).

## Watch out

- Herdr doesn't clip anything inside a rounded node: blocks paint square corners over the curve. Pad the side bar and panel cards by 4px (their contents share the card colour), round the tab bar's top and inset its tabs 10px, and wrap the terminal block in a 4px-padded column.
- Draw the card border in `raised`, not `border`: in One Monokai `border` is darker than the canvas and the edge disappears.
- Mods hidden in a stack or a hidden column may not get key commands: route ⌘J through vx-activity (always shown), and let the panel header start a shell when it appears.
- Name shared files so they can't collide with a mod's own (`tools/build.mjs` refuses).
- A virtual list's rows can't carry handlers (click, hover, tooltip): they draw nothing. Use the list's `on_item_click(key)`, or draw a small window of rows yourself (Quick Open draws its 18 visible rows and scrolls them on the wheel).
- Elements are single-use: cache row *data*, never elements (an icon kept in a cached row fails the next render with "element was already added to a parent").
- Keep heavy work out of render: Quick Open ranks ~15,000 paths only when the query changes, in slices of 2,500 between frames, with lowercased paths prepared once; a render that runs too long shows "This view could not be re-rendered … interrupted".
- `git grep -E` doesn't know `\w`: use `-P`, falling back to `-E` when git has no PCRE.
- Each layout edit by vx-panel rewrites the installed layout file, so `sync.sh` only reinstalls the layout when the source changed.

## Done when

- Clicking Explorer / Search / Source Control / CI swaps the side bar; clicking the shown one hides it.
- ⌘P lists files of every root; Enter opens the preview; `>` opens the palette.
- Searching a word lists matches by repo and file; a match opens the file scrolled to that line.
- Clicking a file in the Explorer opens an italic preview tab; double-clicking it keeps it and the next file opens a second tab.
- ✎ then typing shows the tab's dot; ⌘S saves and the dot goes.
- ⌘J shows a shell in the active repo that isn't listed as a tab; Run checks in a repo with a `typecheck` script lists its errors with Ln / Col.
- All three cards show rounded corners at all four edges in One Monokai and in a light theme.
