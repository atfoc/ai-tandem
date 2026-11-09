// The mock's Claude accounts (dev/mock.mjs, the block "Claude accounts"), through its fake client as the page's transport
// calls it, answering as the Go server does: the list in the snapshot, add/edit/remove and their refusals (the Go sentences, in
// CleanMounts' order; CleanImage), the outcomes of a change and of restart and stop (unchanged, deferred, done, busy → force, Docker
// first), the login (waiting → a malformed code → a wrong one that ends it → logged in; preparing; cancel leaves the container),
// logout, removal without Docker, the refusal of a message to a chat on an account (accountGate), an account's usage, a server
// without accounts (501), and that no event carries the login's URL.
// The seed's section MC (dev/mock-ui.js) is checked for what it sets up.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { createMockClient } from "./mock.mjs";

const client = createMockClient();
const events = [];
before(() => { client.subscribe((e) => events.push(e)); });
/** A call of the client API on a server: { status, body }. */
async function call(method, path, body, server = "local") {
  const r = await client.call({ server, method, path, ...(body === undefined ? {} : { body: { json: JSON.stringify(body) } }) });
  return { status: r.status, body: r.text ? JSON.parse(r.text) : null };
}
const ofType = (type, server = "local") => events.filter((e) => e.server === server && e.event?.type === type).map((e) => e.event);
const last = (type, server) => ofType(type, server).at(-1);
/** Runs code inside the mock, as /mock/eval does (the mock's own scope): the fake client has no such door, so the seed and the
 *  knobs are reached through a call of the mock's server, started here. */
let evalUrl = "";
async function mock(code) {
  const r = await fetch(evalUrl + "/mock/eval", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error);
  return j.r;
}
before(async () => {
  const { startMock } = await import("./mock.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-mcdist-"));
  fs.writeFileSync(path.join(dist, "index.html"), "<html>mock</html>");
  const server = await startMock({ port: 0, dist });
  evalUrl = `http://127.0.0.1:${server.address().port}`;
  server.unref();
});

test("this computer's snapshot carries its accounts: Docker running, none added, the host logged in", async () => {
  const snap = ofType("snapshot")[0];
  assert.deepEqual(snap.aliases, { docker: { ok: true }, defaultImage: "aiwb/claude:dev", host: { known: true, loggedIn: true, email: "demo@example.com" }, aliases: [] });
  assert.deepEqual((await call("GET", "/api/aliases")).body.aliases, []);
});

let id = "";
const at = (p) => `/api/aliases/${id}${p}`;
const viewOf = async (aid = id) => (await call("GET", "/api/aliases")).body.aliases.find((a) => a.id === aid);
const URL_ = () => `https://claude.ai/oauth/authorize?mock=${id}`;
const NO_LOGIN = { state: "failed", error: "No login is open for this account; start it again" };
const docker = (d) => mock(`aliasDocker("local", ${JSON.stringify(d)})`);
const setRec = (patch, aid = id) => mock(`return aliasSet("local", ${JSON.stringify(aid)}, ${JSON.stringify(patch)})`);

