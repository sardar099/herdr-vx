// vx-http: a Postman-like HTTP client.
//   side     props {}                         the side bar: collections, environments, history (side.js)
//   request  props { open } | { request }     a request tab: edit, send, see the response (request.js, response.js)
//   env      props { envEdit }                an environment's variables (env.js)
//   popups   props { select | menu | dialog } (http-ui.js)
//   repo     props { repoMenu }               the repo switcher's list (repo-picker.js)
// Requests go out through curl (headers, timing and redirects as curl reports them). Collections
// and environments live in the repo (.vx/http); secrets, history and captured values don't.
import { View } from "gpui-kit";
import { props, checking, nextCommand } from "herdr";
import { loadState } from "./store.js";
import { kvMethods } from "./kv.js";
import { popupMethods } from "./http-ui.js";
import { requestMethods } from "./request.js";
import { responseMethods } from "./response.js";
import { sideMethods } from "./side.js";
import { envMethods } from "./env.js";
import { RepoMenu } from "./repo-picker.js";
import { loadIcons } from "./icons.js";
import { theme } from "herdr";
import { v_flex, h_flex } from "gpui-base";
import { Message, TEXT } from "./ui.js";

class VxHttp extends View {
  init(given, cx) {
    const p = props() ?? given ?? {};
    if (p.repoMenu) {
      this.repoMenu = p.repoMenu;
      loadIcons(this, cx);
      return;
    }
    if (p.select || p.menu || p.dialog) return this.initPopup(p);
    if (!checking()) loadState().catch(() => {});
    if (p.envEdit) return this.initEnv(p, cx);
    if (p.open || p.request || p.repo) {
      this.initRequest(p, cx);
      cx.spawn(async (cx) => {
        for (;;) {
          const c = await nextCommand();
          if (c === "send") this.send(cx);
          if (c === "save") this.save(cx);
          cx.notify();
        }
      });
      return;
    }
    loadIcons(this, cx);
    this.initSide(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "new") this.postSide({ cmd: "newScratch" });
        if (c === "import") this.importMenu();
        if (c === "refresh") this.reload(cx);
        cx.notify();
      }
    });
  }

  render() {
    if (this.repoMenu) return RepoMenu(this);
    if (this.popup) return this.renderPopup();
    if (this.mode === "env") return this.renderEnv();
    if (this.mode === "request") {
      const t = theme();
      if (!this.req) return v_flex().size_full().bg(t.background).child(Message(this.loadError ?? "Loading…", Boolean(this.loadError)));
      return v_flex().id("vx-http-req").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(TEXT.body)
        .on_key_down((e, cx) => {
          const cmd = e.modifiers?.platform;
          if (cmd && e.key === "enter") { cx.stop_propagation(); this.send(cx); }
          if (cmd && e.key === "s") { cx.stop_propagation(); this.save(cx); }
        })
        .child(this.renderRequestBar(t))
        // Thunder Client's split: the request on the left, the response on the right.
        .child(h_flex().flex_1().min_h(0).items_start()
          .child(v_flex().flex_1().h_full().min_w(0).min_h(0)
            .child(this.renderTabs(t))
            .child(v_flex().id("rq-body").flex_1().min_h(0).overflow_y_scrollbar().child(this.renderTabBody(t))))
          .child(this.renderResponse(t)));
    }
    if (this.mode === "side") return this.renderSide();
    return Message("");
  }
}

Object.assign(VxHttp.prototype, kvMethods, popupMethods, requestMethods, responseMethods, sideMethods, envMethods);
export default VxHttp;
