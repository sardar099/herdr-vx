// A stable colour per repo (or any name): the same name always gets the same palette slot.
export const PALETTE = ["ansi4", "ansi2", "ansi5", "ansi3", "ansi6", "ansi1", "ansi12", "ansi10", "ansi13", "ansi14"];

export function hashName(name) {
  let h = 2166136261;
  for (const ch of String(name ?? "")) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export const colorSlot = (name) => PALETTE[hashName(name) % PALETTE.length];
