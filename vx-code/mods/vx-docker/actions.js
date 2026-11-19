// Things that change something (git push, CI retry, a commit) never run on one click: the mod
// opens itself as a dialog with props { confirm: spec }, the dialog shows what will run, and
// runs it itself before closing (closing a copy first could drop the exec in flight).
//   spec = { title, detail, label, danger, action: { cmd, args, cwd, on, timeout, doing, done, root } }
//   action.steps = [{ cmd, args, cwd? }] runs several commands in order, stopping at the first
//   that fails (e.g. git pull --rebase, then git push).
import { openOverlay, closeOverlay, exec, notify, props } from "herdr";
import { bump } from "./ws.js";

export function askConfirm(mod, spec) {
  const extra = Math.max(0, (spec.action.steps?.length ?? 1) - 1) * 26;
  openOverlay({ mod, kind: "dialog", width: 440, height: (spec.detail ? 196 : 150) + extra, props: { confirm: spec } });
}

export async function runAction(a) {
  let r = null;
  for (const s of a.steps ?? [a]) {
    r = await exec(s.cmd, s.args, { cwd: s.cwd ?? a.cwd, on: a.on ?? null, timeout: a.timeout ?? 120000 }).catch((e) => ({
      code: -1, stdout: "", stderr: String(e?.message ?? e),
    }));
    if (r.code !== 0) break;
  }
  const text = (r.stderr || r.stdout || "").trim();
  if (r.code === 0) notify({ title: a.done ?? "Done", body: text.split("\n").pop() || undefined, level: "success", timeout: 3000 });
  else notify({ title: `${a.doing ?? "It"} failed`, body: text.slice(-600) || `exit ${r.code}`, level: "error", timeout: 8000 });
  if (a.root !== undefined) bump(a.root);
  return r;
}

// The dialog's own behaviour, for a mod whose copy was opened with props().confirm.
export const confirmMethods = {
  isConfirm() {
    return Boolean(this.confirmSpec);
  },
  async confirmYes(cx) {
    if (this.confirmBusy) return;
    this.confirmBusy = true;
    cx.notify();
    try {
      await runAction(this.confirmSpec.action);
    } finally {
      closeOverlay(props()?.overlay ?? this.confirmOverlay);
    }
  },
  confirmNo() {
    closeOverlay(props()?.overlay ?? this.confirmOverlay);
  },
};
