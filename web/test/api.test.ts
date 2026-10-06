// The body api.send posts (src/api.ts with a stubbed global fetch): the point a message goes to,
// and the model and effort of the new branch, are in it as the server reads them.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { api, clientId } from "../src/api.ts";

type Call = { path: string; method?: string; headers?: Record<string, string>; body: unknown };
const calls: Call[] = [];
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  calls.push({ path, method: init.method, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
  return new Response(JSON.stringify({ ok: true, branch: "0f0f0f0f" }), { status: 200 });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; });

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
