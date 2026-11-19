// A small lexer for colouring code rows: comments, strings, numbers, keywords, types, calls.
// No grammar; block comments and multi-line strings carry from one line to the next.
// Pure: tested under node. kinds: comment string number keyword type fn constant key tag

const W = (s) => new Set(s.split(" "));
const KW = {
  js: W("abstract as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface is keyof let namespace new of private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield"),
  py: W("and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return self try while with yield"),
  go: W("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
  rs: W("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while"),
  sh: W("case do done elif else esac exit export fi for function if in local readonly return select then until while"),
  c: W("auto break case char class const continue default delete do double else enum extern final float for friend fun func goto if import inline int interface let long namespace new override package private protected public return short signed sizeof static struct switch template this throw try typedef union unsigned using val var virtual void volatile while"),
  sql: W("select from where and or not null insert into values update set delete create table alter drop index join left right inner outer on as group by order having limit offset union distinct case when then else end returning primary key references default"),
  docker: W("FROM RUN CMD LABEL EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL HEALTHCHECK SHELL AS"),
  none: new Set(),
};
const CONST = W("true false null undefined nil None True False NaN Infinity");
const SPEC = {
  js: { line: "//", block: ["/*", "*/"], tpl: "`", kw: KW.js },
  py: { line: "#", triple: true, kw: KW.py },
  go: { line: "//", block: ["/*", "*/"], tpl: "`", kw: KW.go },
  rs: { line: "//", block: ["/*", "*/"], kw: KW.rs },
  c: { line: "//", block: ["/*", "*/"], kw: KW.c },
  sh: { line: "#", kw: KW.sh, wordComment: true },
  sql: { line: "--", block: ["/*", "*/"], kw: KW.sql, anyCase: true },
  css: { block: ["/*", "*/"], kw: KW.none, keys: true },
  json: { kw: KW.none, keys: true, data: true },
  yaml: { line: "#", kw: KW.none, keys: true, data: true },
  toml: { line: "#", kw: KW.none, keys: true, data: true },
  html: { block: ["<!--", "-->"], kw: KW.none, markup: true },
  docker: { line: "#", kw: KW.docker },
  md: { md: true },
  txt: { plain: true },
};
const EXT = {
  js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", vue: "js", svelte: "js",
  py: "py", go: "go", rs: "rs", sh: "sh", bash: "sh", zsh: "sh", fish: "sh", env: "sh",
  c: "c", h: "c", cc: "c", cpp: "c", hpp: "c", java: "c", kt: "c", kts: "c", swift: "c", cs: "c", php: "c", dart: "c", scala: "c", m: "c",
  sql: "sql", css: "css", scss: "css", less: "css", json: "json", jsonc: "json", json5: "json",
  yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", conf: "toml",
  html: "html", htm: "html", xml: "html", svg: "html", md: "md", markdown: "md",
  txt: "txt", log: "txt", csv: "txt", lock: "txt",
};
const NAMES = { dockerfile: "docker", makefile: "sh", ".env": "sh", ".gitignore": "sh", ".dockerignore": "sh", "jenkinsfile": "c", ".gitlab-ci.yml": "yaml" };

export function languageOf(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  if (NAMES[name]) return NAMES[name];
  if (name.startsWith(".env")) return "sh";
  if (name.startsWith("dockerfile")) return "docker";
  const ext = name.includes(".") ? name.split(".").pop() : "";
  return EXT[ext] ?? "txt";
}

const closeAt = (line, from, quote) => {
  for (let i = from; i < line.length; i++) {
    if (line[i] === "\\") i++;
    else if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
};

// One line -> { runs: [{text, kind}], state } ; state carries an open comment or string.
export function lexLine(line, lang, state = null) {
  const spec = SPEC[lang] ?? SPEC.txt;
  if (spec.plain || line.length > 2000) return { runs: [{ text: line, kind: null }], state: spec.plain ? null : state };
  if (spec.md) {
    if (/^#{1,6}\s/.test(line)) return { runs: [{ text: line, kind: "keyword" }], state: null };
    if (/^\s*(```|~~~)/.test(line)) return { runs: [{ text: line, kind: "comment" }], state: null };
    return { runs: [{ text: line, kind: null }], state: null };
  }
  const runs = [];
  let i = 0;
  let plain = 0;
  const push = (end, kind) => {
    if (i > plain) runs.push({ text: line.slice(plain, i), kind: null });
    runs.push({ text: line.slice(i, end), kind });
    i = end;
    plain = end;
  };
  if (state) {
    const end = state.kind === "comment" ? line.indexOf(state.until) : closeAt(line, 0, state.until);
    if (end < 0) return { runs: [{ text: line, kind: state.kind }], state };
    push(state.kind === "comment" ? end + state.until.length : end, state.kind);
    state = null;
  }
  if (spec.keys && plain === 0) {
    const m = /^(\s*(?:-\s+)?)(["']?[\w.@/$-]+["']?)(?=\s*[:=](\s|$))/.exec(line);
    if (m) {
      i = m[1].length;
      push(i + m[2].length, "key");
    }
  }
  while (i < line.length) {
    const ch = line[i];
    const prev = line[i - 1] ?? "";
    if (spec.line && line.startsWith(spec.line, i) && !(spec.line === "//" && prev === ":") && (!spec.wordComment || i === 0 || /\s/.test(prev))) {
      push(line.length, "comment");
      break;
    }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      const end = line.indexOf(spec.block[1], i + spec.block[0].length);
      if (end < 0) {
        push(line.length, "comment");
        state = { kind: "comment", until: spec.block[1] };
        break;
      }
      push(end + spec.block[1].length, "comment");
      continue;
    }
    if (spec.triple && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      const q = line.slice(i, i + 3);
      const end = closeAt(line, i + 3, q);
      if (end < 0) {
        push(line.length, "string");
        state = { kind: "string", until: q };
        break;
      }
      push(end, "string");
      continue;
    }
    if (spec.tpl && ch === spec.tpl) {
      const end = closeAt(line, i + 1, ch);
      if (end < 0) {
        push(line.length, "string");
        state = { kind: "string", until: ch };
        break;
      }
      push(end, "string");
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = closeAt(line, i + 1, ch);
      if (end > 0) {
        const isKey = spec.keys && /^\s*:/.test(line.slice(end));
        push(end, isKey ? "key" : "string");
        continue;
      }
    }
    if (spec.markup && ch === "<" && /[A-Za-z/!]/.test(line[i + 1] ?? "")) {
      const m = /^<\/?[A-Za-z][\w.:-]*/.exec(line.slice(i));
      if (m) {
        push(i + m[0].length, "tag");
        continue;
      }
    }
    if (/\d/.test(ch) && !/[\w$]/.test(prev)) {
      const m = /^(0[xXbBoO][\da-fA-F_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/.exec(line.slice(i));
      push(i + m[0].length, "number");
      continue;
    }
    if ((/[A-Za-z_$]/.test(ch) || (ch === "@" && /[A-Za-z_]/.test(line[i + 1] ?? ""))) && !/[\w$]/.test(prev)) {
      const word = /^[@A-Za-z_$][\w$]*/.exec(line.slice(i))[0];
      const after = line.slice(i + word.length);
      let kind = null;
      if (spec.anyCase ? spec.kw.has(word.toLowerCase()) : spec.kw.has(word)) kind = "keyword";
      else if (CONST.has(word)) kind = "constant";
      else if (spec.data) kind = null;
      else if (word.startsWith("@")) kind = "fn";
      else if (/^\s*\(/.test(after)) kind = /^[A-Z]/.test(word) ? "type" : "fn";
      else if (/^[A-Z][a-z]\w*[a-z]\w*$/.test(word) || /^[A-Z][A-Za-z]+$/.test(word) && word.length > 2 && /[a-z]/.test(word)) kind = "type";
      else if (/^[A-Z][A-Z\d_]{2,}$/.test(word)) kind = "constant";
      if (kind) push(i + word.length, kind);
      else i += word.length;
      continue;
    }
    i++;
  }
  if (plain < line.length) runs.push({ text: line.slice(plain), kind: null });
  return { runs: runs.length ? runs : [{ text: "", kind: null }], state };
}

export function lexLines(lines, lang) {
  let state = null;
  return lines.map((l) => {
    const r = lexLine(l, lang, state);
    state = r.state;
    return r.runs;
  });
}

// The colour of each kind, from the theme.
export const syntaxColors = (t) => ({
  comment: t.dim, string: t.ansi2, number: t.ansi1, keyword: t.ansi5, type: t.ansi3,
  fn: t.ansi4, constant: t.ansi6, key: t.ansi1, tag: t.ansi1,
});