test("add: refusals with the server's sentences in CleanMounts' order, the folder as given; then the account as made (no container yet)", async () => {
  const refused = async (body, error, code) => assert.deepEqual(await call("POST", "/api/aliases", body), { status: 400, body: { error, code } });
  await refused({ name: "  " }, "An account needs a name", "bad_name");
  await refused({ name: "W", mounts: ["projects/shop"] }, "projects/shop is not an absolute path", "bad_folder");
  await refused({ name: "W", mounts: [""] }, " is not an absolute path", "bad_folder");
  await refused({ name: "W", mounts: ["~/notes"] }, "~/notes is not an absolute path", "bad_folder"); // (no ~ expansion)
  await refused({ name: "W", mounts: ["/Users/demo/nope"] }, "/Users/demo/nope does not exist", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/no:pe"] }, "/Users/demo/no:pe does not exist", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/notes/todo.md"] }, "/Users/demo/notes/todo.md is not a folder", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/projects/a:b"] }, "/Users/demo/projects/a:b has a “:” in its path, which Docker cannot mount", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/notes", "/Users/demo/notes/"] }, "/Users/demo/notes/ is listed twice", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/nope", "/Users/demo"] }, "/Users/demo/nope does not exist", "bad_folder"); // (the first)
  await refused({ name: "W", mounts: ["/Users/demo/"] }, "/Users/demo/ holds this computer's Claude login (~/.claude)", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/.claude"] }, "/Users/demo/.claude holds this computer's Claude login (~/.claude)", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/.aiwb-demo"] }, "/Users/demo/.aiwb-demo holds the app's data folder", "bad_folder");
  await refused({ name: "W", mounts: ["/Users/demo/.aiwb-demo/accounts"] }, "/Users/demo/.aiwb-demo/accounts is inside the app's data folder", "bad_folder");
  // an image that is not an image name (CleanImage, after the folders): the sentence names it trimmed
  const notImage = (s) => `“${s}” is not an image name (like ubuntu:24.04 or registry.example.com/team/claude:1)`;
  await refused({ name: "W", image: "--privileged" }, notImage("--privileged"), "bad_image");
  await refused({ name: "W", image: " -v=/:/host " }, notImage("-v=/:/host"), "bad_image");
  await refused({ name: "W", image: "my image:1" }, notImage("my image:1"), "bad_image");
  await refused({ name: "W", image: "ubuntu\t24" }, notImage("ubuntu\t24"), "bad_image");
  await refused({ name: "W", mounts: ["/Users/demo/nope"], image: "-x" }, "/Users/demo/nope does not exist", "bad_folder"); // (the folders first)
  await refused({ name: "", image: "-x" }, "An account needs a name", "bad_name"); // (the name first)
  const before = events.length;
  const r = await call("POST", "/api/aliases", { name: " Claude · Personal ", image: " aiwb/claude:dev ", mounts: ["/Users/demo/projects/shop/", "/Users/demo/projects/shop/web"] });
  assert.equal(r.status, 200, "a folder inside another listed one is allowed");
  id = r.body.id;
  assert.match(id, /^a_[0-9a-z]{8}$/);
  assert.deepEqual({ ...r.body, created: "" }, { id, name: "Claude · Personal", mounts: ["/Users/demo/projects/shop", "/Users/demo/projects/shop/web"], created: "", kind: `claude:${id}`,
    login: { known: true, loggedIn: false }, container: { name: `aiwb-alias-${id}`, state: "none" }, restartNeeded: false, pending: [], busy: 0 }, "the folders cleaned; the default image saved as none");
  const sent = events.slice(before).filter((e) => e.event?.type === "aliases");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].event.aliases.aliases[0].id, id);
});

test("restart and stop of a container that is not running change nothing: deferred, done", async () => {
  const before = await viewOf();
  assert.deepEqual((await call("POST", at("/restart"), { force: false })).body, { restart: "deferred", alias: before });
  assert.deepEqual((await call("POST", at("/stop"), { force: true })).body, { restart: "done", alias: before });
  await setRec({ busy: 3 });
  assert.equal((await call("POST", at("/restart"), {})).body.restart, "deferred", "not busy: it is not running");
  await setRec({ busy: 0 });
  assert.deepEqual(await viewOf(), before);
});

