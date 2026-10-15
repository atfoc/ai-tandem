// The calls of src/api.ts through a fake transport. The body api.send posts: the point a message goes to,
// and the model and effort of the new branch, are in it as the server reads them. What a refusal becomes: an
// ApiError, with a sentence and a code. And the server, the path and the body of every call for a thing of a
// section: the entry id is the call's server, and every id in the path and in the body is that server's own.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api } from "../src/api.ts";
import { installFake, ok, refuse, rawAnswer, type Seen } from "./fixtures/faketransport.ts";

const fake = installFake();
const calls = fake.calls;
const accepted = () => ok({ ok: true, branch: "0f0f0f0f" });
beforeEach(() => { fake.reset(); fake.handler = accepted; fake.appHandler = () => undefined; });

test("api.send: a target with a model and an effort is posted whole, and the branch is not in the query", async () => {
  const answer = await api.send("c_1", "main", "hi", "ctx", [], { branch: "main", at: 3, new: true, model: "x", effort: "low" });
  assert.deepEqual(answer, { ok: true, branch: "0f0f0f0f" });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].server, calls[0].path, calls[0].method], ["local", "/api/chats/c_1/messages", "POST"]);
  assert.deepEqual(calls[0].body, { text: "hi", context: "ctx", target: { branch: "main", at: 3, new: true, model: "x", effort: "low" } });
});

test("api.send: a target with a model alone is posted without an effort", async () => {
  await api.send("c_1", "main", "hi", "", [], { branch: "main", at: 3, new: true, model: "y" });
  assert.deepEqual(calls[0].body, { text: "hi", context: "", target: { branch: "main", at: 3, new: true, model: "y" } });
});

test("api.send: a target without a choice is posted as the point alone", async () => {
  await api.send("c_1", "ab12cd34", "hi", "", [], { branch: "ab12cd34", at: 0, new: false });
  assert.equal(calls[0].path, "/api/chats/c_1/messages");
  assert.deepEqual(calls[0].body, { text: "hi", context: "", target: { branch: "ab12cd34", at: 0, new: false } });
});

test("api.send: without a target the body has none, and the branch is named in the query", async () => {
  const quote = { item: 1, text: "q" };
  await api.send("c_1", "ab 12", "hi", "ctx", [quote] as never);
  assert.equal(calls[0].path, "/api/chats/c_1/messages?branch=ab%2012");
  assert.deepEqual(calls[0].body, { text: "hi", context: "ctx", references: [quote] });
  assert.equal("target" in (calls[0].body as object), false);
  await api.send("c_1", "main", "hi", "ctx");
  assert.deepEqual(calls[1].body, { text: "hi", context: "ctx" }); // no quotes: no references key
});

test("api.send always names the branch of a message without a target, the first one of a section's chat too", async () => {
  await api.send("s_1~c_1", "main", "hi", "");
  assert.deepEqual([calls[0].server, calls[0].path, calls[0].method, calls[0].body], ["s_1", "/api/chats/c_1/messages?branch=main", "POST", { text: "hi", context: "" }]);
  await api.send("c_1", "main", "hi", "");
  assert.deepEqual([calls[1].server, calls[1].path, calls[1].body], ["local", "/api/chats/c_1/messages?branch=main", { text: "hi", context: "" }]);
  // with a target the branch is in the body alone, there as here
  await api.send("s_1~c_1", "main", "hi", "", [], { branch: "main", at: 3, new: true });
  assert.deepEqual([calls[2].server, calls[2].path, calls[2].body], ["s_1", "/api/chats/c_1/messages", { text: "hi", context: "", target: { branch: "main", at: 3, new: true } }]);
});

// ---- what a refusal becomes

const refusal = (status: number, body: unknown) => () => refuse(status, body as Record<string, unknown>);
const refused = async (): Promise<ApiError> => {
  try { await api.send("c_1", "main", "hi", ""); } catch (e) { assert.ok(e instanceof ApiError); return e; }
  throw new Error("the send was not refused");
};

