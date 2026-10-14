// A call about a thing of a section (src/api.ts through a fake transport): the entry id is the call's server,
// every id in the path and in the body is that server's own, and what the call answers gets the page's keys.
// A local thing's call is the same call to the server "local".
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api } from "../src/api.ts";
import { imageUrl } from "../src/logic/chatimage.ts";
import { installFake, type Seen } from "./fixtures/faketransport.ts";
import { UNGROUPED } from "../src/types.ts";

const A = "s_0123456789ab";
const a = (id: string) => `${A}~${id}`;
const ON = "/api";

const fake = installFake();
const calls = fake.calls;
let answer: (path: string, method: string) => ReturnType<typeof json>;
const json = (body: unknown, status = 200, headers?: Record<string, string>) => ({ status, text: JSON.stringify(body), sceneRev: headers?.["X-AIWB-Scene-Rev"] ? Number(headers["X-AIWB-Scene-Rev"]) : null });
fake.handler = (c: Seen) => answer(c.path, c.method);
beforeEach(() => { fake.reset(); answer = () => json({}); });
const last = () => calls[calls.length - 1];

const usage = { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
const chatView = (id: string, o: object = {}) => ({ id, agent: "claude", cwd: "/w", model: "m", locked: false, created: "", usage, status: "ready", ...o });

test("a new chat is made where it was asked for: the place's key names the server, and the body has the place's own id", async () => {
  answer = () => json(chatView("c_new", { group: "g_1" }));
  const inGroup = await api.newChat({ group: a("g_1") });
  assert.deepEqual([last().method, last().path, last().body], ["POST", `${ON}/chats`, { group: "g_1" }]);
  assert.equal(last().server, A);
  assert.equal(inGroup.id, a("c_new"));
  assert.equal(inGroup.group, a("g_1"));
  await api.newChat({ group: a(UNGROUPED) });
  assert.deepEqual([last().path, last().body], [`${ON}/chats`, { group: UNGROUPED }], "from the section's head: outside any group");
  await api.newChat({ board: a("b_1") });
  assert.deepEqual([last().path, last().body], [`${ON}/chats`, { board: "b_1" }]);
  answer = () => json(chatView("c_local", { group: "g_1" }));
  const local = await api.newChat({ group: "g_1" });
  assert.deepEqual([last().server, last().path, last().body], ["local", "/api/chats", { group: "g_1" }]);
  assert.equal(local.id, "c_local");
});

test("a new board and group are made on the server of the group, or of the section, they are made in", async () => {
  answer = () => json({ id: "b_new", name: "Untitled", group: "g_1", created: "" });
  const b = await api.newBoard(a("g_1"));
  assert.deepEqual([last().method, last().path, last().body], ["POST", `${ON}/boards`, { group: "g_1", new: false }]);
  assert.equal(last().server, A);
  assert.deepEqual([b.id, b.group], [a("b_new"), a("g_1")]);
  answer = () => json({ id: "g_new", name: "New group", parent: "g_1" });
  const g = await api.newGroup(A, undefined, a("g_1"));
  assert.deepEqual([last().method, last().path, last().body], ["POST", `${ON}/groups`, { parent: "g_1" }]);
  assert.deepEqual(g, { id: a("g_new"), name: "New group", parent: a("g_1") }, "keyed");
  await api.newGroup(A);
  assert.deepEqual([last().path, last().body], [`${ON}/groups`, {}]);
  await api.newGroup("local", "Mine");
  assert.deepEqual([last().server, last().path, last().body], ["local", "/api/groups", { name: "Mine" }]);
});

test("a section's groups are renamed, moved, nested, archived and deleted on their server", async () => {
  await api.renameGroup(a("g_1"), "Work");
  assert.deepEqual([last().method, last().path, last().body], ["PATCH", `${ON}/groups/g_1`, { name: "Work" }]);
  await api.moveGroup(a("g_2"), a("g_1"), a("g_3"));
  assert.deepEqual([last().method, last().path, last().body], ["POST", `${ON}/groups/g_2/move`, { parent: "g_1", before: "g_3" }]);
  await api.moveGroup(a("g_2"), "");
  assert.deepEqual(last().body, { parent: "", before: "" }, "to the top level, last");
  await api.archive("groups", a("g_1"));
  assert.deepEqual([last().method, last().path], ["POST", `${ON}/groups/g_1/archive`]);
  await api.unarchive("groups", a("g_1"));
  assert.equal(last().path, `${ON}/groups/g_1/unarchive`);
  await api.deleteGroup(a("g_1"), "delete");
  assert.deepEqual([last().method, last().path], ["DELETE", `${ON}/groups/g_1?contents=delete`]);
  await api.deleteGroup(a("g_1"), "keep");
  assert.equal(last().path, `${ON}/groups/g_1?contents=keep`);
});

test("collapse is never sent for any group: there is no such call, and no call of a group carries the word", async () => {
  assert.equal("collapseGroup" in api, false);
  await api.renameGroup(a("g_1"), "Work");
  await api.renameGroup("g_1", "Work");
  assert.ok(calls.every((c) => !("collapsed" in (c.body as object))));
});

test("moving a board or a chat names a group of its own server by that group's own id", async () => {
  await api.moveBoard(a("b_1"), a("g_2"));
  assert.deepEqual([last().method, last().path, last().body], ["PATCH", `${ON}/boards/b_1`, { group: "g_2" }]);
  await api.moveChat(a("c_1"), a("g_2"));
  assert.deepEqual([last().path, last().body], [`${ON}/chats/c_1`, { group: "g_2" }]);
});

test("a message, a draft, a fork and the session calls of a section's chat go to its server under its own id", async () => {
  await api.send(a("c_1"), "main", "hi", "<ui-context>\nactive_board: B (b_1)\n</ui-context>");
  assert.deepEqual([last().method, last().path], ["POST", `${ON}/chats/c_1/messages?branch=main`]);
  assert.deepEqual(last().body, { text: "hi", context: "<ui-context>\nactive_board: B (b_1)\n</ui-context>" });
  await api.send(a("c_1"), "main", "hi", "", [], { branch: "ab12cd34", at: 2, new: true });
  assert.equal(last().path, `${ON}/chats/c_1/messages`);
  answer = () => json({ rev: 5 });
  assert.deepEqual(await api.saveDraft(a("c_1"), "main", { text: "@B", mentions: [{ name: "B", id: a("b_1") }] }, 4), { rev: 5 });
  assert.deepEqual([last().method, last().path], ["PUT", `${ON}/chats/c_1/draft?branch=main&rev=4`]);
  assert.deepEqual(last().body, { text: "@B", mentions: [{ name: "B", id: "b_1" }] }, "the boards picked in it by their own ids");
  assert.equal(last().path.includes("replace"), false);
  answer = () => json(chatView("c_fork", { forkedFrom: "c_1" }));
  const fork = await api.fork(a("c_1"), "main", 4, 3);
  assert.deepEqual([last().path, last().body], [`${ON}/chats/c_1/fork`, { branch: "main", at: 4, message: 3 }]);
  assert.deepEqual([fork.id, fork.forkedFrom], [a("c_fork"), a("c_1")]);
  answer = () => json({});
  await api.interrupt(a("c_1"), "main");
  assert.equal(last().path, `${ON}/chats/c_1/interrupt?branch=main`);
  await api.decide(a("c_1"), "main", { requestId: "q", allow: true } as never);
  assert.equal(last().path, `${ON}/chats/c_1/permission?branch=main`);
  await api.openChat(a("c_1"), "main");
  assert.equal(last().path, `${ON}/chats/c_1/open?branch=main`);
  await api.setLabel(a("c_1"), "main", 2, "x");
  assert.deepEqual([last().method, last().path, last().body], ["PUT", `${ON}/chats/c_1/label`, { branch: "main", item: 2, text: "x" }]);
  await api.renameChat(a("c_1"), "T");
  assert.deepEqual([last().path, last().body], [`${ON}/chats/c_1`, { name: "T" }]);
  await api.archive("chats", a("c_1"));
  assert.equal(last().path, `${ON}/chats/c_1/archive`);
  await api.deleteChat(a("c_1"));
  assert.deepEqual([last().method, last().path], ["DELETE", `${ON}/chats/c_1`]);
});

test("what a section's chat is read with: its view, items, tree, context, a subagent's thread; the record the items bring is keyed", async () => {
  answer = () => json(chatView("c_1", { board: "b_1" }));
  const c = await api.chat(a("c_1"));
  assert.deepEqual([last().method, last().path], ["GET", `${ON}/chats/c_1`]);
  assert.deepEqual([c.id, c.board], [a("c_1"), a("b_1")]);
  answer = () => json({ version: 2, items: [{ kind: "user", text: "hi" }], branch: "main", state: { chat: "c_1", branch: "main", cwd: "", model: "", locked: true, usage, status: "ready" } });
  const items = await api.items(a("c_1"), "main");
  assert.equal(last().path, `${ON}/chats/c_1/items?branch=main`);
  assert.equal(items.state?.chat, a("c_1"));
  assert.deepEqual(items.items, [{ kind: "user", text: "hi" }]);
  answer = () => json({ version: 1, items: [] });
  await api.subItems(a("c_1"), "main", "sa_1");
  assert.equal(last().path, `${ON}/chats/c_1/subagents/sa_1/items?branch=main`);
  await api.tree(a("c_1"));
  assert.equal(last().path, `${ON}/chats/c_1/tree`);
  await api.contextSplit(a("c_1"), "main", true);
  assert.equal(last().path, `${ON}/chats/c_1/context?branch=main&fresh=1`);
  answer = () => json({ ok: true, chat: chatView("c_1", { group: "g_1" }) });
  const conf = await api.configure(a("c_1"), "main", { model: "x" });
  assert.deepEqual([last().method, last().path, last().body], ["PATCH", `${ON}/chats/c_1?branch=main`, { model: "x" }]);
  assert.deepEqual([conf.chat?.id, conf.chat?.group], [a("c_1"), a("g_1")]);
});

test("a draft refused as stale brings that server's draft with the page's keys", async () => {
  answer = () => json({ error: "the draft was changed", code: "stale", rev: 9, draft: { text: "@B", mentions: [{ name: "B", id: "b_1" }] } }, 409);
  await assert.rejects(api.saveDraft(a("c_1"), "main", { text: "mine" }, 4), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.deepEqual([e.code, e.rev], ["stale", 9]);
    assert.deepEqual(e.draft, { text: "@B", mentions: [{ name: "B", id: a("b_1") }] });
    return true;
  });
});

