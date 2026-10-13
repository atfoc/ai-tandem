// The calls of src/api.ts with a stubbed global fetch. The body api.send posts: the point a message goes to,
// and the model and effort of the new branch, are in it as the server reads them. What a refusal becomes: an
// ApiError, with a sentence and a hook for `unknown_client`. And the path and the body of every call for a
// thing of a section: under /api/on/<entry id>/, with that server's own ids.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api, clientId } from "../src/api.ts";
import { UNKNOWN_CLIENT, onUnknownClient, streamGone } from "../src/logic/unknownclient.ts";

type Call = { path: string; method?: string; headers?: Record<string, string>; body: unknown; cache?: RequestCache };
const calls: Call[] = [];
const accepted = () => new Response(JSON.stringify({ ok: true, branch: "0f0f0f0f" }), { status: 200 });
let answer: () => Response = accepted;
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  const body = init.body === undefined ? undefined : init.body instanceof Blob ? `<${init.body.size} bytes>` : JSON.parse(init.body as string);
  calls.push({ path, method: init.method, headers: init.headers as Record<string, string>, body, cache: init.cache });
  return answer();
}) as typeof fetch;
beforeEach(() => { calls.length = 0; answer = accepted; });

test("api.send: a target with a model and an effort is posted whole, and the branch is not in the query", async () => {
  const answer = await api.send("c_1", "main", "hi", "ctx", [], { branch: "main", at: 3, new: true, model: "x", effort: "low" });
  assert.deepEqual(answer, { ok: true, branch: "0f0f0f0f" });
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].path, calls[0].method], ["/api/chats/c_1/messages", "POST"]);
  assert.deepEqual(calls[0].headers, { "Content-Type": "application/json", "X-AIWB-Client": clientId });
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
  assert.deepEqual([calls[0].path, calls[0].method, calls[0].body], ["/api/on/s_1/chats/c_1/messages?branch=main", "POST", { text: "hi", context: "" }]);
  await api.send("c_1", "main", "hi", "");
  assert.deepEqual([calls[1].path, calls[1].body], ["/api/chats/c_1/messages?branch=main", { text: "hi", context: "" }]);
  // with a target the branch is in the body alone, there as here
  await api.send("s_1~c_1", "main", "hi", "", [], { branch: "main", at: 3, new: true });
  assert.deepEqual([calls[2].path, calls[2].body], ["/api/on/s_1/chats/c_1/messages", { text: "hi", context: "", target: { branch: "main", at: 3, new: true } }]);
});

// ---- a write refused as `unknown_client`: the server has no open event stream of this page

const refusal = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status });
const refused = async (): Promise<ApiError> => {
  try { await api.send("c_1", "main", "hi", ""); } catch (e) { assert.ok(e instanceof ApiError); return e; }
  throw new Error("the send was not refused");
};

test("a 409 unknown_client calls the hook, and its error is a sentence for the user with the code", async () => {
  let told = 0;
  onUnknownClient(() => { told++; });
  try {
    answer = refusal(409, { error: "unknown_client" });
    const e = await refused();
    assert.equal(told, 1);
    assert.deepEqual([e.status, e.code, e.message, e.said], [409, "unknown_client", UNKNOWN_CLIENT, false]);
    assert.ok(!/unknown_client/.test(e.message) && /interrupted/.test(e.message));
  } finally { onUnknownClient(() => {}); }
});

test("another refusal calls no hook and keeps the server's sentence and code", async () => {
  let told = 0;
  onUnknownClient(() => { told++; });
  try {
    answer = refusal(409, { error: "the agent is working", code: "busy" });
    let e = await refused();
    assert.deepEqual([e.status, e.code, e.message, e.said], [409, "busy", "the agent is working", true]);
    answer = refusal(403, { error: "unknown_client" }); // the word under another status is not the guard's
    e = await refused();
    assert.deepEqual([e.status, e.code, e.message], [403, undefined, "unknown_client"]);
    answer = refusal(409, { error: "the draft was changed elsewhere", code: "stale", rev: 4, draft: null });
    e = await refused();
    assert.deepEqual([e.code, e.rev, e.draft], ["stale", 4, null]);
    assert.equal(told, 0);
  } finally { onUnknownClient(() => {}); }
});

test("streamGone: only a stream the browser closed for good is opened again", () => {
  assert.equal(streamGone({ readyState: 2 }), true);  // CLOSED
  assert.equal(streamGone({ readyState: 0 }), false); // CONNECTING: the browser reconnects by itself
  assert.equal(streamGone({ readyState: 1 }), false); // OPEN: the server's greeting is on its way
  assert.equal(streamGone(null), false);              // never connected
});