test("a refusal keeps the server's sentence and code; one without a sentence has the status in its words", async () => {
  fake.handler = refusal(409, { error: "the agent is working", code: "busy" });
  let e = await refused();
  assert.deepEqual([e.status, e.code, e.message, e.said], [409, "busy", "the agent is working", true]);
  fake.handler = refusal(409, { error: "unknown_client" }); // (the word of the guard that is gone is a sentence like another)
  e = await refused();
  assert.deepEqual([e.status, e.code, e.message, e.said], [409, undefined, "unknown_client", true]);
  fake.handler = refusal(409, { error: "the draft was changed elsewhere", code: "stale", rev: 4, draft: null });
  e = await refused();
  assert.deepEqual([e.code, e.rev, e.draft], ["stale", 4, null]);
  fake.handler = () => rawAnswer(413, "<html>too big</html>");
  e = await refused();
  assert.deepEqual([e.status, e.said, e.message], [413, false, "The server answered 413."]);
  fake.handler = () => rawAnswer(502, "");
  e = await refused();
  assert.deepEqual([e.status, e.said, e.message], [502, false, "The server answered 502."]);
});

test("a refused Send that names images the chat lacks has them in the error", async () => {
  fake.handler = refusal(409, { error: "images are gone", code: "image_missing", images: ["a1", 5, "b2"] });
  assert.deepEqual((await refused()).images, ["a1", "b2"]);
});

test("a call answered with no body, or 204, gives undefined; one with JSON gives it parsed", async () => {
  fake.handler = () => rawAnswer(204, "");
  assert.equal(await api.deleteChat("c_1"), undefined);
  fake.handler = () => ok({ labels: [] });
  assert.deepEqual(await api.setLabel("c_1", "main", 1, "x"), { labels: [] });
});

test("a way that failed is no refusal: the transport's error comes as it is", async () => {
  fake.handler = () => { throw new Error("the app did not answer"); };
  await assert.rejects(() => api.deleteChat("c_1"), (e: unknown) => !(e instanceof ApiError) && (e as Error).message === "the app did not answer");
});

test("api.deleteChat and deleteBoard have no query: there is no record to remove from this sidebar only", async () => {
  await api.deleteChat("s_1~c_1");
  await api.deleteBoard("s_1~b_1");
  assert.deepEqual(calls.map((c) => [c.server, c.path, c.method, c.body]), [
    ["s_1", "/api/chats/c_1", "DELETE", undefined], ["s_1", "/api/boards/b_1", "DELETE", undefined],
  ]);
  // (a second argument is not read: no call can ask for ?local=1)
  calls.length = 0;
  await (api.deleteBoard as (id: string, o?: unknown) => Promise<unknown>)("b_1", true);
  assert.equal(calls[0].path, "/api/boards/b_1");
  assert.deepEqual([api.deleteChat.length, api.deleteBoard.length], [1, 1]);
});

// ---- a thing of a section: the entry id is the call's server, and every id in a path or a body is that server's own

/** Every method of the api with the page's keys of things of the section s_1, and the request it makes. The same call
 *  for a thing of this computer is the same request to the server "local" (the test after this one). */
