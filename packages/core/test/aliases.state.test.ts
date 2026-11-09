// The Claude accounts in the state (src/state/aliases.ts, wired into src/state/conn.ts and src/state/store.ts), with the real
// store and event layer over a fake transport (fixtures/faketransport.ts): the snapshot's `aliases` of this computer and of a
// section, the `aliases` event, a server that leaves the list, the names fed to agents.ts; the actions (their calls, the answer
// put into the list at once, a refusal thrown with the server's sentence); the login flow (waiting → a wrong code → logged
// in; a well-formed wrong code that ends it → failed, and a new start; preparing → asked again once its container runs, or after a
// short wait when it runs already; cancel, also when the call fails; a list that settles a flow; the opener's close when a flow ends
// without its URL, never after it); and the request to show the accounts screen.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFake, ok, refuse, type Seen } from "./fixtures/faketransport.ts";
import { envelopesOf } from "./fixtures/stream.ts";
import { setBoardSide } from "../src/state/ports.ts";
import { connect } from "../src/state/conn.ts";
import { getState, setState } from "../src/state/store.ts";
import { agentName } from "../src/agents.ts";
import type { Alias, AliasList } from "../src/aliasesapi.ts";
import {
  applyAliases, cancelLogin, closeAccounts, loginWaits, logoutAccount, openAccounts, openLinkAgain, refreshAccounts, removeAccount, restartAccount, saveAccount, startLogin,
  stopAccount, submitCode, type OpenURL,
} from "../src/state/aliases.ts";

setBoardSide({ runTool: async () => ({}) as any, flushAll: async () => {}, boardLost() {}, granted() {}, handOver: async () => {}, streamOpened() {}, afterSnapshot() {}, sectionBack() {},
  forgetBoard() {}, boardUnsaved: () => false } as any);

