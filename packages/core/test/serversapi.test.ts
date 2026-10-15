// The server list's operations (src/serversapi.ts through a fake transport): the app operation and
// arguments of each call, and that the secret goes out in the arguments of the operations that take it and nowhere else.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import { installFake } from "./fixtures/faketransport.ts";
import * as serversapi from "../src/serversapi.ts";
import { serversApi } from "../src/serversapi.ts";
import type { ServerForm } from "../src/logic/servers.ts";

const fake = installFake();
let answer: unknown = {};
fake.appHandler = () => ({ status: 200, text: JSON.stringify(answer) });
beforeEach(() => { fake.reset(); answer = {}; });

const SECRET = "s3cret-0123456789abcdef";
const form: ServerForm = { name: "Studio", address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD" };
const one = () => { assert.equal(fake.apps.length, 1); assert.equal(fake.calls.length, 0, "the server list is the app's: no call to a server"); return [fake.apps[0].op, fake.apps[0].args]; };

test("list", async () => {
  answer = { servers: [{ id: "local", local: true, name: "This computer", state: "connected" }], notice: "" };
  assert.deepEqual(await serversApi.list(), answer);
  assert.deepEqual(one(), ["servers.list", undefined]);
});

test("add: the form and force, without an id", async () => {
  answer = { saved: false, result: { ok: false, step: 2, outcome: "refused", message: "Nothing listens there" } };
  assert.deepEqual(await serversApi.add({ ...form, id: "ignored" }, false), answer);
  assert.deepEqual(one(), ["servers.add", { form: { name: "Studio", address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD" }, force: false }]);
  fake.reset();
  await serversApi.add(form, true);
  assert.equal((fake.apps[0].args as { force: boolean }).force, true);
});

test("edit: the patch as given, with force; no secret field when none is given", async () => {
  await serversApi.edit("s_3f9a1c2b77de", { name: "Other" }, false);
  assert.deepEqual(one(), ["servers.edit", { id: "s_3f9a1c2b77de", patch: { name: "Other" }, force: false }]);
  assert.equal("secret" in (fake.apps[0].args as { patch: object }).patch, false);
  fake.reset();
  await serversApi.edit("s_3f9a1c2b77de", { address: "https://mac.local:4749", secret: SECRET, selfSigned: false, pin: "" }, true);
  assert.deepEqual(one(), ["servers.edit", { id: "s_3f9a1c2b77de", patch: { address: "https://mac.local:4749", secret: SECRET, selfSigned: false, pin: "" }, force: true }]);
});

test("remove: the entry by its id; nothing of that server is counted first", async () => {
  answer = { ok: true };
  assert.deepEqual(await serversApi.remove("s_1"), { ok: true });
  assert.deepEqual(one(), ["servers.remove", { id: "s_1" }]);
  // the call that counted an entry's chats is gone: the page has none for it
  assert.equal("items" in serversApi, false);
  assert.equal("items" in serversapi, false);
});

test("test: an unsaved form, without its name", async () => {
  answer = { ok: true, step: 5, outcome: "connected", message: "Connected", version: "1.2.3", agents: ["claude"] };
  assert.deepEqual(await serversApi.test(form), answer);
  assert.deepEqual(one(), ["servers.test", { form: { address: "https://mac.local:4748", secret: SECRET, selfSigned: true, pin: "AB:CD" } }]);
});

test("testSaved: the entry as saved, or the values to test in their place", async () => {
  await serversApi.testSaved("s_1");
  assert.deepEqual(one(), ["servers.testSaved", { id: "s_1" }]);
  fake.reset();
  await serversApi.testSaved("s_1", { address: "https://mac.local:4749", selfSigned: true, pin: "AB:CD" });
  assert.deepEqual(one(), ["servers.testSaved", { id: "s_1", over: { address: "https://mac.local:4749", selfSigned: true, pin: "AB:CD" } }]);
});

test("accept", async () => {
  answer = { server: { id: "s_1", name: "Studio", state: "connecting", pin: "AB:CD" } };
  assert.deepEqual(await serversApi.accept("s_1", "AB:CD"), answer);
  assert.deepEqual(one(), ["servers.accept", { id: "s_1", fingerprint: "AB:CD" }]);
});

test("a refusal of the app is an ApiError with its sentence and code", async () => {
  fake.appHandler = () => ({ status: 409, text: JSON.stringify({ error: "A server with that address is in the list already.", code: "duplicate" }) });
  await assert.rejects(() => serversApi.add(form, false), (e: unknown) => e instanceof ApiError && e.status === 409 && e.code === "duplicate" && e.said && e.message === "A server with that address is in the list already.");
  fake.appHandler = () => ({ status: 404, text: JSON.stringify({ error: "No such server.", code: "no_server" }) });
  await assert.rejects(() => serversApi.remove("s_9"), (e: unknown) => e instanceof ApiError && e.status === 404);
  fake.appHandler = () => ({ status: 200, text: JSON.stringify(answer) });
});

test("the secret goes out in the arguments of the operations that take it, and no call to a server carries any", async () => {
  await serversApi.add(form, false);
  await serversApi.add(form, true);
  await serversApi.edit("s_1", { secret: SECRET }, false);
  await serversApi.test(form);
  await serversApi.testSaved("s_1", { secret: SECRET });
  assert.equal(fake.apps.length, 5);
  for (const c of fake.apps) assert.ok(JSON.stringify(c.args).includes(SECRET), c.op);
  // The operations that take no secret send none.
  fake.reset();
  await serversApi.list(); await serversApi.testSaved("s_1"); await serversApi.accept("s_1", "AB:CD"); await serversApi.remove("s_1");
  assert.equal(fake.apps.length, 4);
  for (const c of fake.apps) assert.equal(JSON.stringify(c).includes(SECRET), false, c.op);
  assert.equal(fake.calls.length, 0);
});

test("the seven functions are also exported by name", () => {
  assert.deepEqual(Object.keys(serversApi).sort(), ["accept", "add", "edit", "list", "remove", "test", "testSaved"]);
  for (const k of ["list", "add", "edit", "remove", "test", "testSaved", "accept"] as const) assert.equal(serversapi[k], serversApi[k], k);
});