const png = new Blob(["x"], { type: "image/png" });
const SECTION: Record<keyof typeof api, [args: unknown[], method: string, path: string, body?: unknown] | null> = {
  // about no thing of a server
  flushed: null, rpcReply: null, dirs: null, usage: null,
  reveal: null, // an owner's thing of the app, for a board of this computer: no call
  newGroup: [["s_1", "Shop", "s_1~g_1"], "POST", "/api/groups", { name: "Shop", parent: "g_1" }],
  renameGroup: [["s_1~g_1", "Shop"], "PATCH", "/api/groups/g_1", { name: "Shop" }],
  moveGroup: [["s_1~g_2", "s_1~g_1", "s_1~g_3"], "POST", "/api/groups/g_2/move", { parent: "g_1", before: "g_3" }],
  archive: [["chats", "s_1~c_1"], "POST", "/api/chats/c_1/archive"],
  unarchive: [["groups", "s_1~g_1"], "POST", "/api/groups/g_1/unarchive"],
  deleteGroup: [["s_1~g_1", "delete"], "DELETE", "/api/groups/g_1?contents=delete"],
  newBoard: [["s_1~g_1", "Plan", true], "POST", "/api/boards", { name: "Plan", group: "g_1", new: true }],
  scene: [["s_1~b_1"], "GET", "/api/boards/b_1/scene"],
  saveScene: [["s_1~b_1", 4, { elements: [] }], "PUT", "/api/boards/b_1/scene?rev=4", { elements: [] }],
  takeBoard: [["s_1~b_1", true], "POST", "/api/boards/b_1/take", { ifFree: true }],
  releaseBoard: [["s_1~b_1"], "POST", "/api/boards/b_1/release"],
  renameBoard: [["s_1~b_1", "Plan B"], "POST", "/api/boards/b_1/rename", { name: "Plan B" }],
  moveBoard: [["s_1~b_1", "s_1~g_1"], "PATCH", "/api/boards/b_1", { group: "g_1" }],
  seenBoard: [["s_1~b_1"], "POST", "/api/boards/b_1/seen"],
  deleteBoard: [["s_1~b_1"], "DELETE", "/api/boards/b_1"],
  newChat: [[{ board: "s_1~b_1" }], "POST", "/api/chats", { board: "b_1" }],
  items: [["s_1~c_1", "main"], "GET", "/api/chats/c_1/items?branch=main"],
  subItems: [["s_1~c_1", "main", "5f"], "GET", "/api/chats/c_1/subagents/5f/items?branch=main"],
  chat: [["s_1~c_1"], "GET", "/api/chats/c_1"],
  openChat: [["s_1~c_1", "main"], "POST", "/api/chats/c_1/open?branch=main"],
  send: [["s_1~c_1", "main", "hi", "ctx"], "POST", "/api/chats/c_1/messages?branch=main", { text: "hi", context: "ctx" }],
  configure: [["s_1~c_1", "main", { agent: "pi" }], "PATCH", "/api/chats/c_1?branch=main", { agent: "pi" }],
  saveDraft: [["s_1~c_1", "main", { text: "see @Plan", mentions: [{ name: "Plan", id: "s_1~b_1" }] }, 3], "PUT", "/api/chats/c_1/draft?branch=main&rev=3", { text: "see @Plan", mentions: [{ name: "Plan", id: "b_1" }] }],
  uploadImage: [["s_1~c_1", png, "a b.png", "image/png"], "POST", "/api/chats/c_1/images?name=a%20b.png", "<1 bytes>"],
  renameChat: [["s_1~c_1", "Notes"], "PATCH", "/api/chats/c_1", { name: "Notes" }],
  moveChat: [["s_1~c_1", "s_1~g_1"], "PATCH", "/api/chats/c_1", { group: "g_1" }],
  interrupt: [["s_1~c_1", "main"], "POST", "/api/chats/c_1/interrupt?branch=main"],
  decide: [["s_1~c_1", "main", { requestId: "p1", allow: true }], "POST", "/api/chats/c_1/permission?branch=main", { requestId: "p1", allow: true }],
  deleteChat: [["s_1~c_1"], "DELETE", "/api/chats/c_1"],
  tree: [["s_1~c_1"], "GET", "/api/chats/c_1/tree"],
  setLabel: [["s_1~c_1", "main", 2, "here"], "PUT", "/api/chats/c_1/label", { branch: "main", item: 2, text: "here" }],
  fork: [["s_1~c_1", "main", 3, 2], "POST", "/api/chats/c_1/fork", { branch: "main", at: 3, message: 2 }],
  contextSplit: [["s_1~c_1", "main", true], "GET", "/api/chats/c_1/context?branch=main&fresh=1"],
};

const request = async (name: string, args: unknown[]): Promise<[string, string, string, unknown]> => {
  calls.length = 0;
  await Promise.resolve().then(() => (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args)).catch(() => {}); // (what a method makes of the stub's answer is not the point)
  assert.equal(calls.length, 1, `${name} makes one request`);
  return [calls[0].server, calls[0].method, calls[0].path, calls[0].body];
};