test("edit: unchanged, deferred while there is no container, the image as CleanImage keeps it; done when running and idle, busy with the count, then restart with force", async () => {
  const patch = (b) => call("PATCH", at(""), b);
  assert.equal((await patch({ name: "Claude · Personal" })).body.restart, "unchanged");
  assert.deepEqual(await patch({ name: "" }), { status: 400, body: { error: "An account needs a name", code: "bad_name" } });
  assert.deepEqual(await patch({ mounts: ["/Users/demo/x:y"] }), { status: 400, body: { error: "/Users/demo/x:y does not exist", code: "bad_folder" } });
  const kept = await viewOf();
  assert.deepEqual(await patch({ name: "Other", image: "-v=/:/host" }), { status: 400,
    body: { error: "“-v=/:/host” is not an image name (like ubuntu:24.04 or registry.example.com/team/claude:1)", code: "bad_image" } });
  assert.deepEqual(await viewOf(), kept, "a refused edit saves nothing, not even its good fields");
  assert.equal((await patch({ mounts: ["/Users/demo/projects/shop/"] })).body.restart, "deferred");
  assert.deepEqual((await viewOf()).mounts, ["/Users/demo/projects/shop"]);
  let r = await patch({ image: " my/claude:1 " });
  assert.deepEqual([r.body.restart, r.body.alias.image], ["deferred", "my/claude:1"]);
  r = await patch({ image: "aiwb/claude:dev" });
  assert.deepEqual([r.body.restart, "image" in r.body.alias], ["deferred", false], "the default image is saved as none");
  assert.equal((await patch({ image: " aiwb/claude:dev  " })).body.restart, "unchanged");
  // a login starts the container; its cancel leaves it running
  assert.equal((await call("POST", at("/login"))).body.state, "waiting");
  assert.deepEqual(await call("DELETE", at("/login")), { status: 200, body: {} });
  assert.equal((await viewOf()).container.state, "running");
  r = await patch({ mounts: ["/Users/demo/projects/shop", "/Users/demo/notes"] });
  assert.equal(r.body.restart, "done");
  assert.deepEqual(r.body.alias.applied, { image: "aiwb/claude:dev", default: true, mounts: ["/Users/demo/projects/shop", "/Users/demo/notes"] }, "made for the default image");
  await setRec({ busy: 2 });
  r = await patch({ mounts: ["/Users/demo/projects/shop"] });
  assert.deepEqual([r.body.restart, r.body.busy, r.body.alias.restartNeeded, r.body.alias.pending], ["busy", 2, true, []], "saved; the running container keeps the old mounts (none of the saved ones is missing from it)");
  assert.equal((await patch({ mounts: ["/Users/demo/notes/", "/Users/demo/projects/shop"] })).body.restart, "unchanged", "the running container has them already");
  r = await patch({ mounts: ["/Users/demo/projects/shop", "/Users/demo/projects/scratch"] });
  assert.deepEqual([r.body.restart, r.body.alias.restartNeeded, r.body.alias.pending], ["busy", true, ["/Users/demo/projects/scratch"]]);
  assert.deepEqual((await call("POST", at("/restart"), { force: false })).body.restart, "busy");
  assert.equal((await viewOf()).busy, 2, "nothing changed");
  r = await call("POST", at("/restart"), { force: true });
  assert.deepEqual([r.body.restart, r.body.alias.restartNeeded, r.body.alias.busy, r.body.alias.container.state], ["done", false, 0, "running"]);
  await setRec({ busy: 1 });
  const n = ofType("aliases").length;
  assert.deepEqual((await call("POST", at("/stop"), {})).body, { restart: "busy", busy: 1, alias: await viewOf() });
  assert.ok(ofType("aliases").length > n, "the list goes out as on the server");
  r = await call("POST", at("/stop"), { force: true });
  assert.deepEqual([r.body.restart, r.body.alias.container.state, r.body.alias.busy], ["done", "stopped", 0]);
  assert.equal((await patch({ image: "my/claude:1" })).body.restart, "deferred", "a stopped container takes it at its next start");
  await patch({ image: "" });
  assert.deepEqual(await call("PATCH", "/api/aliases/a_nope0000", {}), { status: 404, body: { error: "No such account", code: "not_found" } });
});

test("applied.default: a container made for the default image follows a new tag of it without a restart; one made for an image named does not", async () => {
  const r = await call("POST", "/api/aliases", { name: "Tags" });
  const tid = r.body.id, tat = (p) => `/api/aliases/${tid}${p}`;
  await call("POST", tat("/login")); await call("DELETE", tat("/login")); // (running)
  let v = await viewOf(tid);
  assert.deepEqual(v.applied, { image: "aiwb/claude:dev", default: true, mounts: [] });
  try {
    await mock(`worlds.local.accounts.defaultImage = "aiwb/claude:dev2"`); // (an update of the app: a new default tag)
    v = await viewOf(tid);
    assert.equal(v.restartNeeded, false, "the default's new tag is taken when the container is next made");
    // a container made for an image the person named, even one of the default repository, differs from the default
    await setRec({ applied: { image: "aiwb/claude:dev", mounts: [] } }, tid);
    assert.equal((await viewOf(tid)).restartNeeded, true);
    assert.equal("default" in (await viewOf(tid)).applied, false);
    // an image named: applied has no default
    const p = await call("PATCH", tat(""), { image: "my/claude:1" });
    assert.deepEqual([p.body.restart, p.body.alias.applied], ["done", { image: "my/claude:1", mounts: [] }]);
  } finally {
    await mock(`worlds.local.accounts.defaultImage = "aiwb/claude:dev"`);
    await call("DELETE", tat(""));
  }
});

