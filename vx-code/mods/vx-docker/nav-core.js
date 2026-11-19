// Back / forward through the tabs you visited (the title bar's ← →), as pure functions.
// A history is { list: [tab ids], at }: visiting a tab drops anything after `at` (like a
// browser), moves the tab to the end, and caps the list.

export const NAV_MAX = 50;
export const emptyNav = () => ({ list: [], at: -1 });

export function navVisit(h, tab) {
  if (h.list[h.at] === tab) return h;
  const list = [...h.list.slice(0, h.at + 1).filter((x) => x !== tab), tab].slice(-NAV_MAX);
  return { list, at: list.length - 1 };
}

// The next place `step` (-1 back, +1 forward) away whose tab still exists, or null.
export function navStep(h, step, live) {
  let at = h.at + step;
  while (at >= 0 && at < h.list.length && !live.has(h.list[at])) at += step;
  return at >= 0 && at < h.list.length ? { list: h.list, at } : null;
}
