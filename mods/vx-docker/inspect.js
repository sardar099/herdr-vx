// vx-docker's centre tab and dialog:
//   inspect   props { inspect: { kind, ref, name } }  `docker <kind> inspect` as highlighted JSON
//   runImage  props { runImage: { ref } }             Run Image: name, ports, env, command; run in
//                                                     the background (-d) or interactively in a tab
import { div } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, EditorState, Editor } from "gpui-base";
import { theme, exec, closeOverlay, props, setShared } from "herdr";
import { runArgs } from "./docker-core.js";
import { syntaxColors } from "./syntax-core.js";
import { TEXT, Icon, IconButton, Button, Message, codeFont, codeSize } from "./ui.js";

const post = (cmd) => setShared("vx.docker.cmd", { ...cmd, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
const INSPECT = { container: ["container", "inspect"], image: ["image", "inspect"], volume: ["volume", "inspect"], network: ["network", "inspect"] };

export const inspectMethods = {
  initInspect(p, cx) {
    this.inspect = p.inspect;
    this.inspectState = null;
    this.inspectError = null;
    this.loadInspect(cx);
  },

  loadInspect(cx) {
    const i = this.inspect;
    cx.spawn(async (cx) => {
      const r = await exec("docker", [...(INSPECT[i.kind] ?? ["inspect"]), i.ref], { timeout: 20000 }).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
      if (r.code !== 0) {
        this.inspectError = (r.stderr || "docker inspect failed").trim();
        return cx.notify();
      }
      let text = r.stdout;
      try {
        const v = JSON.parse(r.stdout);
        text = JSON.stringify(Array.isArray(v) && v.length === 1 ? v[0] : v, null, 2);
      } catch {}
      this.inspectText = text;
      this.inspectError = null;
      this.inspectState?.release?.();
      const C = syntaxColors(theme());
      this.inspectState = EditorState.new({ language: "json", readonly: true, value: text, font_family: codeFont(), font_size: Math.max(11, codeSize() - 1),
        syntax: { keyword: C.keyword, string: C.string, comment: C.comment, function: C.fn, type: C.type, number: C.number, constant: C.constant } });
      cx.notify();
    });
  },

  renderInspect() {
    const t = theme();
    const i = this.inspect;
    const head = h_flex().h(32).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border).text_size(TEXT.small)
      .child(Icon({ container: "container", image: "box", volume: "database", network: "network" }[i.kind] ?? "eye", 14).text_color(t.accent))
      .child(div().font_medium().max_w(420).truncate().child(i.name))
      .child(div().flex_1().text_color(t.dim).child(`${i.kind} · docker inspect`))
      .when(i.kind === "container", (el) => el
        .child(IconButton({ id: "in-logs", icon: "list", label: "Logs (follow, in the panel)", size: 22, onClick: () => post({ cmd: "logs", container: i.ref }) }))
        .child(IconButton({ id: "in-shell", icon: "terminal", label: "Shell (in a tab)", size: 22, onClick: () => post({ cmd: "shell", container: i.ref }) })))
      .child(IconButton({ id: "in-copy", icon: "copy", label: "Copy JSON", size: 22, onClick: (cx) => this.inspectText && cx.write_to_clipboard(this.inspectText) }))
      .child(IconButton({ id: "in-refresh", icon: "refresh", label: "Refresh", size: 22, onClick: (cx) => this.loadInspect(cx) }));
    const root = v_flex().id("dk-inspect").size_full().min_h(0).bg(t.background).text_color(t.foreground).child(head);
    if (this.inspectError) return root.child(Message(this.inspectError, true));
    if (!this.inspectState) return root.child(Message("Loading…"));
    return root.child(div().flex_1().min_h(0).font_family(codeFont()).child(Editor.new(this.inspectState).size_full()));
  },

  initRunDialog(p, cx) {
    this.runDialog = p.runImage;
    this.runOverlay = p.overlay;
    this.runName = InputState.new({ placeholder: "optional" });
    this.runPorts = InputState.new({ placeholder: "8080:80, 5432:5432" });
    this.runEnv = InputState.new({ placeholder: "KEY=value, OTHER=x" });
    this.runCmd = InputState.new({ placeholder: "optional, e.g. sh -c 'echo hi'" });
    this.runPorts.focus();
  },

  submitRun(detached) {
    const image = this.runDialog.ref;
    const args = runArgs({ image, name: this.runName.value(), ports: this.runPorts.value(), env: this.runEnv.value(), command: this.runCmd.value(), detached });
    post({ cmd: "run", args, detached, image });
    closeOverlay(props()?.overlay ?? this.runOverlay);
  },

  renderRunDialog() {
    const t = theme();
    const field = (label, state) => v_flex().gap(4)
      .child(div().text_size(TEXT.caption).text_color(t.muted).child(label))
      .child(h_flex().h(28).px(8).items_center().rounded(6).bg(t.background).border_1().border_color(t.input ?? t.border)
        .child(Input.new(state).flex_1().h_full().text_size(TEXT.small)));
    return v_flex().id("dk-run").size_full().p(16).gap(10).bg(t.popover ?? t.surface).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); closeOverlay(props()?.overlay ?? this.runOverlay); }
        if (e.key === "enter") { cx.stop_propagation(); this.submitRun(true); }
      })
      .child(h_flex().gap(8).items_center().child(Icon("box", 15).text_color(t.accent)).child(div().text_size(TEXT.title).font_semibold().truncate().child(`Run ${this.runDialog.ref}`)))
      .child(field("Ports (host:container)", this.runPorts))
      .child(field("Environment", this.runEnv))
      .child(h_flex().gap(10).child(div().flex_1().child(field("Container name", this.runName))).child(div().flex_1().child(field("Command", this.runCmd))))
      .child(div().flex_1())
      .child(h_flex().gap(8).justify_end()
        .child(Button({ id: "run-cancel", label: "Cancel", onClick: () => closeOverlay(props()?.overlay ?? this.runOverlay) }))
        .child(Button({ id: "run-it", label: "Run interactive", icon: "terminal", onClick: () => this.submitRun(false) }))
        .child(Button({ id: "run-d", label: "Run in background", icon: "play", primary: true, onClick: () => this.submitRun(true) })));
  },
};