test("every call about a thing of a section goes to that entry's server, with that server's own ids in the path and in the body", async () => {
  assert.deepEqual(Object.keys(SECTION).sort(), Object.keys(api).sort(), "every method of the api is looked at");
  for (const [name, want] of Object.entries(SECTION)) {
    if (!want) continue;
    const [args, method, path, body] = want;
    const got = await request(name, args);
    assert.deepEqual(got, ["s_1", method, path, body], name);
    assert.ok(!JSON.stringify(got.slice(1)).includes("~"), `${name}: no key of the page is on the wire`);
    assert.ok(!path.includes("/api/on/") && path.startsWith("/api/"), `${name}: the server is no part of the path`);
  }
});

/** A value with every key of the section s_1 in it made the key of the thing of this computer with the same id. */
const here = (v: unknown): unknown =>
  v instanceof Blob ? v : typeof v === "string" ? (v === "s_1" ? "local" : v.replace(/^s_1~/, "")) : Array.isArray(v) ? v.map(here)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, here(x)])) : v;

test("the same call for the thing of this computer with the same id is the same request to the server \"local\": method, path and body", async () => {
  for (const [name, want] of Object.entries(SECTION)) {
    if (!want) continue;
    const [args, method, path, body] = want;
    assert.deepEqual(await request(name, args.map(here)), ["local", method, path, body], name);
  }
});

test("the entry id is the call's server: another section's call goes to that entry, and this computer's is `local`", async () => {
  assert.deepEqual(await request("chat", ["s_2~c_1"]), ["s_2", "GET", "/api/chats/c_1", undefined]);
  assert.deepEqual(await request("chat", ["s_0123456789ab~3f9a1c2b-77de-4f00-9a1c-2b77de4f009a"]), ["s_0123456789ab", "GET", "/api/chats/3f9a1c2b-77de-4f00-9a1c-2b77de4f009a", undefined]);
  assert.deepEqual(await request("newGroup", ["local", "Shop"]), ["local", "POST", "/api/groups", { name: "Shop" }]);
  assert.deepEqual(await request("newGroup", ["s_1", "Shop"]), ["s_1", "POST", "/api/groups", { name: "Shop" }], "at the top level of the section: no parent");
  assert.deepEqual(await request("newGroup", ["s_1"]), ["s_1", "POST", "/api/groups", {}]);
  assert.deepEqual(await request("moveGroup", ["s_1~g_2", ""]), ["s_1", "POST", "/api/groups/g_2/move", { parent: "", before: "" }], "to the top level, last");
  assert.deepEqual(await request("newBoard", ["s_1~__ungrouped__"]), ["s_1", "POST", "/api/boards", { group: "__ungrouped__", new: false }], "outside any group, from the section's head");
  assert.deepEqual(await request("newChat", [{ group: "s_1~__ungrouped__" }]), ["s_1", "POST", "/api/chats", { group: "__ungrouped__" }]);
});

test("no call of a group sends `collapsed`: whether a group shows collapsed is the page's own, for this computer's groups too", async () => {
  assert.equal("collapseGroup" in api, false);
  await api.renameGroup("s_1~g_1", "Shop");
  await api.renameGroup("g_1", "Shop");
  await api.newGroup("s_1", "Shop", "s_1~g_1");
  await api.moveGroup("s_1~g_1", "");
  for (const c of calls) assert.ok(!("collapsed" in (c.body as object)), c.path);
});

test("the two calls that are about no thing of a server go to the server asked, this computer's by default", async () => {
  assert.deepEqual(await request("dirs", ["/home/u/my work", "s_1"]), ["s_1", "GET", "/api/dirs?path=%2Fhome%2Fu%2Fmy%20work", undefined]);
  assert.deepEqual(await request("dirs", ["/x"]), ["local", "GET", "/api/dirs?path=%2Fx", undefined]);
  assert.deepEqual(await request("dirs", ["/x", "local"]), ["local", "GET", "/api/dirs?path=%2Fx", undefined]);
  assert.deepEqual(await request("usage", ["claude", false, "s_1"]), ["s_1", "GET", "/api/usage/claude", undefined]);
  assert.deepEqual(await request("usage", ["claude", true, "s_1"]), ["s_1", "GET", "/api/usage/claude?fresh=1", undefined]);
  assert.deepEqual(await request("usage", ["claude", true]), ["local", "GET", "/api/usage/claude?fresh=1", undefined]);
  assert.deepEqual(await request("usage", ["claude", false, "local"]), ["local", "GET", "/api/usage/claude", undefined]);
});