test("an image of a section's chat is uploaded to its server, and shown from the transport's address of the picture", async () => {
  answer = () => json({ id: "f".repeat(64), name: "p.png", type: "image/png", size: 3 });
  await api.uploadImage(a("c_1"), new Blob(["abc"], { type: "image/png" }), "p.png", "image/png");
  assert.deepEqual([last().method, last().path], ["POST", `${ON}/chats/c_1/images?name=p.png`]);
  assert.deepEqual([last().server, last().type, last().body], [A, "image/png", "<3 bytes>"], "the bytes as they are");
  assert.equal(imageUrl(a("c_1"), "ab12"), `aiwb-picture://p/${A}/c_1/ab12`);
  assert.equal(imageUrl("c_1", "ab12"), "aiwb-picture://p/local/c_1/ab12");
});

test("a section's board: take, release, the drawing with its revision, rename, seen, delete", async () => {
  answer = () => json({ state: "held", rev: 3 });
  assert.deepEqual(await api.takeBoard(a("b_1"), true), { state: "held", rev: 3 });
  assert.deepEqual([last().method, last().path, last().body], ["POST", `${ON}/boards/b_1/take`, { ifFree: true }]);
  answer = () => json({ state: "free" });
  await api.releaseBoard(a("b_1"));
  assert.equal(last().path, `${ON}/boards/b_1/release`);
  answer = () => json({ elements: [] }, 200, { "X-AIWB-Scene-Rev": "7" });
  assert.deepEqual(await api.scene(a("b_1")), { scene: { elements: [] }, rev: 7 });
  assert.equal(last().path, `${ON}/boards/b_1/scene`);
  answer = () => json({ rev: 8 });
  assert.equal(await api.saveScene(a("b_1"), 7, { elements: [] }), 8);
  assert.deepEqual([last().method, last().path], ["PUT", `${ON}/boards/b_1/scene?rev=7`]);
  answer = () => json({ id: "b_1", name: "N", group: "g_1", created: "" });
  const b = await api.renameBoard(a("b_1"), "N");
  assert.deepEqual([last().path, last().body], [`${ON}/boards/b_1/rename`, { name: "N" }]);
  assert.deepEqual([b.id, b.group], [a("b_1"), a("g_1")]);
  answer = () => json({});
  await api.seenBoard(a("b_1"));
  assert.equal(last().path, `${ON}/boards/b_1/seen`);
  await api.deleteBoard(a("b_1"));
  assert.deepEqual([last().method, last().path], ["DELETE", `${ON}/boards/b_1`]);
});