const fake = installFake();
let answer: (c: Seen) => ReturnType<typeof ok> | undefined = () => undefined;
fake.handler = (c) => answer(c);
connect();
const push = (m: Record<string, unknown>, ctx = {}) => { for (const e of envelopesOf(m, ctx)) fake.emit(e); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const S = () => getState();

const LAB = "s_lab";
function alias(id: string, name: string, o: Partial<Alias> = {}): Alias {
  return { id, name, mounts: [], created: "2026-11-01T00:00:00Z", kind: `claude:${id}`, login: { known: true, loggedIn: false },
    container: { name: `aiwb-alias-${id}`, state: "stopped" }, restartNeeded: false, pending: [], busy: 0, ...o };
}
const list = (aliases: Alias[], o: Partial<AliasList> = {}): AliasList => ({ docker: { ok: true }, defaultImage: "aiwb/claude:dev", host: { known: true, loggedIn: true, email: "demo@example.com" }, aliases, ...o });
const work = alias("a_work0001", "Claude · Work", { login: { known: true, loggedIn: true, email: "work@example.com" }, container: { name: "aiwb-alias-a_work0001", state: "running" } });
const pers = alias("a_pers0001", "Claude · Personal");
const snapshot = (o: object = {}) => ({ type: "snapshot", groups: [], boards: [], chats: [], states: [], defaults: { groups: {} }, catalogs: {}, home: "/home/me", defaultCwd: "/home/me", ...o });
const servers = [{ id: "local", local: true, name: "This computer", state: "connected" }, { id: LAB, name: "Lab", state: "connected" }];
const labTree = { groups: [], boards: [], chats: [], states: [], defaults: { groups: {} } };

beforeEach(() => {
  fake.reset(); answer = () => undefined;
  for (const s of Object.keys(S().aliases)) applyAliases(s, null);
  setState({ aliasLogins: {}, accountsNav: null });
});

test("the snapshots' lists go to the store by server, and the names to agents.ts", () => {
  push({ ...snapshot({ aliases: list([work, pers]) }), servers, sections: { [LAB]: labTree }, lists: { [LAB]: { agents: ["claude"], catalogs: {}, home: "/home/dev", defaultCwd: "/home/dev", aliases: list([alias("a_lab00001", "Claude · Lab")], { docker: { ok: false, kind: "not_running", reason: "Docker is not running" } }) } } });
  assert.deepEqual(Object.keys(S().aliases).sort(), ["local", LAB]);
  assert.deepEqual(S().aliases.local.aliases.map((a) => a.id), ["a_work0001", "a_pers0001"]);
  assert.equal(S().aliases[LAB].docker.kind, "not_running");
  assert.equal(agentName("claude:a_work0001"), "Claude · Work");
  assert.equal(agentName("claude:a_lab00001"), "Claude · Lab");
  // a snapshot without `aliases`: that server has none
  push({ ...snapshot(), servers, sections: { [LAB]: labTree } });
  assert.deepEqual(Object.keys(S().aliases), []);
  assert.equal(agentName("claude:a_work0001"), "Claude account");
});

test("the `aliases` event replaces that server's list; a server that leaves the list takes its list with it", () => {
  push({ ...snapshot({ aliases: list([work]) }), servers, sections: { [LAB]: labTree }, lists: { [LAB]: { agents: [], catalogs: {}, home: "", defaultCwd: "", aliases: list([]) } } });
  push({ type: "aliases", aliases: list([work, pers]) });
  assert.deepEqual(S().aliases.local.aliases.map((a) => a.name), ["Claude · Work", "Claude · Personal"]);
  push({ type: "aliases", server: LAB, aliases: list([alias("a_lab00001", "Claude · Lab")]) });
  assert.equal(S().aliases[LAB].aliases[0].name, "Claude · Lab");
  assert.equal(agentName("claude:a_lab00001"), "Claude · Lab");
  push({ type: "servers", servers: servers.slice(0, 1) });
  assert.deepEqual(Object.keys(S().aliases), ["local"]);
  assert.equal(agentName("claude:a_lab00001"), "Claude account");
  assert.equal(agentName("claude:a_pers0001"), "Claude · Personal");
});

test("the actions call the account's server and put the answer into its list at once; a refusal is thrown with its sentence", async () => {
  applyAliases("local", list([work]));
  applyAliases(LAB, list([]));
  answer = (c) => (c.method === "GET" ? ok(list([work, pers])) : undefined);
  assert.equal((await refreshAccounts("local")).aliases.length, 2);
  assert.deepEqual(fake.calls.map((c) => [c.server, c.method, c.path]), [["local", "GET", "/api/aliases"]]);
  assert.equal(S().aliases.local.aliases.length, 2);

  fake.reset();
  const lab = alias("a_lab00001", "Claude · Lab", { mounts: ["/home/dev/x"] });
  answer = () => ok(lab);
  assert.deepEqual(await saveAccount(LAB, undefined, { name: "Claude · Lab", mounts: ["/home/dev/x"] }), { alias: lab });
  assert.deepEqual(fake.calls.map((c) => [c.server, c.method, c.path, c.body]), [[LAB, "POST", "/api/aliases", { name: "Claude · Lab", mounts: ["/home/dev/x"] }]]);
  assert.deepEqual(S().aliases[LAB].aliases, [lab]);
  assert.equal(agentName("claude:a_lab00001"), "Claude · Lab");

  fake.reset();
  const renamed = { ...work, name: "Claude · Job" };
  answer = () => ok({ restart: "unchanged", alias: renamed });
  assert.deepEqual(await saveAccount("local", "a_work0001", { name: "Claude · Job" }), { restart: "unchanged", alias: renamed });
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path, c.body]), [["PATCH", "/api/aliases/a_work0001", { name: "Claude · Job" }]]);
  assert.equal(S().aliases.local.aliases[0].name, "Claude · Job");

  fake.reset();
  answer = () => ok({ restart: "busy", busy: 2, alias: renamed });
  assert.deepEqual(await restartAccount("local", "a_work0001"), { restart: "busy", busy: 2, alias: renamed });
  answer = () => ok({ restart: "done", alias: renamed });
  await restartAccount("local", "a_work0001", true);
  await stopAccount("local", "a_work0001", true);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path, c.body]), [["POST", "/api/aliases/a_work0001/restart", { force: false }], ["POST", "/api/aliases/a_work0001/restart", { force: true }],
    ["POST", "/api/aliases/a_work0001/stop", { force: true }]]);

  fake.reset();
  const out = { ...pers, login: { known: true, loggedIn: false } };
  answer = () => ok(out);
  await logoutAccount("local", "a_pers0001");
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [["POST", "/api/aliases/a_pers0001/logout"]]);

  fake.reset();
  answer = () => ok({});
  await removeAccount("local", "a_pers0001");
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path]), [["DELETE", "/api/aliases/a_pers0001"]]);
  assert.deepEqual(S().aliases.local.aliases.map((a) => a.id), ["a_work0001"]);
  assert.equal(agentName("claude:a_pers0001"), "Claude account");

  answer = () => refuse(400, { error: "/Users/demo/notes/todo.md is not a folder", code: "bad_folder" });
  await assert.rejects(saveAccount("local", "a_work0001", { mounts: ["/Users/demo/notes/todo.md"] }), (e: any) => e.message === "/Users/demo/notes/todo.md is not a folder" && e.code === "bad_folder" && e.status === 400);
  // an image that is not an image name: the server's sentence, as the sheet shows it (AccountForm shows a refusal's message)
  const notImage = "“-v=/:/host” is not an image name (like ubuntu:24.04 or registry.example.com/team/claude:1)";
  answer = () => refuse(400, { error: notImage, code: "bad_image" });
  await assert.rejects(saveAccount("local", "a_work0001", { image: "-v=/:/host" }), (e: any) => e.message === notImage && e.code === "bad_image" && e.status === 400);
  await assert.rejects(saveAccount("local", undefined, { name: "W", image: "my image" }), (e: any) => e.code === "bad_image" && e.status === 400);
  answer = () => refuse(501, { error: "Claude accounts are not available on this server" });
  await assert.rejects(refreshAccounts(LAB), /not available on this server/);
});

