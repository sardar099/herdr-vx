// Claude Plans (props { section: "plans", block }): the plans Claude Code writes to
// ~/.claude/plans, newest first, as a collapsible Explorer section like Timeline. A click opens
// the plan in the preview tab (rendered Markdown, ✎ Edit, ⌘S); right-click for Edit, Reveal,
// Copy Path and Delete (to the Trash, after asking). It watches the folder: when Claude writes or
// rewrites a plan, a toast offers to open it, and an open preview reloads by itself.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, exec, home, readTextFile, watchFolder, notify, openOverlay, spaces } from "herdr";
import { LIST_PLANS, parsePlanList, planTitle, isLive, changedPlans } from "./plans-core.js";
import { timeAgo } from "./git-core.js";
import { showInViewer, viewerValue } from "./tabs.js";
import { SectionHead, sectionOpen } from "./side-sections.js";
import { TEXT, IconButton, FileIcon } from "./ui.js";
import { askConfirm } from "./actions.js";

const MOD = "vx-files";
const POLL_MS = 15000;
const TOAST_AGAIN_MS = 90000;

export const plansDir = () => `${home()}/.claude/plans`;

// Opens a plan in the space's preview tab; edit: true starts the editor once it has loaded.
export function openPlan(plan, edit = false) {
  showInViewer(MOD, { root: plansDir(), on: null, rel: plan.name, ...(edit ? { edit: Date.now() } : {}) }, plan.title ?? plan.name);
}

export const plansMethods = {
  initPlans(p, cx) {
    this.section = p.block ?? "plans";
    this.plans = null;
    this.titles = new Map(); // name -> { at, title }
    this.toasted = new Map(); // name -> when we last toasted it
    this.loadPlans(cx, false);
    cx.timer.every(POLL_MS, (cx) => this.loadPlans(cx, true));
    // Redraw ages and the live dot once a minute.
    cx.timer.every(60000, (cx) => cx.notify());
    this.watchPlans(cx);
  },

  watchPlans(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          await exec("mkdir", ["-p", plansDir()]);
          for (;;) {
            await watchFolder(plansDir());
            this.loadPlans(cx, true);
          }
        } catch {
          // A watch can be reclaimed or fail; the timer keeps the list fresh meanwhile.
          await new Promise((done) => cx.timer.after(POLL_MS, () => done()));
        }
      }
    });
  },

  loadPlans(cx, announce) {
    if (this.plansBusy) {
      this.plansAgain = true;
      return;
    }
    this.plansBusy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", LIST_PLANS, "vx-plans", plansDir()]).catch(() => null);
        const list = r?.code === 0 ? parsePlanList(r.stdout) : [];
        for (const plan of list) {
          const known = this.titles.get(plan.name);
          if (known?.at === plan.at) plan.title = known.title;
          else {
            const text = await readTextFile(`${plansDir()}/${plan.name}`).catch(() => null);
            plan.title = planTitle(text, plan.name);
            this.titles.set(plan.name, { at: plan.at, title: plan.title });
          }
        }
        const changed = this.plans && announce ? changedPlans(this.plans, list) : [];
        this.plans = list;
        if (changed.length) this.announcePlan(changed[0]);
      } finally {
        this.plansBusy = false;
        if (this.plansAgain) {
          this.plansAgain = false;
          this.loadPlans(cx, announce);
        }
        cx.notify();
      }
    });
  },

  // One toast per plan per 90 s (Claude edits a plan several times in a row), and none for the
  // plan already showing in the active space's preview.
  announcePlan(plan) {
    const now = Date.now();
    if (now - (this.toasted.get(plan.name) ?? 0) < TOAST_AGAIN_MS) return;
    const space = spaces().find((s) => s.active);
    const shown = space ? viewerValue(MOD, space.id) : null;
    if (shown?.root === plansDir() && shown.rel === plan.name) return;
    this.toasted.set(plan.name, now);
    notify({
      title: `Plan updated: ${plan.title}`, body: "Click to open it in Herdr", level: "info", timeout: 8000,
      action: space ? { name: "tab.new", args: { space: space.id, name: plan.title, mod: MOD, props: { mode: "view", space: space.id, fixed: true, file: { root: plansDir(), on: null, rel: plan.name } } } } : undefined,
    });
  },

  openPlanMenu(plan) {
    openOverlay({ mod: MOD, kind: "popup", width: 250, height: 5 * 28 + 14, props: { menu: { plan: { name: plan.name, title: plan.title } } } });
  },

  planMenuItems(m) {
    const plan = m.plan, abs = `${plansDir()}/${plan.name}`;
    return [
      { id: "open", icon: "eye", label: "Open", run: () => openPlan(plan) },
      { id: "edit", icon: "pencil", label: "Edit", run: () => openPlan(plan, true) },
      { id: "reveal", icon: "folder", label: "Reveal in Finder", run: () => exec("open", ["-R", "--", abs]).catch(() => {}) },
      { id: "abs", icon: "copy", label: "Copy Path", run: (cx) => cx.write_to_clipboard(abs) },
      { id: "delete", icon: "trash", label: "Delete…", run: () => this.askDeletePlan(plan, abs) },
    ];
  },

  askDeletePlan(plan, abs) {
    askConfirm(MOD, {
      title: `Delete the plan "${plan.title}"?`, detail: `${plan.name} goes to the Trash.`, label: "Move to Trash", danger: true,
      action: { cmd: "trash", args: [abs], doing: "Deleting the plan", done: "Plan moved to the Trash" },
    });
  },

  renderPlans() {
    const t = theme();
    const open = sectionOpen(this.section);
    const list = this.plans ?? [];
    const root = v_flex().id("vx-plans").size_full().bg(t.chrome).text_color(t.foreground).overflow_hidden()
      .child(SectionHead(t, { block: this.section, title: "Claude Plans", open, count: list.length || null,
        right: [IconButton({ id: "pl-refresh", icon: "refresh", label: "Refresh", size: 18, spinning: this.plansBusy, onClick: (cx) => this.loadPlans(cx, false) })] }));
    if (!open) return root;
    if (!this.plans) return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child("Loading…"));
    if (!list.length) return root.child(div().px(20).py(6).text_size(TEXT.small).text_color(t.dim).child("No plans yet. Claude writes one in plan mode."));
    const space = spaces().find((s) => s.active);
    const shown = space ? viewerValue(MOD, space.id) : null;
    const now = Date.now();
    return root.child(v_flex().id("pl-rows").flex_1().min_h(0).overflow_y_scrollbar()
      .children(list.map((plan) => {
        const sel = shown?.root === plansDir() && shown.rel === plan.name;
        return h_flex().id(`pl-${plan.name}`).h(22).flex_none().pl(20).pr(8).gap(6).items_center().cursor_pointer()
          .bg(sel ? t.selected : "#00000000").when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
          .tooltip(`${plan.title}\n${plansDir()}/${plan.name}`)
          .drag_paths([`${plansDir()}/${plan.name}`])
          .on_click(() => openPlan(plan))
          .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openPlanMenu(plan); })
          .child(FileIcon(this.icons, plan.name, { size: 13 }))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.small).child(plan.title))
          .when(isLive(plan, now), (el) => el.child(div().size(6).flex_none().rounded(3).bg(t.accent)))
          .child(div().flex_none().text_size(TEXT.caption).text_color(t.dim).child(timeAgo(plan.at, now)));
      })));
  },
};