test("Docker that cannot be used: restart, stop, login and logout refused first (busy too); removal only when Docker is not there at all", async () => {
  await call("POST", at("/login")); await call("DELETE", at("/login")); // (running)
  await setRec({ busy: 2 });
  await docker({ ok: false, kind: "not_running", reason: "Docker is not running" });
  const refused = { status: 409, body: { error: "Docker is not running", code: "docker_unavailable" } };
  for (const p of ["/restart", "/stop", "/login", "/logout"]) assert.deepEqual(await call("POST", at(p), {}), refused, p);
  assert.deepEqual(await call("DELETE", at("")), refused);
  await docker({ ok: false, kind: "failed", reason: "Docker answered nonsense" });
  assert.deepEqual(await call("DELETE", at("")), { status: 409, body: { error: "Docker answered nonsense", code: "docker_unavailable" } });
  assert.ok(await viewOf(), "not removed");
  await docker({ ok: true });
  assert.deepEqual([(await viewOf()).container.state, (await viewOf()).busy], ["running", 2], "nothing changed");
  await setRec({ busy: 0 });
  for (const kind of ["not_installed", "unsupported"]) {
    const other = (await call("POST", "/api/aliases", { name: `Gone ${kind}` })).body.id;
    await docker({ ok: false, kind, reason: "No Docker here" });
    assert.deepEqual(await call("DELETE", `/api/aliases/${other}`), { status: 200, body: {} }, kind);
    await docker({ ok: true });
    assert.equal(await viewOf(other), undefined, `removed without Docker (${kind})`);
  }
});

test("login: waiting with the URL, a second start joins; a malformed code waits on, a wrong one ends the login; a right one; the URL in no event", async () => {
  const agentsBefore = ofType("agents").length, code = (c) => call("POST", at("/login/code"), { code: c });
  await call("POST", at("/stop"), { force: true });
  assert.deepEqual(await code("4f7a-right"), { status: 200, body: NO_LOGIN }, "no login open: 200 failed");
  let r = await call("POST", at("/login"));
  assert.deepEqual(r.body, { state: "waiting", url: URL_() });
  assert.equal((await viewOf()).container.state, "running");
  assert.deepEqual((await call("POST", at("/login"))).body, r.body);
  const MALFORMED = { state: "waiting", url: URL_(), error: "Invalid code. Please make sure the full code was copied." };
  assert.deepEqual(await code("wrong"), { status: 200, body: MALFORMED });
  assert.deepEqual(await code(""), { status: 200, body: MALFORMED }, "an empty code is malformed");
  assert.deepEqual(await code("  "), { status: 200, body: MALFORMED });
  assert.deepEqual(await code("bad#code"), { status: 200, body: { state: "failed", error: "Login failed: That code wasn't accepted. Please try again." } });
  assert.deepEqual(await code("4f7a-right"), { status: 200, body: NO_LOGIN }, "the login ended");
  assert.equal((await viewOf()).container.state, "running", "the container as it is");
  assert.equal((await viewOf()).login.loggedIn, false);
  assert.equal((await call("POST", at("/login"))).body.state, "waiting");
  r = await code("4f7a-right");
  assert.deepEqual(r.body, { state: "logged_in", email: "personal@example.com" });
  assert.deepEqual(last("aliases").aliases.aliases.find((a) => a.id === id).login, { known: true, loggedIn: true, email: "personal@example.com" });
  assert.ok(ofType("agents").length > agentsBefore);
  assert.deepEqual(last("agents").agents, ["claude", "cursor", "pi", `claude:${id}`]);
  assert.equal(last("catalog").agent, `claude:${id}`);
  assert.deepEqual(await code("4f7a-right"), { status: 200, body: NO_LOGIN }, "the login is over");
  // logged in: a login starts all the same (no shortcut), and its cancel leaves the login and the container as they are
  assert.deepEqual((await call("POST", at("/login"))).body, { state: "waiting", url: URL_() });
  assert.deepEqual(await call("DELETE", at("/login")), { status: 200, body: {} });
  assert.deepEqual(await call("DELETE", at("/login")), { status: 200, body: {} }, "none open: 200 {}");
  const v = await viewOf();
  assert.deepEqual([v.container.state, v.login.loggedIn], ["running", true]);
  assert.deepEqual(await code("x#y"), { status: 200, body: NO_LOGIN });
  assert.ok(!JSON.stringify(events).includes("oauth/authorize"), "the login URL is in no event");
});