test("a login: waiting opens the URL; a wrong code keeps it waiting with Claude's error; a right one ends it", async () => {
  applyAliases("local", list([pers]));
  const URL1 = "https://claude.ai/oauth/authorize?mock=a_pers0001", opened: string[] = [];
  answer = (c) => (c.path.endsWith("/login") ? ok({ state: "waiting", url: URL1 }) : c.path.endsWith("/login/code") ? (c.body as any).code === "wrong" ? ok({ state: "waiting", url: URL1, error: "Invalid code, please try again" }) : ok({ state: "logged_in", email: "personal@example.com" }) : undefined);
  const started = startLogin("local", "a_pers0001", (u) => opened.push(u));
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "starting" });
  await started;
  assert.deepEqual(opened, [URL1]);
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "waiting", url: URL1 });
  const sending = submitCode("local", "a_pers0001", "wrong");
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "sending", url: URL1 });
  await sending;
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "waiting", url: URL1, error: "Invalid code, please try again" });
  await openLinkAgain("local", "a_pers0001", (u) => opened.push(u));
  assert.deepEqual(opened, [URL1, URL1]);
  await submitCode("local", "a_pers0001", "right-code");
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);
  assert.deepEqual(fake.calls.map((c) => [c.method, c.path, c.body]), [["POST", "/api/aliases/a_pers0001/login", undefined], ["POST", "/api/aliases/a_pers0001/login/code", { code: "wrong" }],
    ["POST", "/api/aliases/a_pers0001/login/code", { code: "right-code" }]]);
});

