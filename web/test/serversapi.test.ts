// The server list's routes (src/serversapi.ts with a stubbed global fetch): the method, path and
// body of each call, and that the secret is in a request's body and nowhere else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { clientId } from "../src/api.ts";
import * as serversapi from "../src/serversapi.ts";
import { serversApi } from "../src/serversapi.ts";
import type { ServerForm } from "../src/logic/servers.ts";

type Call = { path: string; method?: string; headers: Record<string, string>; raw: string | undefined; body: unknown };
const calls: Call[] = [];
let answer: unknown = {};
globalThis.fetch = (async (path: string, init: RequestInit = {}) => {
  const raw = init.body as string | undefined;
  calls.push({ path, method: init.method, headers: init.headers as Record<string, string>, raw, body: raw === undefined ? undefined : JSON.parse(raw) });
  return new Response(JSON.stringify(answer), { status: 200 });
}) as typeof fetch;
beforeEach(() => { calls.length = 0; answer = {}; });

const SECRET = "s3cret-0123456789abcdef";
const form: ServerForm = { name: "Studio", address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD" };
const one = () => { assert.equal(calls.length, 1); return [calls[0].method, calls[0].path, calls[0].body]; };

test("list", async () => {
  answer = { servers: [{ id: "local", local: true, name: "This computer", state: "connected" }], notice: "" };
  assert.deepEqual(await serversApi.list(), answer);
  assert.deepEqual(one(), ["GET", "/api/servers", undefined]);
  assert.deepEqual(calls[0].headers, { "Content-Type": "application/json", "X-AIWB-Client": clientId });
});

test("add: the form and force, without an id", async () => {
  answer = { saved: false, result: { ok: false, step: 2, outcome: "refused", message: "Nothing listens there" } };
  assert.deepEqual(await serversApi.add({ ...form, id: "ignored" }, false), answer);
  assert.deepEqual(one(), ["POST", "/api/servers", { name: "Studio", address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD", force: false }]);
  calls.length = 0;
  await serversApi.add(form, true);
  assert.equal((calls[0].body as { force: boolean }).force, true);
});

test("edit: the patch as given, with force; no secret field when none is given", async () => {
  await serversApi.edit("s_3f9a1c2b77de", { name: "Other" }, false);
  assert.deepEqual(one(), ["PATCH", "/api/servers/s_3f9a1c2b77de", { name: "Other", force: false }]);
  assert.equal("secret" in (calls[0].body as object), false);
  calls.length = 0;
  await serversApi.edit("s_3f9a1c2b77de", { address: "https://mac.local:4749", secret: SECRET, selfSigned: false, pin: "" }, true);
  assert.deepEqual(one(), ["PATCH", "/api/servers/s_3f9a1c2b77de", { address: "https://mac.local:4749", secret: SECRET, selfSigned: false, pin: "", force: true }]);
});

test("remove and items", async () => {
  await serversApi.remove("s_1");
  assert.deepEqual(one(), ["DELETE", "/api/servers/s_1", undefined]);
  calls.length = 0;
  answer = { chats: 3, runs: 2 };
  assert.deepEqual(await serversApi.items("s_1"), answer);
  assert.deepEqual(one(), ["GET", "/api/servers/s_1/items", undefined]);
});

test("test: an unsaved form, without its name", async () => {
  answer = { ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.2.3", agents: ["claude"] };
  assert.deepEqual(await serversApi.test(form), answer);
  assert.deepEqual(one(), ["POST", "/api/servers/test", { address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD" }]);
});

test("testSaved: no body for the entry as saved, or the values to test in their place", async () => {
  await serversApi.testSaved("s_1");
  assert.deepEqual(one(), ["POST", "/api/servers/s_1/test", undefined]);
  assert.equal(calls[0].raw, undefined);
  calls.length = 0;
  await serversApi.testSaved("s_1", { address: "https://mac.local:4749", selfSigned: true, pin: "AB:CD" });
  assert.deepEqual(one(), ["POST", "/api/servers/s_1/test", { address: "https://mac.local:4749", selfSigned: true, pin: "AB:CD" }]);
});

test("accept", async () => {
  answer = { server: { id: "s_1", name: "Studio", state: "connecting", pin: "AB:CD" } };
  assert.deepEqual(await serversApi.accept("s_1", "AB:CD"), answer);
  assert.deepEqual(one(), ["POST", "/api/servers/s_1/accept", { fingerprint: "AB:CD" }]);
});

test("an id is escaped in the path", async () => {
  await serversApi.remove("a/b?c");
  assert.equal(calls[0].path, "/api/servers/a%2Fb%3Fc");
});

test("the secret is in the request's body alone: never in a path or a header", async () => {
  await serversApi.add(form, false);
  await serversApi.add(form, true);
  await serversApi.edit("s_1", { secret: SECRET }, false);
  await serversApi.test(form);
  await serversApi.testSaved("s_1", { secret: SECRET });
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.ok(c.raw!.includes(SECRET), c.path);
    assert.equal(c.path.includes(SECRET), false);
    assert.equal(JSON.stringify(c.headers).includes(SECRET), false);
  }
  // The calls that take no secret send none.
  calls.length = 0;
  await serversApi.list(); await serversApi.items("s_1"); await serversApi.testSaved("s_1"); await serversApi.accept("s_1", "AB:CD"); await serversApi.remove("s_1");
  for (const c of calls) assert.equal(JSON.stringify(c).includes(SECRET), false, c.path);
});

test("the eight functions are also exported by name", () => {
  for (const k of ["list", "add", "edit", "remove", "items", "test", "testSaved", "accept"] as const) assert.equal(serversapi[k], serversApi[k], k);
});
