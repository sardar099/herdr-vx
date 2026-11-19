// JSON with comments and trailing commas (VS Code's .code-workspace, settings.json).
// Pure: no Herdr calls, so tests run it under node.

// Drops // and /* */ comments outside strings, then commas that close an object or array.
export function stripJsonc(text) {
  const src = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // A comma followed only by whitespace before } or ] (strings are already passed through
  // whole above, but this runs on the joined text, so skip over strings again).
  let clean = "";
  for (let k = 0; k < out.length; k++) {
    const c = out[k];
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
      clean += out.slice(k, j + 1);
      k = j;
      continue;
    }
    if (c === ",") {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === "}" || out[j] === "]") continue;
    }
    clean += c;
  }
  return clean;
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text));
}