test("logout starts the container when it is not running, and the account is not logged in", async () => {
  await call("POST", at("/stop"), { force: true });
  const r = await call("POST", at("/logout"));
  assert.deepEqual([r.status, r.body.login, r.body.container.state], [200, { known: true, loggedIn: false }, "running"]);
  assert.deepEqual(r.body.applied, { image: "aiwb/claude:dev", default: true, mounts: ["/Users/demo/projects/shop", "/Users/demo/projects/scratch"] }, "made with the saved spec");
  assert.deepEqual(last("agents").agents, ["claude", "cursor", "pi"]);
});

test("login while the container is prepared: preparing, the event shows it running once released, the next login has the URL", async () => {
  await call("POST", at("/stop"), { force: true });
  await mock(`flags.aliasLogin = { preparing: true, hold: true }`);
  assert.deepEqual((await call("POST", at("/login"))).body, { state: "preparing" });
  assert.equal(last("aliases").aliases.aliases.find((a) => a.id === id).container.state, "preparing");
  assert.deepEqual((await call("POST", at("/login"))).body, { state: "preparing" });
  assert.deepEqual((await call("POST", at("/login/code"), { code: "4f7a-right" })).body, NO_LOGIN, "no URL yet: no code is taken");
  assert.equal(await mock(`return release("aliasLogin")`), 1);
  for (let i = 0; i < 50 && (await viewOf()).container.state !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(last("aliases").aliases.aliases.find((a) => a.id === id).container.state, "running");
  assert.deepEqual((await call("POST", at("/login"))).body, { state: "waiting", url: URL_() });
  await call("DELETE", at("/login"));
});

test("a login cancelled while the image is built: the build goes on (the container ends running) and no login opens", async () => {
  await call("POST", at("/stop"), { force: true });
  assert.deepEqual((await call("POST", at("/login"))).body, { state: "preparing" });
  assert.deepEqual(await call("DELETE", at("/login")), { status: 200, body: {} });
  assert.equal((await viewOf()).container.state, "preparing", "the build goes on");
  assert.equal(await mock(`return release("aliasLogin")`), 1);
  for (let i = 0; i < 50 && (await viewOf()).container.state !== "running"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await viewOf()).container.state, "running");
  assert.deepEqual((await call("POST", at("/login/code"), { code: "4f7a-right" })).body, NO_LOGIN, "no login opened");
  assert.equal((await viewOf()).login.loggedIn, false);
  await mock(`delete flags.aliasLogin`);
});

test("an account's usage: Docker down, a stopped container refused; a running one, or an id no account has, as any agent's", async () => {
  const usage = (k) => call("GET", `/api/usage/${encodeURIComponent(k)}`);
  assert.equal((await usage("claude:a_nope0000")).status, 200);
  assert.equal((await usage(`claude:${id}`)).status, 200, "running");
  await call("POST", at("/stop"), { force: true });
  assert.deepEqual(await usage(`claude:${id}`), { status: 409, body: { error: "Start the account to see its usage", code: "alias_stopped" } });
  assert.equal((await viewOf()).container.state, "stopped", "not started for it");
  await docker({ ok: false, kind: "not_running", reason: "Docker is not running" });
  assert.deepEqual(await usage(`claude:${id}`), { status: 409, body: { error: "Docker is not running", code: "docker_unavailable" } });
  await docker({ ok: true });
});

