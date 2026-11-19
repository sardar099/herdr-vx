// Running a program where you can watch it:
//   runInPanel(argv, opts)  a terminal in the vx-code bottom panel (vx-panel adopts terminals
//                           labelled vx.panel=1 and shows the one named in shared "vx.panel")
//   runInTab(argv, opts)    a new tab in the active space
// argv is an argument list, never a shell string.
import { hc, run, notify, shared, setShared, spaces, home } from "herdr";

export async function runInPanel(argv, { cwd, on = null } = {}) {
  const args = ["run", "--bg", "--json", "--keep", "--no-parent", "--outlive-parent", "--no-notify", "--label", "vx.panel=1", "--cwd", cwd ?? home()];
  if (on) args.push("--on", on);
  args.push("--", ...argv);
  const r = await hc(args).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
  let address = null;
  try {
    address = r.code === 0 ? JSON.parse(r.stdout).address ?? null : null;
  } catch {}
  if (!address) {
    notify({ title: `Couldn't run ${argv[0]}`, body: (r.stderr || r.stdout || "").trim().slice(-400), level: "error", timeout: 6000 });
    return null;
  }
  const s = { view: "terminal", shown: null, list: [], ...(shared("vx.panel") ?? {}) };
  setShared("vx.panel", { ...s, view: "terminal", shown: address, list: [...s.list.filter((a) => a !== address), address] });
  run("layout.show", { id: "bottom" });
  return address;
}

export function runInTab(argv, { cwd, name } = {}) {
  const space = spaces().find((s) => s.active);
  run("tab.new", { name: name ?? argv.join(" ").slice(0, 40), folder: cwd ?? home(), argv, ...(space ? { space: space.id } : {}) });
}