test("the answer of a board tool call and the flush go to the server whose event they answer, this computer's by default", async () => {
  assert.deepEqual(await request("rpcReply", ["far_7", { result: { ok: 1 } }]), ["local", "POST", "/api/rpc-reply", { id: "far_7", result: { ok: 1 } }]);
  assert.deepEqual(await request("rpcReply", ["far_7", { error: "x" }, "s_1"]), ["s_1", "POST", "/api/rpc-reply", { id: "far_7", error: "x" }]);
  assert.deepEqual(await request("flushed", []), ["local", "POST", "/api/client/flushed", undefined]);
  assert.deepEqual(await request("flushed", ["s_1"]), ["s_1", "POST", "/api/client/flushed", undefined]);
});

test("a board's scene read gives its revision from the answer, 0 for none; a save keeps the call's own keepalive and signal", async () => {
  fake.handler = () => ok({ elements: [] }, 200, 7);
  assert.deepEqual(await api.scene("b_1"), { scene: { elements: [] }, rev: 7 });
  fake.handler = () => ok({ elements: [] });
  assert.equal((await api.scene("b_1")).rev, 0);
  fake.handler = () => ok({ rev: 3 });
  assert.equal(await api.saveScene("b_1", 2, {}), 3);
  fake.reset();
  fake.handler = accepted;
  await api.saveDraft("c_1", "main", { text: "x" }, 1, true);
  assert.equal(calls[0].keepalive, true);
  const ac = new AbortController();
  await api.uploadImage("c_1", png, "a.png", "image/png", ac.signal);
  assert.equal(calls[1].signal, ac.signal);
  assert.deepEqual([calls[1].type, calls[1].body], ["image/png", "<1 bytes>"]);
});

test("api.reveal is an owner's thing of the app: `owner.reveal` with the board's own id, for a board of this computer; none for a section's", async () => {
  fake.reset();
  await api.reveal("b_1");
  assert.deepEqual(fake.apps, [{ op: "owner.reveal", args: { board: "b_1" } }]);
  assert.equal(calls.length, 0, "no call to a server");
  await assert.rejects(() => api.reveal("s_1~b_1"), (e: unknown) => e instanceof ApiError && e.code === "not_here");
  assert.equal(fake.apps.length, 1);
  fake.appHandler = () => ({ status: 404, text: JSON.stringify({ error: "That board's file is not there.", code: "not_found" }) });
  await assert.rejects(() => api.reveal("b_1"), (e: unknown) => e instanceof ApiError && e.status === 404 && e.code === "not_found");
});

test("what a section's call answers gets the page's keys before it is handed on", async () => {
  const json = (v: unknown) => () => ok(v);
  fake.handler = json({ id: "g_9", name: "Shop", parent: "g_1" });
  assert.deepEqual(await api.newGroup("s_1", "Shop", "s_1~g_1"), { id: "s_1~g_9", name: "Shop", parent: "s_1~g_1" });
  assert.deepEqual(await api.newGroup("local", "Shop", "g_1"), { id: "g_9", name: "Shop", parent: "g_1" });
  fake.handler = json({ id: "b_9", name: "Plan", group: "g_1", created: "t" });
  assert.deepEqual(await api.newBoard("s_1~g_1", "Plan"), { id: "s_1~b_9", name: "Plan", group: "s_1~g_1", created: "t" });
  assert.deepEqual(await api.renameBoard("s_1~b_9", "Plan"), { id: "s_1~b_9", name: "Plan", group: "s_1~g_1", created: "t" });
  assert.deepEqual(await api.newBoard("g_1", "Plan"), { id: "b_9", name: "Plan", group: "g_1", created: "t" });
  fake.handler = json({ id: "c_9", agent: "pi", group: "g_1", board: "b_1", forkedFrom: "c_1", draft: { text: "@Plan", mentions: [{ name: "Plan", id: "b_1" }] } });
  const chat = { id: "s_1~c_9", agent: "pi", group: "s_1~g_1", board: "s_1~b_1", forkedFrom: "s_1~c_1", draft: { text: "@Plan", mentions: [{ name: "Plan", id: "s_1~b_1" }] } };
  assert.deepEqual(await api.chat("s_1~c_9"), chat);
  assert.deepEqual(await api.fork("s_1~c_1", "main", 3), chat);
  fake.handler = json({ ok: true, chat: { id: "c_9", agent: "pi", group: "g_1" } });
  assert.deepEqual(await api.configure("s_1~c_9", "main", { agent: "pi" }), { ok: true, chat: { id: "s_1~c_9", agent: "pi", group: "s_1~g_1" } });
  assert.deepEqual(await api.configure("c_9", "main", { agent: "pi" }), { ok: true, chat: { id: "c_9", agent: "pi", group: "g_1" } });
  fake.handler = json({ version: 4, items: [], branch: "main", state: { chat: "c_9", branch: "main", status: "ready" } });
  assert.deepEqual(await api.items("s_1~c_9", "main"), { version: 4, items: [], branch: "main", state: { chat: "s_1~c_9", branch: "main", status: "ready" } });
});

