// Commit-graph lanes, like `git log --graph`, as data a view can draw row by row. Pure.
// Input: commits newest first, each { hash, parents: [hash...] }.
// Output per row: { col, top: [cols with a line coming down into this row],
//   bottom: [cols with a line going on below], span: [min, max] of the horizontal joint
//   at this row's middle (a merge or a branch point), width }.

export const GRAPH_FORMAT = "--format=%H%x00%P%x00%D%x00%an%x00%at%x00%s%x1e";

export function parseGraphLog(stdout) {
  return String(stdout ?? "")
    .split("\x1e")
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.includes("\0"))
    .map((r) => {
      const [hash, parents, refs, author, at, subject] = r.split("\0");
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: refs ? refs.split(", ").map((s) => s.trim()).filter(Boolean) : [],
        author,
        at: Number(at),
        subject,
      };
    });
}

// "HEAD -> main", "origin/main", "tag: v1" -> labels with a kind for colouring.
export function refLabels(refs) {
  const out = [];
  for (const r of refs) {
    if (r.startsWith("HEAD -> ")) out.push({ kind: "head", name: r.slice(8) });
    else if (r === "HEAD") out.push({ kind: "head", name: "HEAD" });
    else if (r.startsWith("tag: ")) out.push({ kind: "tag", name: r.slice(5) });
    else if (r.includes("/") && !r.startsWith("refs/")) out.push({ kind: "remote", name: r });
    else out.push({ kind: "branch", name: r });
  }
  return out;
}

export function layoutGraph(commits) {
  const lanes = []; // the commit each column is waiting for
  const rows = [];
  let width = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    if (i >= 0) return i;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const c of commits) {
    let col = lanes.indexOf(c.hash);
    const top = lanes.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    if (col < 0) col = free(); // a branch tip nobody pointed at yet
    // Other columns waiting for this same commit join it here.
    const joined = [];
    lanes.forEach((h, i) => {
      if (h === c.hash && i !== col) {
        joined.push(i);
        lanes[i] = null;
      }
    });
    lanes[col] = c.parents[0] ?? null;
    const forks = [];
    for (const p of c.parents.slice(1)) {
      let at = lanes.indexOf(p);
      if (at < 0) {
        at = free();
        lanes[at] = p;
      }
      forks.push(at);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const bottom = lanes.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    const linked = [col, ...joined, ...forks];
    const span = [Math.min(...linked), Math.max(...linked)];
    width = Math.max(width, col + 1, ...top.map((i) => i + 1), ...bottom.map((i) => i + 1));
    rows.push({ col, top, bottom, span, joined, forks });
  }
  return { rows, width };
}