test("a server's folders and plan usage are asked of that server, and the answer of a tool call goes to the server whose call it is", async () => {
  answer = () => json({ path: "/", parent: "", dirs: [] });
  await api.dirs("/w", A);
  assert.deepEqual([last().server, last().path], [A, "/api/dirs?path=%2Fw"]);
  await api.dirs("/w");
  assert.deepEqual([last().server, last().path], ["local", "/api/dirs?path=%2Fw"]);
  answer = () => json({ plan: false, limits: [], fetchedAt: "" });
  await api.usage("claude", false, A);
  assert.deepEqual([last().server, last().path], [A, "/api/usage/claude"]);
  await api.usage("claude", true, A);
  assert.deepEqual([last().server, last().path], [A, "/api/usage/claude?fresh=1"]);
  answer = () => json({});
  await api.rpcReply("far_12", { result: "ok" }, A);
  assert.deepEqual([last().server, last().path, last().body], [A, "/api/rpc-reply", { id: "far_12", result: "ok" }]);
});

test("a refusal of a section's call is that server's own, with its status, its code and its sentence", async () => {
  answer = () => json({ error: "Lab is not connected.", code: "server_unreachable" }, 503);
  await assert.rejects(api.newChat({ group: a("g_1") }), (e: unknown) => e instanceof ApiError && e.status === 503 && e.code === "server_unreachable" && e.message === "Lab is not connected.");
  answer = () => json({ error: "no such chat", code: "not_found" }, 404);
  await assert.rejects(api.items(a("c_1"), "main"), (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "not_found");
});

test("an id of one server is never sent to another: a move, a nesting or a new group that names a group of another server makes no call", async () => {
  const B = "s_ffffffffffff", b = (id: string) => `${B}~${id}`;
  const refused = (p: Promise<unknown>) => assert.rejects(p, (e: unknown) => e instanceof Error && !(e instanceof ApiError) && e.message === "Nothing is moved from one server to another.");
  // the same ids here, in one section and in another: each pair below is of two servers
  for (const [thing, group] of [["b_1", a("g_1")], [a("b_1"), "g_1"], [a("b_1"), b("g_1")], [a("b_1"), UNGROUPED], ["b_1", a(UNGROUPED)]]) await refused(api.moveBoard(thing, group));
  for (const [thing, group] of [["c_1", a("g_1")], [a("c_1"), "g_1"], [a("c_1"), b("g_1")]]) await refused(api.moveChat(thing, group));
  for (const [group, parent, before] of [["g_1", a("g_2"), ""], [a("g_1"), "g_2", ""], [a("g_1"), a("g_2"), "g_3"], [a("g_1"), "", b("g_3")], ["g_1", "", a("g_3")]]) await refused(api.moveGroup(group, parent, before));
  for (const [server, parent] of [["local", a("g_1")], [A, "g_1"], [A, b("g_1")]]) await refused(api.newGroup(server, "n", parent));
  assert.equal(calls.length, 0, "nothing was sent");
  // the same calls inside one server are made, here and there
  await api.moveBoard("b_1", "g_1");
  assert.deepEqual([last().path, last().body], ["/api/boards/b_1", { group: "g_1" }]);
  await api.moveBoard(a("b_1"), a("g_1"));
  assert.deepEqual([last().path, last().body], [`${ON}/boards/b_1`, { group: "g_1" }]);
  await api.moveGroup("g_1", "", "g_3");
  assert.deepEqual([last().path, last().body], ["/api/groups/g_1/move", { parent: "", before: "g_3" }]);
  await api.moveGroup(a("g_1"), a("g_2"));
  assert.deepEqual([last().path, last().body], [`${ON}/groups/g_1/move`, { parent: "g_2", before: "" }]);
  await api.newGroup("local", "n", "g_1");
  assert.deepEqual([last().path, last().body], ["/api/groups", { name: "n", parent: "g_1" }]);
  await api.newGroup(A, "n");
  assert.deepEqual([last().path, last().body], [`${ON}/groups`, { name: "n" }]);
});

test("a draft is saved with the boards of its own server alone: a local board picked in a section's chat, and the reverse, is not sent as that server's", async () => {
  answer = () => json({ rev: 2 });
  const picks = [{ name: "Here", id: "b_1" }, { name: "There", id: a("b_1") }];
  await api.saveDraft(a("c_1"), "main", { text: "@Here @There", mentions: picks }, 1);
  assert.deepEqual([last().path, last().body], [`${ON}/chats/c_1/draft?branch=main&rev=1`, { text: "@Here @There", mentions: [{ name: "There", id: "b_1" }] }]);
  await api.saveDraft("c_1", "main", { text: "@Here @There", mentions: picks }, 1);
  assert.deepEqual([last().path, last().body], ["/api/chats/c_1/draft?branch=main&rev=1", { text: "@Here @There", mentions: [{ name: "Here", id: "b_1" }] }]);
});

// The one rule under all of the above, asked of every method of the api at once: no key of the page reaches the wire.
test("whatever the call, it goes to the section's server with nothing of the page's: no key, no `server`, no `collapsed`, no `replace`, no `local`", async () => {
  answer = (path) => (path.endsWith("/scene") ? json({}, 200, { "X-AIWB-Scene-Rev": "1" }) : json({ rev: 1, state: "free", id: "x", name: "n", group: "g_1", created: "", status: "draft", version: 1, items: [] }));
  const draft = { text: "@B", mentions: [{ name: "B", id: a("b_1") }] };
  const all: Promise<unknown>[] = [
    api.newGroup(A, "n", a("g_1")), api.renameGroup(a("g_1"), "n"), api.moveGroup(a("g_1"), a("g_2"), a("g_3")), api.archive("groups", a("g_1")), api.unarchive("groups", a("g_1")), api.deleteGroup(a("g_1"), "delete"),
    api.newBoard(a("g_1"), "n", true), api.scene(a("b_1")), api.saveScene(a("b_1"), 1, {}), api.takeBoard(a("b_1")), api.releaseBoard(a("b_1")), api.renameBoard(a("b_1"), "n"), api.moveBoard(a("b_1"), a("g_1")),
    api.seenBoard(a("b_1")), api.deleteBoard(a("b_1")), api.archive("boards", a("b_1")), api.unarchive("boards", a("b_1")),
    api.newChat({ group: a("g_1") }), api.newChat({ board: a("b_1") }), api.chat(a("c_1")), api.items(a("c_1"), "main"), api.subItems(a("c_1"), "main", "sa"), api.tree(a("c_1")),
    api.openChat(a("c_1"), "main"), api.send(a("c_1"), "main", "t", "ctx"), api.configure(a("c_1"), "main", { cwd: "/w" }), api.saveDraft(a("c_1"), "main", draft, 1), api.renameChat(a("c_1"), "n"),
    api.moveChat(a("c_1"), a("g_1")), api.interrupt(a("c_1"), "main"), api.deleteChat(a("c_1")), api.setLabel(a("c_1"), "main", 1, "l"), api.fork(a("c_1"), "main", 1), api.contextSplit(a("c_1"), "main"),
    api.archive("chats", a("c_1")), api.unarchive("chats", a("c_1")),
  ];
  await Promise.allSettled(all);
  assert.equal(calls.length, all.length);
  for (const c of calls) {
    assert.equal(c.server, A, `${c.method} ${c.path} goes to the section's server`);
    assert.ok(c.path.startsWith(`${ON}/`) && !c.path.includes("/api/on/"), `${c.method} ${c.path} is a path of the client API`);
    const rest = c.path.slice(ON.length), body = JSON.stringify(c.body ?? null);
    assert.equal(rest.includes("~") || rest.includes(A), false, `${c.method} ${c.path} has a key in its path`);
    assert.equal(body.includes("~") || body.includes(A), false, `${c.method} ${c.path} has a key in its body: ${body}`);
    for (const word of ["replace=", "local=", "server="]) assert.equal(rest.includes(word), false, `${c.method} ${c.path}`);
    if (c.body && typeof c.body === "object") for (const key of ["server", "collapsed"]) assert.equal(key in (c.body as object), false, `${c.method} ${c.path} sends "${key}"`);
  }
});