test("a login that prepares is asked again, once, when the list shows its container running", async () => {
  applyAliases("local", list([pers]));
  let n = 0;
  const opened: string[] = [];
  answer = (c) => (c.path.endsWith("/login") ? (++n === 1 ? ok({ state: "preparing" }) : ok({ state: "waiting", url: "https://u" })) : undefined);
  await startLogin("local", "a_pers0001", (u) => opened.push(u));
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "preparing" });
  push({ type: "aliases", aliases: list([{ ...pers, container: { ...pers.container, state: "preparing" } }]) });
  await tick();
  assert.equal(n, 1, "still preparing: not asked");
  const running = list([{ ...pers, container: { ...pers.container, state: "running" } }]);
  push({ type: "aliases", aliases: running });
  push({ type: "aliases", aliases: running });
  await tick(); await tick();
  assert.equal(n, 2, "asked again once");
  assert.deepEqual(opened, ["https://u"]);
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "waiting", url: "https://u" });
  // a list that shows it logged in ends the flow that waits
  push({ type: "aliases", aliases: list([{ ...pers, login: { known: true, loggedIn: true, email: "p@x" } }]) });
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);
});

test("cancel ends the login on the server, and drops the flow even when that call fails; a failed start says why", async () => {
  applyAliases("local", list([pers]));
  answer = (c) => (c.method === "POST" ? ok({ state: "waiting", url: "https://u" }) : undefined);
  await startLogin("local", "a_pers0001", () => {});
  await cancelLogin("local", "a_pers0001");
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);
  assert.deepEqual(fake.calls.at(-1) && [fake.calls.at(-1)!.method, fake.calls.at(-1)!.path], ["DELETE", "/api/aliases/a_pers0001/login"]);

  await startLogin("local", "a_pers0001", () => {});
  answer = () => refuse(503, { error: "This computer is not connected.", code: "server_unreachable" });
  await assert.rejects(cancelLogin("local", "a_pers0001"), /not connected/);
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);

  answer = () => refuse(409, { error: "Docker is not running", code: "docker_unavailable" });
  await assert.rejects(startLogin("local", "a_pers0001", () => {}), /Docker is not running/);
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "failed", error: "Docker is not running" });
  answer = () => ok({ state: "failed", error: "claude exited" });
  await startLogin("local", "a_pers0001", () => {});
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "failed", error: "claude exited" });
  // an account that leaves the list takes its flow with it
  push({ type: "aliases", aliases: list([]) });
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);
});

test("an answer that comes after a cancel does not bring the flow back", async () => {
  applyAliases("local", list([pers]));
  let release!: () => void;
  answer = (c) => (c.method === "POST" ? new Promise((r) => { release = () => r(ok({ state: "waiting", url: "https://late" })); }) as any : undefined);
  const opened: string[] = [];
  const started = startLogin("local", "a_pers0001", (u) => opened.push(u));
  await tick();
  answer = () => undefined;
  await cancelLogin("local", "a_pers0001");
  release();
  await started;
  assert.equal(S().aliasLogins["local/a_pers0001"], undefined);
  assert.deepEqual(opened, []);
});

/** An opener as the web's openLater gives it: what it opened, and how many times it was closed. */
function opener(): OpenURL & { opened: string[]; closed: number } {
  const o = Object.assign((u: string) => { o.opened.push(u); }, { opened: [] as string[], closed: 0, close() { o.closed++; } });
  return o;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a well-formed wrong code ends the login (failed, with Claude's sentence); Log in again starts a new one, which opens the URL", async () => {
  applyAliases("local", list([pers]));
  const URL1 = "https://claude.ai/oauth/authorize?mock=a_pers0001", WRONG = "Login failed: That code wasn't accepted. Please try again.";
  answer = (c) => (c.path.endsWith("/login") ? ok({ state: "waiting", url: URL1 }) : c.path.endsWith("/login/code") ? ok({ state: "failed", error: WRONG }) : undefined);
  const first = opener();
  await startLogin("local", "a_pers0001", first);
  await submitCode("local", "a_pers0001", "bad#code");
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "failed", error: WRONG });
  assert.deepEqual([first.opened, first.closed], [[URL1], 0], "opened once, never closed after");
  const again = opener();
  const started = startLogin("local", "a_pers0001", again);
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "starting" });
  await started;
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "waiting", url: URL1 });
  assert.deepEqual([again.opened, again.closed], [[URL1], 0]);
  // no login open on the server: failed as well, with its sentence
  answer = (c) => (c.path.endsWith("/login/code") ? ok({ state: "failed", error: "No login is open for this account; start it again" }) : undefined);
  await submitCode("local", "a_pers0001", "x");
  assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "failed", error: "No login is open for this account; start it again" });
});

