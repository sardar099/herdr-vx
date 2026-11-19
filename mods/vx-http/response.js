// Sending a request (curl, files under ~/.local/state/vx-http) and the response half of the
// request tab (right half): status, size, time (hover it for the timing breakdown); Response
// (pretty JSON, text, images), Headers, Cookies and the test Results.
import { div, image } from "gpui-kit";
import { v_flex, h_flex, EditorState, Editor } from "gpui-base";
import { theme, exec, readTextFile, notify, home, appHome } from "herdr";
import {
  resolveRequest, curlArgs, bodyText, parseCurlInfo, parseHeaderBlocks, parseCookies, headerValue, isJsonType, statusText,
  runTests, runCaptures, formatBytes,
} from "./http-core.js";
import { addRuntime, addHistory } from "./store.js";
import { writeText } from "./ws.js";
import { syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, Message, codeFont, codeSize, tint } from "./ui.js";

const MAX_VIEW = 2_000_000;
const stamp = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const statusColor = (t, s) => (!s ? t.ansi1 : s < 300 ? t.ansi2 : s < 400 ? t.ansi4 : s < 500 ? t.ansi3 : t.ansi1);
const langOf = (ct) => (isJsonType(ct) ? "json" : /xml/i.test(ct ?? "") ? "xml" : /html/i.test(ct ?? "") ? "html" : /javascript/i.test(ct ?? "") ? "js" : /css/i.test(ct ?? "") ? "css" : undefined);

