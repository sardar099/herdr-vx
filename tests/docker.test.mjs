import { test } from "node:test";
import assert from "node:assert/strict";
import {
  jsonLines, parseLabels, parsePorts, portLabel, toContainer, stateFromStatus, groupContainers, composeArgs,
  toImage, sortImages, parseStats, daemonDown, matchesFilter, runArgs, splitWords, isRunning,
} from "../shared/docker-core.js";

const ps = (o) => JSON.stringify({ ID: "abc123", Names: "web", Image: "nginx:alpine", State: "running", Status: "Up 2 hours", Ports: "", Labels: "", ...o });

test("jsonLines: skips junk and broken lines", () => {
  assert.deepEqual(jsonLines('{"a":1}\nWARNING: x\n{bad\n {"b":2} \n'), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(jsonLines(undefined), []);
});

test("parseLabels: values may contain =", () => {
  assert.deepEqual(parseLabels("a=1,b=x=y,c="), { a: "1", b: "x=y", c: "" });
  assert.deepEqual(parseLabels(""), {});
});

test("parsePorts: IPv4 and IPv6 merge, exposed-only ports kept once", () => {
  const p = parsePorts("0.0.0.0:8080->80/tcp, :::8080->80/tcp, 443/tcp, 80/tcp, 127.0.0.1:5432->5432/tcp");
  assert.deepEqual(p.map(portLabel), ["8080→80", "5432→5432", "443/tcp"]);
  assert.equal(p[1].host, "127.0.0.1");
  assert.equal(p[0].host, "0.0.0.0");
  assert.deepEqual(parsePorts(""), []);
});

test("toContainer: compose labels and first name", () => {
  const c = toContainer(JSON.parse(ps({ Names: "app-web-1,alias", Labels: "com.docker.compose.project=app,com.docker.compose.service=web,com.docker.compose.project.working_dir=/src/app,com.docker.compose.project.config_files=/src/app/compose.yml,/src/app/compose.override.yml" })));
  assert.equal(c.name, "app-web-1");
  assert.equal(c.project, "app");
  assert.equal(c.service, "web");
  assert.equal(c.workdir, "/src/app");
  // config_files is comma-separated, which the label parser splits; the first file survives.
  assert.equal(c.configFiles[0], "/src/app/compose.yml");
});

test("stateFromStatus: older engines without State", () => {
  assert.equal(stateFromStatus("Up 3 minutes (Paused)"), "paused");
  assert.equal(stateFromStatus("Up 3 minutes"), "running");
  assert.equal(stateFromStatus("Exited (137) 2 days ago"), "exited");
  assert.equal(stateFromStatus("Restarting (1) 5 seconds ago"), "restarting");
  assert.equal(toContainer({ ID: "x", Names: "n", Status: "Exited (0) 1 hour ago" }).state, "exited");
});

test("groupContainers: projects with running counts, loose containers running first", () => {
  const list = [
    toContainer(JSON.parse(ps({ ID: "1", Names: "b-db-1", State: "exited", Labels: "com.docker.compose.project=b,com.docker.compose.service=db" }))),
    toContainer(JSON.parse(ps({ ID: "2", Names: "a-web-1", Labels: "com.docker.compose.project=a,com.docker.compose.service=web" }))),
    toContainer(JSON.parse(ps({ ID: "3", Names: "zed", State: "running" }))),
    toContainer(JSON.parse(ps({ ID: "4", Names: "alpha", State: "exited" }))),
  ];
  const g = groupContainers(list);
  assert.deepEqual(g.projects.map((p) => [p.project, p.running, p.total]), [["a", 1, 1], ["b", 0, 1]]);
  assert.deepEqual(g.loose.map((c) => c.name), ["zed", "alpha"]);
});

test("composeArgs: up names its files, down goes by project", () => {
  const g = { project: "app", workdir: "/src/app", configFiles: ["/src/app/compose.yml"] };
  assert.deepEqual(composeArgs(g, "up", ["-d"]), ["compose", "-p", "app", "--project-directory", "/src/app", "-f", "/src/app/compose.yml", "up", "-d"]);
  assert.deepEqual(composeArgs(g, "down"), ["compose", "-p", "app", "down"]);
});

test("toImage and sortImages: dangling last, ref with tag", () => {
  const imgs = [toImage({ ID: "d1", Repository: "<none>", Tag: "<none>", Size: "1MB" }), toImage({ ID: "n1", Repository: "nginx", Tag: "alpine", Size: "40MB" })];
  assert.equal(imgs[1].ref, "nginx:alpine");
  assert.equal(imgs[0].ref, "d1");
  assert.deepEqual(sortImages(imgs).map((i) => i.id), ["n1", "d1"]);
});

test("parseStats: keyed by id and name", () => {
  const s = parseStats('{"ID":"abc","Name":"web","CPUPerc":"0.50%","MemUsage":"12MiB / 2GiB","MemPerc":"0.6%"}');
  assert.equal(s.abc.cpu, "0.50%");
  assert.equal(s.web.mem, "12MiB");
});

test("daemonDown: the usual messages", () => {
  assert.equal(daemonDown("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"), true);
  assert.equal(daemonDown("failed to connect to the docker API at unix:///Users/x/.orbstack/run/docker.sock"), true);
  assert.equal(daemonDown("Error: No such container: x"), false);
});

test("matchesFilter: name, image, ports", () => {
  const c = toContainer(JSON.parse(ps({ Ports: "0.0.0.0:3000->3000/tcp" })));
  assert.equal(matchesFilter(c, "NGINX"), true);
  assert.equal(matchesFilter(c, "3000→"), true);
  assert.equal(matchesFilter(c, "postgres"), false);
  assert.equal(matchesFilter(c, ""), true);
});

test("runArgs: detached or interactive, ports, env with commas in values", () => {
  assert.deepEqual(runArgs({ image: "nginx", name: "w", ports: "8080:80, 443:443", env: "A=1, B=x,y, C=3", detached: true }),
    ["run", "-d", "--name", "w", "-p", "8080:80", "-p", "443:443", "-e", "A=1", "-e", "B=x,y", "-e", "C=3", "nginx"]);
  assert.deepEqual(runArgs({ image: "alpine", detached: false, command: "sh -c 'echo hi'" }), ["run", "--rm", "-it", "alpine", "sh", "-c", "echo hi"]);
});

test("splitWords and isRunning", () => {
  assert.deepEqual(splitWords(`a "b c" 'd'`), ["a", "b c", "d"]);
  assert.equal(isRunning({ state: "restarting" }), true);
  assert.equal(isRunning({ state: "exited" }), false);
});