test("api.deleteChat and deleteBoard have no query: there is no record to remove from this sidebar only", async () => {
  await api.deleteChat("s_1~c_1");
  await api.deleteBoard("s_1~b_1");
  assert.deepEqual(calls.map((c) => [c.path, c.method, c.body]), [
    ["/api/on/s_1/chats/c_1", "DELETE", undefined], ["/api/on/s_1/boards/b_1", "DELETE", undefined],
  ]);
  // (a second argument is not read: no call can ask for ?local=1)
  calls.length = 0;
  await (api.deleteBoard as (id: string, o?: unknown) => Promise<unknown>)("b_1", true);
  assert.equal(calls[0].path, "/api/boards/b_1");
  assert.deepEqual([api.deleteChat.length, api.deleteBoard.length], [1, 1]);
});

// ---- a thing of a section: the entry id is the path segment after /api/on/, and every id in a path or a body is that server's own

/** Every method of the api with the page's keys of things of the section s_1, and the request it makes. The same call
 *  for a thing of this computer is the same request under /api (the test after this one). */
const png = new Blob(["x"], { type: "image/png" });
const SECTION: Record<keyof typeof api, [args: unknown[], method: string, path: string, body?: unknown] | null> = {
  // about no thing of a server
  state: null, hello: null, restart: null, flushed: null, rpcReply: null, dirs: null, usage: null,
  collapseGroup: null, // never sent for a section's group
  newGroup: [["s_1", "Shop", "s_1~g_1"], "POST", "/api/on/s_1/groups", { name: "Shop", parent: "g_1" }],
  renameGroup: [["s_1~g_1", "Shop"], "PATCH", "/api/on/s_1/groups/g_1", { name: "Shop" }],
  moveGroup: [["s_1~g_2", "s_1~g_1", "s_1~g_3"], "POST", "/api/on/s_1/groups/g_2/move", { parent: "g_1", before: "g_3" }],
  archive: [["chats", "s_1~c_1"], "POST", "/api/on/s_1/chats/c_1/archive"],
  unarchive: [["groups", "s_1~g_1"], "POST", "/api/on/s_1/groups/g_1/unarchive"],
  deleteGroup: [["s_1~g_1", "delete"], "DELETE", "/api/on/s_1/groups/g_1?contents=delete"],
  newBoard: [["s_1~g_1", "Plan", true], "POST", "/api/on/s_1/boards", { name: "Plan", group: "g_1", new: true }],
  scene: [["s_1~b_1"], "GET", "/api/on/s_1/boards/b_1/scene"],
  saveScene: [["s_1~b_1", 4, { elements: [] }], "PUT", "/api/on/s_1/boards/b_1/scene?rev=4", { elements: [] }],
  takeBoard: [["s_1~b_1", true], "POST", "/api/on/s_1/boards/b_1/take", { ifFree: true }],
  releaseBoard: [["s_1~b_1"], "POST", "/api/on/s_1/boards/b_1/release"],
  renameBoard: [["s_1~b_1", "Plan B"], "POST", "/api/on/s_1/boards/b_1/rename", { name: "Plan B" }],
  moveBoard: [["s_1~b_1", "s_1~g_1"], "PATCH", "/api/on/s_1/boards/b_1", { group: "g_1" }],
  seenBoard: [["s_1~b_1"], "POST", "/api/on/s_1/boards/b_1/seen"],
  deleteBoard: [["s_1~b_1"], "DELETE", "/api/on/s_1/boards/b_1"],
  reveal: [["s_1~b_1"], "POST", "/api/on/s_1/boards/b_1/reveal"],
  newChat: [[{ board: "s_1~b_1" }], "POST", "/api/on/s_1/chats", { board: "b_1" }],
  items: [["s_1~c_1", "main"], "GET", "/api/on/s_1/chats/c_1/items?branch=main"],
  subItems: [["s_1~c_1", "main", "5f"], "GET", "/api/on/s_1/chats/c_1/subagents/5f/items?branch=main"],
  chat: [["s_1~c_1"], "GET", "/api/on/s_1/chats/c_1"],
  openChat: [["s_1~c_1", "main"], "POST", "/api/on/s_1/chats/c_1/open?branch=main"],
  send: [["s_1~c_1", "main", "hi", "ctx"], "POST", "/api/on/s_1/chats/c_1/messages?branch=main", { text: "hi", context: "ctx" }],
  configure: [["s_1~c_1", "main", { agent: "pi" }], "PATCH", "/api/on/s_1/chats/c_1?branch=main", { agent: "pi" }],
  saveDraft: [["s_1~c_1", "main", { text: "see @Plan", mentions: [{ name: "Plan", id: "s_1~b_1" }] }, 3], "PUT", "/api/on/s_1/chats/c_1/draft?branch=main&rev=3", { text: "see @Plan", mentions: [{ name: "Plan", id: "b_1" }] }],
  uploadImage: [["s_1~c_1", png, "a b.png", "image/png"], "POST", "/api/on/s_1/chats/c_1/images?name=a%20b.png", "<1 bytes>"],
  renameChat: [["s_1~c_1", "Notes"], "PATCH", "/api/on/s_1/chats/c_1", { name: "Notes" }],
  moveChat: [["s_1~c_1", "s_1~g_1"], "PATCH", "/api/on/s_1/chats/c_1", { group: "g_1" }],
  interrupt: [["s_1~c_1", "main"], "POST", "/api/on/s_1/chats/c_1/interrupt?branch=main"],
  decide: [["s_1~c_1", "main", { requestId: "p1", allow: true }], "POST", "/api/on/s_1/chats/c_1/permission?branch=main", { requestId: "p1", allow: true }],
  deleteChat: [["s_1~c_1"], "DELETE", "/api/on/s_1/chats/c_1"],
  tree: [["s_1~c_1"], "GET", "/api/on/s_1/chats/c_1/tree"],
  setLabel: [["s_1~c_1", "main", 2, "here"], "PUT", "/api/on/s_1/chats/c_1/label", { branch: "main", item: 2, text: "here" }],
  fork: [["s_1~c_1", "main", 3, 2], "POST", "/api/on/s_1/chats/c_1/fork", { branch: "main", at: 3, message: 2 }],
  contextSplit: [["s_1~c_1", "main", true], "GET", "/api/on/s_1/chats/c_1/context?branch=main&fresh=1"],
};