test("a section's draft refused as stale: the server's draft in the error has the page's keys", async () => {
  fake.handler = refusal(409, { error: "the draft was changed elsewhere", code: "stale", rev: 7, draft: { text: "@Plan", mentions: [{ name: "Plan", id: "b_1" }] } });
  await assert.rejects(() => api.saveDraft("s_1~c_1", "main", { text: "mine" }, 3), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.deepEqual([e.status, e.code, e.rev, e.draft], [409, "stale", 7, { text: "@Plan", mentions: [{ name: "Plan", id: "s_1~b_1" }] }]);
    return true;
  });
  await assert.rejects(() => api.saveDraft("c_1", "main", { text: "mine" }, 3), (e: unknown) => {
    assert.deepEqual((e as ApiError).draft, { text: "@Plan", mentions: [{ name: "Plan", id: "b_1" }] });
    return true;
  });
});

test("a refusal of a section's call keeps the status, the sentence and the code the app answered", async () => {
  for (const [status, code, said] of [[503, "server_unreachable", "Studio is not connected."], [404, "not_found", "chat not found"], [404, "no_server", "This server is not in the list."],
    [504, "no_answer", "Studio did not answer."], [502, "bad_answer", "Studio gave an answer that cannot be read."], [504, "send_unknown", "Studio did not answer."]] as const) {
    fake.handler = refusal(status, { error: said, code });
    await assert.rejects(() => api.send("s_1~c_1", "main", "hi", ""), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual([e.status, e.code, e.message, e.said], [status, code, said, true]);
      return true;
    });
  }
});

// ---- what a call is made of

/** What a method is called with when four strings are not what it takes. */
const ARGS: Record<string, unknown[]> = { newChat: [{ group: "a" }], newGroup: ["local", "b", "c"] }; // (a group is made on a server, in a parent of that server)

test("a call is a server, a method, a path and a body: no client id or header of the page's goes with it", async () => {
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await Promise.resolve().then(() => method(...(ARGS[name] ?? ["a", "b", "c", "d"]))).catch(() => {});
    for (const c of calls) assert.deepEqual(Object.keys(c).filter((k) => !["server", "method", "path", "body", "type", "keepalive", "signal"].includes(k)), [], name);
  }
});

test("every api method makes the one call it is for, with a method and a path of the client API (reveal: none)", async () => {
  const seen: Seen[] = [];
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await Promise.resolve().then(() => method(...(ARGS[name] ?? ["a", "b", "c", "d"]))).catch(() => {}); // (what a method makes of the stub's answer is not the point)
    if (name === "reveal") continue;
    assert.equal(calls.length, 1, `${name} makes one request`);
    assert.ok(calls[0].method && calls[0].path.startsWith("/api/") && !calls[0].path.includes("/api/on/"), `${name}: ${calls[0].method} ${calls[0].path}`);
    seen.push(calls[0]);
  }
  assert.ok(seen.filter((c) => c.method !== "GET").length >= 25);
  // a read and the writes of one URL: a chat's view, its Delete and its change
  for (const pair of ["GET /api/chats/a", "DELETE /api/chats/a", "PATCH /api/chats/a"]) assert.ok(seen.some((c) => `${c.method} ${c.path.split("?")[0]}` === pair), pair);
});