test("a message to a chat on an account is refused as the server refuses it", async () => {
  const kind = `claude:${id}`, made = (await call("POST", "/api/chats", { agent: kind, group: "__ungrouped__" })).body;
  const send = () => call("POST", `/api/chats/${made.id}/messages`, { text: "hi" });
  const cwd = (dir) => call("PATCH", `/api/chats/${made.id}`, { cwd: dir });
  await call("PATCH", at(""), { mounts: ["/Users/demo/projects/shop"] });
  await cwd("/Users/demo/notes");
  assert.deepEqual(await send(), { status: 409, body: { error: "Not logged in", code: "agent_missing" } }, "before the folder");
  await docker({ ok: false, kind: "not_running", reason: "Docker is not running" });
  assert.deepEqual(await send(), { status: 409, body: { error: "Docker is not running", code: "docker_unavailable" } }, "Docker before the login");
  await docker({ ok: true });
  await call("POST", at("/login"));
  await call("POST", at("/login/code"), { code: "4f7a-right" });
  await call("POST", at("/stop"), { force: true });
  assert.deepEqual(await send(), { status: 409, body: { error: "This folder isn't mounted in Claude · Personal — Add it in Settings", code: "not_mounted" } });
  assert.equal((await viewOf()).container.state, "stopped", "a refused message starts nothing");
  // running and waiting for a restart: a folder only in the saved list waits for it
  await call("POST", at("/login")); await call("DELETE", at("/login")); // (running)
  await setRec({ busy: 1 });
  await call("PATCH", at(""), { mounts: ["/Users/demo/projects/shop", "/Users/demo/notes"] });
  assert.deepEqual(await send(), { status: 409, body: { error: "Restart Claude · Personal to use this folder", code: "mount_pending" } });
  await mock(`aliasDocker("local", { ok: false, kind: "not_running", reason: "Docker is not running" })`);
  assert.deepEqual(await send(), { status: 409, body: { error: "Docker is not running", code: "docker_unavailable" } });
  assert.equal(last("aliases").aliases.aliases.find((a) => a.id === id).container.state, "docker_unavailable");
  assert.equal(last("aliases").aliases.aliases.find((a) => a.id === id).container.reason, "Docker is not running");
  await mock(`aliasDocker("local", { ok: true })`);
  assert.equal(last("aliases").aliases.aliases.find((a) => a.id === id).container.state, "running", "back to its state");
  await cwd("/Users/demo/projects/shop/web");
  assert.equal((await send()).status, 200, "a folder under a mount");
  await call("POST", at("/stop"), { force: true });
  assert.equal((await send()).status, 200);
  assert.equal((await viewOf()).container.state, "running", "a message starts the container");
  assert.deepEqual(await call("DELETE", at("")), { status: 200, body: {} });
  assert.deepEqual(await send(), { status: 409, body: { error: "This account was removed", code: "alias_removed" } });
  assert.equal((await call("GET", `/api/chats/${made.id}`)).status, 200, "its chats stay");
});

test("a server without accounts answers 501, and its snapshot has none; the seed MC sets up both servers", async () => {
  await mock(`addServer({ id: "s_bare2", name: "Bare", address: "https://bare2.example:4790", state: "connected", version: "dev" }); resync();`);
  assert.deepEqual(await call("GET", "/api/aliases", undefined, "s_bare2"), { status: 501, body: { error: "Claude accounts are not available on this server" } });
  assert.equal(ofType("snapshot", "s_bare2").at(-1)?.aliases, undefined);
  const states = await mock(`return seedUI("MC")`);
  assert.deepEqual(states.map((s) => s.id), ["new", "work", "worknew", "unmounted", "pending", "removed"]);
  const here = (await call("GET", "/api/aliases")).body;
  assert.deepEqual(here.aliases.map((a) => [a.id, a.name, a.login.loggedIn, a.container.state, a.restartNeeded, a.pending, a.busy]), [
    ["a_work0001", "Claude · Work", true, "running", false, [], 0],
    ["a_pers0001", "Claude · Personal", false, "stopped", false, [], 0],
    ["a_clnt0001", "Claude · Client", true, "running", true, ["/Users/demo/projects/empty-repo"], 2],
  ]);
  const snap = ofType("snapshot").at(-1);
  assert.deepEqual(snap.agents, ["claude", "cursor", "pi", "claude:a_work0001", "claude:a_clnt0001"]);
  assert.deepEqual(snap.catalogs["claude:a_work0001"].models.map((m) => m.id), ["sonnet", "haiku"]);
  assert.equal(snap.catalogs["claude:a_clnt0001"].default.model, "opus");
  const lab = (await call("GET", "/api/aliases", undefined, "s_lab")).body;
  assert.deepEqual(lab.docker, { ok: false, kind: "not_running", reason: "Docker is not running" });
  assert.deepEqual(lab.aliases.map((a) => [a.id, a.container.state]), [["a_lab00001", "docker_unavailable"]]);
  const send = (chat) => call("POST", `/api/chats/${chat}/messages`, { text: "hi" });
  assert.equal((await send("c_MC_unmounted")).body.code, "not_mounted");
  assert.equal((await send("c_MC_pending")).body.code, "mount_pending");
  assert.equal((await send("c_MC_removed")).body.code, "alias_removed");
});