const request = async (name: string, args: unknown[]) => {
  calls.length = 0;
  await Promise.resolve().then(() => (api as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[name](...args)).catch(() => {}); // (what a method makes of the stub's answer is not the point)
  assert.equal(calls.length, 1, `${name} makes one request`);
  return [calls[0].method, calls[0].path, calls[0].body];
};

test("every call about a thing of a section goes under /api/on/<entry id>/, with that server's own ids in the path and in the body", async () => {
  assert.deepEqual(Object.keys(SECTION).sort(), Object.keys(api).sort(), "every method of the api is looked at");
  for (const [name, want] of Object.entries(SECTION)) {
    if (!want) continue;
    const [args, method, path, body] = want;
    const got = await request(name, args);
    assert.deepEqual(got, [method, path, body], name);
    assert.ok(path.startsWith("/api/on/s_1/"), name);
    assert.ok(!JSON.stringify(got).includes("~"), `${name}: no key of the page is on the wire`);
  }
});

/** A value with every key of the section s_1 in it made the key of the thing of this computer with the same id. */
const here = (v: unknown): unknown =>
  v instanceof Blob ? v : typeof v === "string" ? (v === "s_1" ? "local" : v.replace(/^s_1~/, "")) : Array.isArray(v) ? v.map(here)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, here(x)])) : v;

test("the same call for the thing of this computer with the same id is the same request under /api: method, the rest of the path, query and body", async () => {
  for (const [name, want] of Object.entries(SECTION)) {
    if (!want) continue;
    const [args, method, path, body] = want;
    assert.deepEqual(await request(name, args.map(here)), [method, path.replace("/api/on/s_1/", "/api/"), body], name);
  }
});

