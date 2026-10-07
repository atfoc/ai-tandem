// The body api.send posts (src/api.ts with a stubbed global fetch): the point a message goes to,
// and the model and effort of the new branch, are in it as the server reads them. And what a
// refusal becomes: an ApiError, with a sentence and a hook for `unknown_client`.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError, api, clientId } from "../src/api.ts";
import { UNKNOWN_CLIENT, onUnknownClient, streamGone } from "../src/logic/unknownclient.ts";

type Call = { path: string; method?: string; headers?: Record<string, string>; body: unknown; cache?: RequestCache };
const calls: Call[] = [];
const accepted = () => new Response(JSON.stringify({ ok: true, branch: "0f0f0f0f" }), { status: 200 });
let answer: () => Response = accepted;
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(init.body as string), cache: init.cache });
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

// ---- runs on another server

test("api.configureRun sends the server alone when that is what is picked", async () => {
  await api.configureRun("r_1", { server: "s_1" });
  assert.deepEqual([calls[0].path, calls[0].method, calls[0].body], ["/api/runs/r_1", "PATCH", { server: "s_1" }]);
});

test("api.deleteRun: `local` is the query ?local=1, and without it there is none", async () => {
  await api.deleteRun("r_1");
  await api.deleteRun("r_1", { local: true });
  await api.deleteRun("r_1", { local: false });
  assert.deepEqual(calls.map((c) => [c.path, c.method, c.body]), [["/api/runs/r_1", "DELETE", undefined], ["/api/runs/r_1?local=1", "DELETE", undefined], ["/api/runs/r_1", "DELETE", undefined]]);
});

test("api.unfollowRun posts to the run's unfollow route with this page's client id", async () => {
  await api.unfollowRun("r_1");
  assert.deepEqual([calls[0].path, calls[0].method, calls[0].body], ["/api/runs/r_1/unfollow", "POST", undefined]);
  assert.equal(calls[0].headers!["X-AIWB-Client"], clientId);
});

// ---- every write names this page (AC38): the server knows the page by its open event stream

test("every api method that is not a GET carries this page's client id in X-AIWB-Client", async () => {
  const writes: string[] = [];
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await method("a", "b", "c", "d").catch(() => {}); // (what a method makes of the stub's answer is not the point)
    assert.equal(calls.length, 1, `${name} makes one request`);
    const [c] = calls;
    assert.ok(c.method, `${name} names its method`);
    if (c.method === "GET") continue;
    writes.push(name);
    assert.equal(c.headers?.["X-AIWB-Client"], clientId, `${name} (${c.method} ${c.path})`);
  }
  assert.ok(writes.length >= 35, `the writes were looked at: ${writes.length}`);
  for (const name of ["send", "configure", "saveDraft", "startRun", "configureRun", "deleteRun", "deleteChat", "saveScene", "takeBoard", "rpcReply"])
    assert.ok(writes.includes(name), name);
});

// ---- no request goes through the browser's cache, which holds a write back until a pending read of the same URL has ended (the review T123, N2)

test("every api method's request, a read or a write, has cache: \"no-store\"", async () => {
  const seen: string[] = [];
  for (const [name, method] of Object.entries(api) as [string, (...args: unknown[]) => Promise<unknown>][]) {
    calls.length = 0;
    await method("a", "b", "c", "d").catch(() => {});
    assert.equal(calls.length, 1, `${name} makes one request`);
    assert.equal(calls[0].cache, "no-store", `${name} (${calls[0].method} ${calls[0].path})`);
    seen.push(`${calls[0].method} ${calls[0].path.split("?")[0]}`);
  }
  // the pair of the finding: the page's read of a run, and the Delete and the change of it
  for (const pair of ["GET /api/runs/a", "DELETE /api/runs/a", "PATCH /api/runs/a"]) assert.ok(seen.includes(pair), pair);
});