test("a login that prepares while the list shows its container running already is asked again after a short wait, once", async () => {
  const was = loginWaits.reaskMs, W = 60;
  loginWaits.reaskMs = W;
  try {
    const running = { ...pers, container: { ...pers.container, state: "running" as const } };
    applyAliases("local", list([running]));
    let n = 0;
    answer = (c) => (c.path.endsWith("/login") ? (++n <= 2 ? ok({ state: "preparing" }) : ok({ state: "waiting", url: "https://u" })) : undefined);
    const o = opener();
    await startLogin("local", "a_pers0001", o);
    assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "preparing" });
    assert.equal(n, 1);
    await sleep(W / 3);
    assert.equal(n, 1, "not before the wait");
    await sleep(W);
    assert.equal(n, 2, "asked again after the wait");
    assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "preparing" }); // preparing again: one more wait
    await sleep(W);
    assert.equal(n, 3);
    assert.deepEqual(S().aliasLogins["local/a_pers0001"], { phase: "waiting", url: "https://u" });
    assert.deepEqual([o.opened, o.closed], [["https://u"], 0]);
    await sleep(W);
    assert.equal(n, 3, "nothing more once waiting");

    // a list that shows it running while the wait runs asks at once; the wait then asks nothing more
    n = 0;
    answer = (c) => (c.path.endsWith("/login") ? (++n === 1 ? ok({ state: "preparing" }) : ok({ state: "waiting", url: "https://v" })) : undefined);
    const p = opener();
    await startLogin("local", "a_pers0001", p);
    push({ type: "aliases", aliases: list([running]) });
    push({ type: "aliases", aliases: list([running]) });
    await tick(); await tick();
    assert.equal(n, 2);
    await sleep(W);
    assert.equal(n, 2, "the wait asked nothing more");
    assert.deepEqual(p.opened, ["https://v"]);

    // a cancel while it waits drops the repeat, and closes what was readied for the URL
    n = 0;
    answer = (c) => (c.method === "POST" ? (++n, ok({ state: "preparing" })) : ok({})); // (the cancel is a DELETE of …/login)
    const q = opener();
    await startLogin("local", "a_pers0001", q);
    await cancelLogin("local", "a_pers0001");
    await sleep(W);
    assert.equal(n, 1, "not asked after a cancel");
    assert.deepEqual([q.opened, q.closed], [[], 1]);

    // a new start while it waits: the old wait asks nothing (the new flow's own wait asks once)
    n = 0;
    const r1 = opener(), r2 = opener();
    await startLogin("local", "a_pers0001", r1);
    await startLogin("local", "a_pers0001", r2);
    assert.equal(r1.closed, 1, "the first start will never open its URL");
    await sleep(W * 1.5);
    assert.equal(n, 3, "two starts, and one repeat");
    await cancelLogin("local", "a_pers0001");
    // a container not running yet: no wait, the list asks
    n = 0;
    applyAliases("local", list([pers]));
    await startLogin("local", "a_pers0001", opener());
    await sleep(W);
    assert.equal(n, 1, "not asked while the container does not run");
    await cancelLogin("local", "a_pers0001");
  } finally { loginWaits.reaskMs = was; }
});

