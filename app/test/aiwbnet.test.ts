import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { AIWB_NET, netFailure, netInfoOf } from "../modules/aiwb-net/src/AiwbNet.ts";
import { createFakeAiwbNet } from "../modules/aiwb-net/src/fake.ts";
import { unavailableAiwbNet } from "../modules/aiwb-net/src/unavailable.ts";

const { ScriptedServer } = createRequire(import.meta.url)("../../packages/conn/test/fakes/scripted-server.js");

test("netInfoOf: reads info, or the JSON that ends a wrapped message, and nothing else", () => {
  const info = { kind: "problem", outcome: "cert_changed", detail: "", fingerprint: "AA", pinned: "BB" } as const;
  assert.deepEqual(netInfoOf(netFailure(info)), info);
  assert.equal(netFailure(info).code, AIWB_NET);
  const wrapped = new Error(`FunctionCallException: Caused by: AiwbNetError: ${JSON.stringify({ kind: "net", code: "too_long" })} (at AiwbNetModule.swift:31)`);
  assert.deepEqual(netInfoOf(wrapped), { kind: "net", code: "too_long" });
  assert.equal(netInfoOf(new Error("not implemented")), null);
  assert.equal(netInfoOf(new Error("{not json}")), null);
  assert.equal(netInfoOf(new Error('{"kind":"other"}')), null);
  assert.equal(netInfoOf(null), null);
  assert.equal(netInfoOf("text"), null);
});

const open = { dialMs: 1000, handshakeMs: 1000 };

test("fake: every function rejects with the error of the contract, aborted for a cancelled request", async () => {
  const server = new ScriptedServer({ withHello: false, noSnapshot: true });
  const fake = createFakeAiwbNet(server);
  const info = async (p: Promise<unknown>) => { try { await p; } catch (e) { assert.equal((e as any).code, AIWB_NET); return (e as any).info; } throw new Error("resolved"); };

  assert.deepEqual(await info(fake.openSession({ request: "r1", host: server.host, port: server.port, selfSigned: true, pin: "", ...open })), { kind: "problem", outcome: "fingerprint", detail: "" });
  assert.deepEqual(await info(fake.openSession({ request: "r2", host: server.host, port: server.port + 1, selfSigned: true, pin: server.fingerprint, ...open })), { kind: "problem", outcome: "refused", detail: `connect ECONNREFUSED ${server.host}:${server.port + 1}` });
  const bad = "00" + server.fingerprint.slice(2);
  const wrong = await info(fake.openSession({ request: "r3", host: server.host, port: server.port, selfSigned: true, pin: bad, ...open }));
  assert.equal(wrong.outcome, "cert_changed");
  assert.equal(wrong.fingerprint, server.fingerprint);
  assert.equal(wrong.pinned, bad);

  const { session } = await fake.openSession({ request: "r4", host: server.host, port: server.port, selfSigned: true, pin: server.fingerprint, ...open });
  const base = { session, method: "GET", path: "/api/hello", headers: {}, body: null, headersMs: 0, maxBytes: 0 };
  assert.deepEqual(await info(fake.fetch({ ...base, request: "r5", maxBytes: 1 })), { kind: "net", code: "too_long" });
  server.hangPaths.add("/api/hung");
  assert.deepEqual(await info(fake.fetch({ ...base, request: "r6", path: "/api/hung", headersMs: 30 })), { kind: "net", code: "timeout" });
  const pending = info(fake.fetch({ ...base, request: "r7", path: "/api/hung" }));
  await new Promise((r) => setTimeout(r, 10));
  fake.cancel("r7");
  assert.deepEqual(await pending, { kind: "aborted" });
  fake.cancel("r7"); // a request that is over: nothing
  fake.cancel("never-made");

  const closed: string[] = [];
  fake.addListener("closed", (e) => closed.push(e.session));
  fake.closeSession(session);
  fake.closeSession(session);
  assert.deepEqual(closed, [session]);
  assert.deepEqual(await info(fake.fetch({ ...base, request: "r8" })), { kind: "net", code: "closed" });
  assert.deepEqual(await info(fake.stream({ session, request: "r9", method: "GET", path: "/api/events", headers: {}, headersMs: 0 })), { kind: "net", code: "closed" });
});

test("fake: a stream sends chunk and end events by request; a cut ends it with reset, cancel with no end", async () => {
  const server = new ScriptedServer({ withHello: false, noSnapshot: true });
  const fake = createFakeAiwbNet(server);
  const events: Array<[string, unknown]> = [];
  for (const name of ["chunk", "end", "closed"] as const) fake.addListener(name, ((e: unknown) => { events.push([name, e]); }) as any);
  const { session } = await fake.openSession({ request: "o", host: server.host, port: server.port, selfSigned: true, pin: server.fingerprint, ...open });
  const head = await fake.stream({ session, request: "a", method: "GET", path: "/api/events", headers: { "x-aiwb-secret": server.secret, "x-aiwb-level": "6" }, headersMs: 0 });
  assert.equal(head.status, 200);
  server.write("data: é\n\n");
  await new Promise((r) => setTimeout(r, 10));
  server.cut();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events.filter(([n]) => n !== "closed"), [["chunk", { request: "a", text: "data: é\n\n" }], ["end", { request: "a", error: "reset" }]]);
  assert.deepEqual(events.filter(([n]) => n === "closed"), [["closed", { session }]]);
});

test("the web stand-in rejects every function with 'not implemented'", async () => {
  const m = unavailableAiwbNet();
  await assert.rejects(m.openSession({ request: "r", host: "h", port: 1, selfSigned: false, pin: "", dialMs: 1, handshakeMs: 1 }), /not implemented/);
  await assert.rejects(m.localNetwork(), /not implemented/);
  m.cancel("r");
  m.closeSession("s");
  m.addListener("chunk", () => {}).remove();
});