test("the entry id is the path's own segment: another section's call goes to that entry, and `local` is never a segment", async () => {
  assert.deepEqual(await request("chat", ["s_2~c_1"]), ["GET", "/api/on/s_2/chats/c_1", undefined]);
  assert.deepEqual(await request("chat", ["s_0123456789ab~3f9a1c2b-77de-4f00-9a1c-2b77de4f009a"]), ["GET", "/api/on/s_0123456789ab/chats/3f9a1c2b-77de-4f00-9a1c-2b77de4f009a", undefined]);
  assert.deepEqual(await request("newGroup", ["local", "Shop"]), ["POST", "/api/groups", { name: "Shop" }]);
  assert.deepEqual(await request("newGroup", ["s_1", "Shop"]), ["POST", "/api/on/s_1/groups", { name: "Shop" }], "at the top level of the section: no parent");
  assert.deepEqual(await request("newGroup", ["s_1"]), ["POST", "/api/on/s_1/groups", {}]);
  assert.deepEqual(await request("moveGroup", ["s_1~g_2", ""]), ["POST", "/api/on/s_1/groups/g_2/move", { parent: "", before: "" }], "to the top level, last");
  assert.deepEqual(await request("newBoard", ["s_1~__ungrouped__"]), ["POST", "/api/on/s_1/boards", { group: "__ungrouped__", new: false }], "outside any group, from the section's head");
  assert.deepEqual(await request("newChat", [{ group: "s_1~__ungrouped__" }]), ["POST", "/api/on/s_1/chats", { group: "__ungrouped__" }]);
});

test("api.collapseGroup: a local group's collapse is its server's; a section's is the browser's own and is never sent", async () => {
  assert.deepEqual(await request("collapseGroup", ["g_1", true]), ["PATCH", "/api/groups/g_1", { collapsed: true }]);
  assert.deepEqual(await request("collapseGroup", ["g_1", false]), ["PATCH", "/api/groups/g_1", { collapsed: false }]);
  calls.length = 0;
  await assert.rejects(() => api.collapseGroup("s_1~g_1", true), { message: "the collapse of a section's group is not sent" });
  await assert.rejects(() => api.collapseGroup("s_1~g_1", false), { message: "the collapse of a section's group is not sent" });
  assert.equal(calls.length, 0, "no request is made: the local server would refuse it (400 collapsed_refused)");
  // no other call of a group sends `collapsed`
  await api.renameGroup("s_1~g_1", "Shop");
  await api.newGroup("s_1", "Shop", "s_1~g_1");
  await api.moveGroup("s_1~g_1", "");
  for (const c of calls) assert.ok(!("collapsed" in (c.body as object)), c.path);
});

test("the two calls that are about no thing of a server name it in the query, not under the prefix", async () => {
  assert.deepEqual(await request("dirs", ["/home/u/my work", "s_1"]), ["GET", "/api/dirs?path=%2Fhome%2Fu%2Fmy%20work&server=s_1", undefined]);
  assert.deepEqual(await request("dirs", ["/x"]), ["GET", "/api/dirs?path=%2Fx", undefined]);
  assert.deepEqual(await request("dirs", ["/x", "local"]), ["GET", "/api/dirs?path=%2Fx", undefined]);
  assert.deepEqual(await request("usage", ["claude", false, "s_1"]), ["GET", "/api/usage/claude?server=s_1", undefined]);
  assert.deepEqual(await request("usage", ["claude", true, "s_1"]), ["GET", "/api/usage/claude?fresh=1&server=s_1", undefined]);
  assert.deepEqual(await request("usage", ["claude", true]), ["GET", "/api/usage/claude?fresh=1", undefined]);
  assert.deepEqual(await request("usage", ["claude", false, "local"]), ["GET", "/api/usage/claude", undefined]);
  // the answer of a board tool call, whatever server the calling agent is on: the id says which call
  assert.deepEqual(await request("rpcReply", ["far_7", { result: { ok: 1 } }]), ["POST", "/api/rpc-reply", { id: "far_7", result: { ok: 1 } }]);
  assert.deepEqual(await request("state", []), ["GET", "/api/state", undefined]);
});