test("the opener is closed when the flow ends or settles without its URL, and never after it was opened", async () => {
  applyAliases("local", list([pers]));
  // failed
  answer = () => ok({ state: "failed", error: "claude exited" });
  let o = opener();
  await startLogin("local", "a_pers0001", o);
  assert.deepEqual([o.opened, o.closed], [[], 1]);
  // a refusal of the call
  answer = () => refuse(409, { error: "Docker is not running", code: "docker_unavailable" });
  o = opener();
  await assert.rejects(startLogin("local", "a_pers0001", o));
  assert.deepEqual([o.opened, o.closed], [[], 1]);
  // logged in already
  answer = () => ok({ state: "logged_in", email: "p@x" });
  o = opener();
  await startLogin("local", "a_pers0001", o);
  assert.deepEqual([o.opened, o.closed, S().aliasLogins["local/a_pers0001"]], [[], 1, undefined]);
  // cancel while it prepares
  answer = (c) => (c.method === "POST" ? ok({ state: "preparing" }) : ok({}));
  o = opener();
  await startLogin("local", "a_pers0001", o);
  await cancelLogin("local", "a_pers0001");
  assert.deepEqual([o.opened, o.closed], [[], 1]);
  // a cancel before the start answers (the late answer neither opens nor closes it again)
  let release!: () => void;
  answer = (c) => (c.method === "POST" ? new Promise((r) => { release = () => r(ok({ state: "waiting", url: "https://late" })); }) as any : ok({}));
  o = opener();
  const started = startLogin("local", "a_pers0001", o);
  await tick();
  await cancelLogin("local", "a_pers0001");
  release(); await started;
  assert.deepEqual([o.opened, o.closed], [[], 1]);
  // the account leaves the list while it prepares
  answer = (c) => (c.method === "POST" ? ok({ state: "preparing" }) : ok({}));
  o = opener();
  await startLogin("local", "a_pers0001", o);
  push({ type: "aliases", aliases: list([]) });
  assert.deepEqual([o.opened, o.closed, S().aliasLogins["local/a_pers0001"]], [[], 1, undefined]);
  // opened: a cancel, a failure, the account logged in afterwards close nothing
  applyAliases("local", list([pers]));
  answer = (c) => (c.path.endsWith("/login") ? ok({ state: "waiting", url: "https://u" }) : c.path.endsWith("/login/code") ? ok({ state: "failed", error: "nope" }) : ok({}));
  o = opener();
  await startLogin("local", "a_pers0001", o);
  await submitCode("local", "a_pers0001", "bad#code");
  await cancelLogin("local", "a_pers0001");
  assert.deepEqual([o.opened, o.closed], [["https://u"], 0]);
  o = opener();
  await startLogin("local", "a_pers0001", o);
  push({ type: "aliases", aliases: list([{ ...pers, login: { known: true, loggedIn: true, email: "p@x" } }]) });
  assert.deepEqual([o.opened, o.closed, S().aliasLogins["local/a_pers0001"]], [["https://u"], 0, undefined]);
  // Open link again with no URL kept starts the login with its own opener, closed when that start fails
  applyAliases("local", list([pers]));
  answer = () => ok({ state: "failed", error: "claude exited" });
  await startLogin("local", "a_pers0001", opener());
  o = opener();
  await openLinkAgain("local", "a_pers0001", o);
  assert.deepEqual([o.opened, o.closed], [[], 1]);
});

test("the request to show the accounts screen: each one seen, closed by the screen", () => {
  openAccounts({ server: "local", id: "a_work0001", prefill: "/Users/demo/notes" });
  const a = S().accountsNav!;
  assert.deepEqual({ ...a, seq: 0 }, { server: "local", id: "a_work0001", prefill: "/Users/demo/notes", seq: 0 });
  openAccounts({ server: "local", id: "a_work0001", prefill: "/Users/demo/notes" });
  assert.ok(S().accountsNav!.seq > a.seq);
  openAccounts({ server: LAB, add: true });
  assert.equal(S().accountsNav!.add, true);
  closeAccounts();
  assert.equal(S().accountsNav, null);
});