export const responseMethods = {
  send(cx) {
    if (!this.req || this.sending) return;
    let r;
    try {
      r = resolveRequest(this.req, this.vars());
    } catch (e) {
      return notify({ title: "Can't send", body: String(e.message ?? e), level: "error" });
    }
    if (!/^[a-z]+:\/\/[^/{}\s]+/i.test(r.url)) return notify({ title: "Enter a URL first", body: r.url || undefined, level: "warning" });
    const sendId = stamp();
    this.sendId = sendId;
    this.sending = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const dir = `${home()}/.local/state/vx-http`;
      const base = `${dir}/${this.owner}`;
      const files = { body: `${base}.req`, headers: `${base}.hdr`, out: `${base}.out` };
      try {
        await exec("mkdir", ["-p", dir]);
        await exec("rm", ["-f", files.headers, files.out]);
        const text = bodyText(r);
        if (text !== null) await writeText(files.body, text);
        const x = await exec("curl", curlArgs(r, files), { timeout: (Number(r.settings.timeout) + 10) * 1000 })
          .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
        if (this.sendId !== sendId) return;
        const info = parseCurlInfo(x.stdout);
        const hdr = parseHeaderBlocks((await readTextFile(files.headers).catch(() => null)) ?? "");
        let body = null;
        let binary = false;
        try {
          body = await readTextFile(files.out);
        } catch {
          binary = true;
        }
        if (body !== null && body.includes("\0")) {
          binary = true;
          body = null;
        }
        const ct = headerValue(hdr.headers, "content-type") ?? info.contentType;
        let json;
        if (body !== null && (isJsonType(ct) || /^\s*[[{]/.test(body))) {
          try {
            json = JSON.parse(body);
          } catch {}
        }
        const status = info.status || hdr.status;
        const resp = {
          status, reason: hdr.reason || statusText(status), headers: hdr.headers, chain: hdr.chain, cookies: parseCookies(hdr.headers),
          body, json, binary, contentType: ct, size: info.size ?? (body?.length ?? null), time: info.timing.total, timing: info.timing,
          httpVersion: info.httpVersion, url: info.url ?? r.url, redirects: info.redirects, remoteIp: info.remoteIp,
          error: x.code !== 0 ? info.error || (x.stderr || "").trim() || `curl exited ${x.code}` : null, bodyFile: files.out, at: Date.now(),
        };
        resp.tests = status ? runTests(this.req.tests, resp) : [];
        resp.captured = status ? runCaptures(this.req.captures, resp) : {};
        if (this.repo) addRuntime(this.repo, resp.captured);
        this.resp = resp;
            await this.showBody(resp, cx);
        if (resp.tests.some((t) => !t.pass)) this.respTab = "tests";
        addHistory({ at: resp.at, repo: this.repo, name: this.req.name, method: r.method, url: r.url, status, time: resp.time, request: JSON.parse(JSON.stringify(this.req)), ref: this.ref ?? null }).catch(() => {});
      } catch (e) {
        if (this.sendId === sendId) this.resp = { error: String(e?.message ?? e), status: 0, headers: [], tests: [], cookies: [], timing: {} };
      } finally {
        if (this.sendId === sendId) {
          this.sending = false;
          this.sendId = null;
        }
        cx.notify();
      }
    });
  },

  // The body view: pretty JSON or the text in a read-only editor; images through a copy in this
  // mod's folder (image() only loads from Herdr's folder).
  async showBody(resp) {
    this.respEditor?.release?.();
    this.respEditor = null;
    this.respImage = null;
    if (/^image\//i.test(resp.contentType ?? "")) {
      const ext = (resp.contentType.split("/")[1] ?? "png").split(/[;+]/)[0];
      const rel = `mods/vx-http/cache/${this.owner}-${resp.at}.${ext}`;
      const c = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && cp -- "$1" "$2"', "vx-http", resp.bodyFile, `${appHome()}/${rel}`]).catch(() => null);
      if (c?.code === 0) this.respImage = rel;
      return;
    }
    if (resp.body === null || resp.body === undefined) return;
    const text = this.respRaw || resp.json === undefined ? resp.body : JSON.stringify(resp.json, null, 2);
    this.setRespText(text.length > MAX_VIEW ? `${text.slice(0, MAX_VIEW)}\n… (showing the first ${formatBytes(MAX_VIEW)})` : text, resp.json !== undefined && !this.respRaw ? "json" : langOf(resp.contentType));
  },

  setRespText(text, language) {
    const C = syntaxColors(theme());
    this.respEditor?.release?.();
    this.respEditor = EditorState.new({ language, value: text, readonly: true, font_family: codeFont(), font_size: Math.max(11, codeSize() - 1), soft_wrap: true,
      syntax: { keyword: C.keyword, string: C.string, comment: C.comment, function: C.fn, type: C.type, number: C.number, constant: C.constant } });
  },

  timingTip(resp) {
    const tm = resp.timing ?? {};
    const row = (label, ms) => `${label.padEnd(14)} ${ms === null || ms === undefined ? "—" : `${ms} ms`}`;
    return [row("DNS lookup", tm.dns), row("TCP connect", tm.connect), row("TLS handshake", tm.tls), row("Waiting (TTFB)", tm.wait), row("Download", tm.download), row("Total", tm.total)]
      .concat(resp.remoteIp ? [`Remote ${resp.remoteIp}`] : []).concat(resp.redirects ? [`${resp.redirects} redirect(s)`] : []).join("\n");
  },

  saveBody(cx) {
    const resp = this.resp;
    if (!resp?.bodyFile) return;
    const ext = langOf(resp.contentType) ?? (/^image\//.test(resp.contentType ?? "") ? resp.contentType.split("/")[1].split(";")[0] : "txt");
    const name = `${(this.req?.name || "response").replace(/[^\w.-]+/g, "-")}-${new Date(resp.at).toISOString().slice(0, 19).replace(/[:T]/g, "")}.${ext}`;
    cx.spawn(async () => {
      const dest = `${home()}/Downloads/${name}`;
      const r = await exec("cp", ["--", resp.bodyFile, dest]).catch(() => ({ code: 1 }));
      if (r.code === 0) {
        notify({ title: "Saved the response", body: dest, level: "success", timeout: 4000 });
        exec("open", ["-R", dest]).catch(() => {});
      } else notify({ title: "Couldn't save the response", level: "error" });
    });
  },

  renderResponse(t) {
    const resp = this.resp;
    const root = v_flex().flex_1().h_full().min_w(0).min_h(0).border_l(1).border_color(t.border);
    if (this.sending) return root.child(h_flex().p(16).gap(8).items_center().text_color(t.muted).child(Icon("spinner", 14).spin(900)).child("Sending…"));
    if (!resp) return root.child(v_flex().flex_1().items_center().justify_center().gap(6).text_color(t.dim).text_size(TEXT.small).child(Icon("globe", 28).opacity(0.6)).child("Send the request to see the response.").child(div().text_size(TEXT.caption).child("⌘Enter sends · ⌘S saves")));
    const passed = (resp.tests ?? []).filter((x) => x.pass).length;
    const total = (resp.tests ?? []).length;
    const head = h_flex().h(34).flex_none().px(10).gap(10).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .when(Boolean(resp.status), (el) => el.child(div().px(8).h(22).flex().items_center().rounded(5).bg(tint(statusColor(t, resp.status), "30")).text_color(statusColor(t, resp.status)).font_semibold().child(`${resp.status} ${resp.reason ?? ""}`.trim())))
      .when(!resp.status, (el) => el.child(div().text_color(t.ansi1).font_medium().child("No response")))
      .when(resp.time !== null && resp.time !== undefined, (el) => el.child(div().id("rs-time").text_color(t.muted).tooltip(this.timingTip(resp)).child(`${resp.time} ms`)))
      .when(resp.size !== null && resp.size !== undefined, (el) => el.child(div().text_color(t.muted).child(formatBytes(resp.size))))
      .when(Boolean(resp.httpVersion), (el) => el.child(div().text_color(t.dim).child(`HTTP/${resp.httpVersion}`)))
      .when(total > 0, (el) => el.child(div().text_color(passed === total ? t.ansi2 : t.ansi1).child(`Tests ${passed}/${total}`)))
      .when(Object.keys(resp.captured ?? {}).length > 0, (el) => el.child(div().text_color(t.ansi6).tooltip(Object.entries(resp.captured).map(([k, v]) => `${k} = ${String(v).slice(0, 60)}`).join("\n")).child(`captured ${Object.keys(resp.captured).join(", ")}`)))
      .child(div().flex_1())
      .child(IconButton({ id: "rs-copy", icon: "copy", label: "Copy the body", size: 22, onClick: (cx) => resp.body && cx.write_to_clipboard(resp.body) }))
      .child(IconButton({ id: "rs-save", icon: "download", label: "Save the body to Downloads", size: 22, onClick: (cx) => this.saveBody(cx) }));
    root.child(head);
    if (resp.error) root.child(h_flex().px(10).py(6).gap(8).items_center().bg(tint(t.ansi1, "1a")).text_size(TEXT.small).text_color(t.ansi1).child(Icon("alert", 13)).child(div().flex_1().min_w(0).whitespace_normal().child(resp.error)));
    if (!resp.status) return root;
    const tabs = [["body", "Response"], ["headers", `Headers ${resp.headers.length}`], ["cookies", `Cookies ${resp.cookies.length}`], ["tests", total ? `Results ${passed}/${total}` : "Results"]];
    root.child(h_flex().h(30).flex_none().px(8).gap(2).items_center().border_b(1).border_color(t.border)
      .children(tabs.map(([id, label]) => h_flex().id(`rp-${id}`).h(30).px(8).items_center().cursor_pointer().text_size(TEXT.small)
        .border_b(2).border_color(this.respTab === id ? t.accent : "#00000000").text_color(this.respTab === id ? t.foreground : t.muted)
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { this.respTab = id; cx.notify(); }).child(label))));
    if (this.respTab === "body") {
      if (this.respImage) return root.child(h_flex().flex_1().min_h(0).p(16).justify_center().items_center().child(image(this.respImage).max_w_full().max_h_full()));
      if (resp.binary) return root.child(Message(`Binary response (${resp.contentType ?? "unknown type"}, ${formatBytes(resp.size)}). Save it to look inside.`));
      if (!this.respEditor) return root.child(Message(resp.body === "" ? "Empty body." : "Nothing to show."));
      return root.child(div().flex_1().min_h(0).font_family(codeFont()).child(Editor.new(this.respEditor).size_full()));
    }
    if (this.respTab === "headers") {
      return root.child(v_flex().id("rs-headers").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6)
        .when(resp.chain?.length > 1, (el) => el.child(div().pb(6).text_size(TEXT.caption).text_color(t.dim).child(`Redirects: ${resp.chain.join(" → ")}`)))
        .children(resp.headers.map((h, i) => h_flex().id(`rh-${i}`).py(3).gap(10).items_start().text_size(TEXT.small).border_b(1).border_color(t.border)
          .child(div().w(220).flex_none().truncate().font_medium().text_color(t.ansi4).child(h.key))
          .child(div().flex_1().min_w(0).whitespace_normal().text_color(t.foreground).font_family(codeFont()).child(h.value)))));
    }
    if (this.respTab === "cookies") {
      if (!resp.cookies.length) return root.child(Message("No cookies were set."));
      return root.child(v_flex().id("rs-cookies").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6)
        .children(resp.cookies.map((c, i) => v_flex().id(`rc-${i}`).py(4).gap(2).border_b(1).border_color(t.border).text_size(TEXT.small)
          .child(h_flex().gap(8).child(div().font_medium().text_color(t.ansi4).child(c.name)).child(div().flex_1().min_w(0).truncate().font_family(codeFont()).child(c.value)))
          .child(div().text_size(TEXT.caption).text_color(t.dim).child(["domain", "path", "expires", "max-age", "samesite"].filter((k) => c[k] && c[k] !== true).map((k) => `${k}=${c[k]}`).concat(["secure", "httponly"].filter((k) => c[k] === true)).join(" · "))))));
    }
    if (this.respTab === "tests") {
      if (!total) return root.child(Message("No tests. Add them in the request's Tests tab: status == 200, $.data.id exists, time < 500…"));
      return root.child(v_flex().id("rs-tests").flex_1().min_h(0).overflow_y_scrollbar().px(10).py(6)
        .children(resp.tests.map((x, i) => h_flex().id(`rt-${i}`).py(4).gap(8).items_center().text_size(TEXT.small).border_b(1).border_color(t.border)
          .child(Icon(x.pass ? "check" : "x", 13).text_color(x.pass ? t.ansi2 : t.ansi1))
          .child(div().flex_1().min_w(0).truncate().font_family(codeFont()).child(x.label))
          .when(!x.pass, (el) => el.child(div().max_w(320).truncate().text_color(t.ansi1).child(x.message))))));
    }
    return root;
  },
};