test("what a section's call answers gets the page's keys before it is handed on", async () => {
  const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200 });
  answer = json({ id: "g_9", name: "Shop", parent: "g_1", collapsed: true });
  assert.deepEqual(await api.newGroup("s_1", "Shop", "s_1~g_1"), { id: "s_1~g_9", name: "Shop", parent: "s_1~g_1" }, "and its collapse is dropped: that is the server's own matter");
  assert.deepEqual(await api.newGroup("local", "Shop", "g_1"), { id: "g_9", name: "Shop", parent: "g_1", collapsed: true });
  answer = json({ id: "b_9", name: "Plan", group: "g_1", created: "t" });
  assert.deepEqual(await api.newBoard("s_1~g_1", "Plan"), { id: "s_1~b_9", name: "Plan", group: "s_1~g_1", created: "t" });
  assert.deepEqual(await api.renameBoard("s_1~b_9", "Plan"), { id: "s_1~b_9", name: "Plan", group: "s_1~g_1", created: "t" });
  assert.deepEqual(await api.newBoard("g_1", "Plan"), { id: "b_9", name: "Plan", group: "g_1", created: "t" });
  answer = json({ id: "c_9", agent: "pi", group: "g_1", board: "b_1", forkedFrom: "c_1", draft: { text: "@Plan", mentions: [{ name: "Plan", id: "b_1" }] } });
  const chat = { id: "s_1~c_9", agent: "pi", group: "s_1~g_1", board: "s_1~b_1", forkedFrom: "s_1~c_1", draft: { text: "@Plan", mentions: [{ name: "Plan", id: "s_1~b_1" }] } };
  assert.deepEqual(await api.chat("s_1~c_9"), chat);
  assert.deepEqual(await api.fork("s_1~c_1", "main", 3), chat);
  answer = json({ ok: true, chat: { id: "c_9", agent: "pi", group: "g_1" } });
  assert.deepEqual(await api.configure("s_1~c_9", "main", { agent: "pi" }), { ok: true, chat: { id: "s_1~c_9", agent: "pi", group: "s_1~g_1" } });
  assert.deepEqual(await api.configure("c_9", "main", { agent: "pi" }), { ok: true, chat: { id: "c_9", agent: "pi", group: "g_1" } });
  answer = json({ version: 4, items: [], branch: "main", state: { chat: "c_9", branch: "main", status: "ready" } });
  assert.deepEqual(await api.items("s_1~c_9", "main"), { version: 4, items: [], branch: "main", state: { chat: "s_1~c_9", branch: "main", status: "ready" } });
});

test("a section's draft refused as stale: the server's draft in the error has the page's keys", async () => {
  answer = refusal(409, { error: "the draft was changed elsewhere", code: "stale", rev: 7, draft: { text: "@Plan", mentions: [{ name: "Plan", id: "b_1" }] } });
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

test("a refusal of a section's call keeps the status, the sentence and the code the local server answered", async () => {
  for (const [status, code, said] of [[503, "server_unreachable", "Studio is not connected."], [404, "not_found", "chat not found"], [404, "no_server", "This server is not in the list."],
    [504, "no_answer", "Studio did not answer."], [502, "bad_answer", "Studio gave an answer that cannot be read."], [504, "send_unknown", "Studio did not answer."]] as const) {
    answer = refusal(status, { error: said, code });
    await assert.rejects(() => api.send("s_1~c_1", "main", "hi", ""), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.deepEqual([e.status, e.code, e.message, e.said], [status, code, said, true]);
      return true;
    });
  }
});

// ---- every write names this page (AC38): the server knows the page by its open event stream

/** What the two tests below call a method with when four strings are not what it takes. */
const ARGS: Record<string, unknown[]> = { newChat: [{ group: "a" }], newGroup: ["local", "b", "c"] }; // (a group is made on a server, in a parent of that server)

test("every api method that is not a GET carries this page's client id in X-AIWB-Client", async () => {
  const writes: string[] = [];
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await Promise.resolve().then(() => method(...(ARGS[name] ?? ["a", "b", "c", "d"]))).catch(() => {}); // (what a method makes of the stub's answer is not the point)
    assert.equal(calls.length, 1, `${name} makes one request`);
    const [c] = calls;
    assert.ok(c.method, `${name} names its method`);
    if (c.method === "GET") continue;
    writes.push(name);
    assert.equal(c.headers?.["X-AIWB-Client"], clientId, `${name} (${c.method} ${c.path})`);
  }
  assert.ok(writes.length >= 30, `the writes were looked at: ${writes.length}`);
  for (const name of ["send", "configure", "saveDraft", "deleteChat", "saveScene", "takeBoard", "rpcReply"])
    assert.ok(writes.includes(name), name);
});

// ---- no request goes through the browser's cache, which holds a write back until a pending read of the same URL has ended (the review T123, N2)

test("every api method's request, a read or a write, has cache: \"no-store\"", async () => {
  const seen: string[] = [];
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await Promise.resolve().then(() => method(...(ARGS[name] ?? ["a", "b", "c", "d"]))).catch(() => {});
    assert.equal(calls.length, 1, `${name} makes one request`);
    assert.equal(calls[0].cache, "no-store", `${name} (${calls[0].method} ${calls[0].path})`);
    seen.push(`${calls[0].method} ${calls[0].path.split("?")[0]}`);
  }
  // a read and the writes of one URL: a chat's view, its Delete and its change
  for (const pair of ["GET /api/chats/a", "DELETE /api/chats/a", "PATCH /api/chats/a"]) assert.ok(seen.includes(pair), pair);
});
