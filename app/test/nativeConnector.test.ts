import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import { nativeConnector } from "../src/platform/net/nativeConnector.ts";
import type { AiwbNetModule } from "../modules/aiwb-net/src/AiwbNet.ts";
import { createFakeAiwbNet } from "../modules/aiwb-net/src/fake.ts";

// The scripted server, the fake network and the connector contract are CommonJS without types (packages/conn/test).
const require = createRequire(import.meta.url);
const { ScriptedServer } = require("../../packages/conn/test/fakes/scripted-server.js");
const { fakeConnector } = require("../../packages/conn/test/fakes/fake-connector.js");
const { runConnectorContract } = require("../../packages/conn/test/contract/connector-contract.js");

const SECOND = 1000;

// ---- the contract (AD-33): the adapter over the fake passes what the Node connector passes ----

// The fake network every case reaches its server through; the handle of the contract over a scripted server
// that sends no hello and no snapshot (as packages/conn/test/contract/fakes.test.js).
const network = fakeConnector();

function handle(s: any) {
  network.add(s);
  return {
    host: s.host,
    port: s.port,
    fingerprint: s.fingerprint,
    secret: s.secret,
    close: async () => { s.cut(); network.remove(s); },
    requests: () => s.requests.map((r: any) => ({ method: r.method, path: r.path, headers: r.headers, body: r.body })),
    connections: () => s.dials,
    body: (path: string, bytes: Uint8Array) => { s.routes.set(`GET ${path}`, () => ({ bytes, type: "application/octet-stream" })); },
    echo: (path: string) => { s.routes.set(`POST ${path}`, (req: any) => ({ bytes: req.body || new Uint8Array(0), type: "application/octet-stream" })); },
    hang: (path: string) => { s.hangPaths.add(path); },
    waitStream: () => s.waitStreams(1),
    write: (text: string) => s.write(text),
    endStreams: () => s.endStreams(),
    cut: () => s.cut(),
  };
}

async function start(kind: string) {
  const base = { withHello: false, noSnapshot: true };
  switch (kind) {
    case "aiwb": return handle(new ScriptedServer(base));
    case "h1": return handle(new ScriptedServer({ ...base, transport: "http1" }));
    case "plain": return handle(new ScriptedServer({ ...base, transport: "plain" }));
    case "blackhole": return handle(new ScriptedServer({ ...base, handshakeHang: true }));
    case "closed": return { host: "nothing.test", port: 9, close: async () => {} };
    default: throw new Error(`unknown kind ${kind}`);
  }
}

runConnectorContract(() => nativeConnector(createFakeAiwbNet(network)), { test, start });

// ---- what the adapter does beyond the contract ----

// A module with a fake behind it, and the server it reaches.
function rig(opts: Record<string, unknown> = {}) {
  const server = new ScriptedServer({ withHello: false, noSnapshot: true, ...opts });
  const fake = createFakeAiwbNet(server);
  const connector = nativeConnector(fake);
  const open = (extra: Record<string, unknown> = {}) => connector.open({
    host: server.host, port: String(server.port), trust: { selfSigned: true, pin: server.fingerprint },
    dialMs: 3 * SECOND, handshakeMs: 3 * SECOND, ...extra,
  });
  return { server, fake, connector, open };
}

const hello = (server: any) => ({ method: "GET" as const, path: "/api/hello", headers: {}, body: null });

test("native connector: a self-signed trust with no pin is fingerprint and the module is not called", async () => {
  const { fake, connector, server } = rig();
  await assert.rejects(
    connector.open({ host: server.host, port: String(server.port), trust: { selfSigned: true, pin: "" }, dialMs: 1000, handshakeMs: 1000 }),
    (e: any) => e.name === "Problem" && e.outcome === "fingerprint",
  );
  assert.deepEqual(fake.calls, []);
});

test("native connector: the pin goes to the module in its normal form, a pin that is no fingerprint as it is", async () => {
  const { fake, server, open } = rig();
  const lower = server.fingerprint.replace(/:/g, "").toLowerCase();
  const s = await open({ trust: { selfSigned: true, pin: lower } });
  assert.equal(s.fingerprint, server.fingerprint);
  assert.equal((fake.calls[0].args as any).pin, server.fingerprint);
  s.close();
  await assert.rejects(open({ trust: { selfSigned: true, pin: "not a fingerprint" } }), (e: any) => e.outcome === "cert_changed" && e.pinned === "not a fingerprint" && e.fingerprint === server.fingerprint);
});

test("native connector: every outcome of the error table, for open and readCertificate", async () => {
  for (const dialError of ["refused", "no_route", "name_not_found", "local_network_denied"]) {
    const { server, open, connector } = rig({ dialError });
    await assert.rejects(open(), (e: any) => e.name === "Problem" && e.outcome === dialError, dialError);
    await assert.rejects(
      connector.readCertificate({ host: server.host, port: String(server.port), dialMs: 1000, handshakeMs: 1000 }),
      (e: any) => e.name === "Problem" && e.outcome === dialError,
      `readCertificate ${dialError}`,
    );
  }
  for (const verdict of ["self_signed", "cert_name", "cert_expired", "cert_untrusted"]) {
    const { server, open } = rig({ verdict });
    await assert.rejects(open({ trust: { selfSigned: false, pin: "" } }), (e: any) => e.outcome === verdict, verdict);
    const ok = rig({ verdict: "trusted" });
    const s = await ok.open({ trust: { selfSigned: false, pin: "" } });
    assert.equal(s.fingerprint, ok.server.fingerprint);
    s.close();
    void server;
  }
});

test("native connector: localNetwork is unknown, granted after a session, denied after local_network_denied", async () => {
  const granted = rig();
  assert.equal(await granted.fake.localNetwork(), "unknown");
  (await granted.open()).close();
  assert.equal(await granted.fake.localNetwork(), "granted");
  const denied = rig({ dialError: "local_network_denied" });
  await assert.rejects(denied.open());
  assert.equal(await denied.fake.localNetwork(), "denied");
});

test("native connector: limitMs cancels the request in the module and the session goes on", async () => {
  const { server, fake, open } = rig();
  server.hangPaths.add("/api/hung");
  const s = await open();
  const t0 = Date.now();
  await assert.rejects(s.fetch({ method: "GET", path: "/api/hung", headers: {}, body: null, limitMs: 80 }), (e: any) => e.name === "NetError" && e.code === "timeout");
  assert.ok(Date.now() - t0 < 5 * SECOND);
  assert.equal(fake.calls.filter((c) => c.fn === "cancel").length, 1, "the module was told to cancel");
  assert.equal(s.isClosed(), false);
  assert.equal((await s.fetch({ ...hello(server), limitMs: 5 * SECOND })).status, 200);
  s.close();
});

test("native connector: an abort tells the module to cancel and rejects an AbortError at once", async () => {
  const { server, fake, open } = rig();
  server.hangPaths.add("/api/hung");
  const s = await open();
  const ac = new AbortController();
  const pending = s.fetch({ method: "GET", path: "/api/hung", headers: {}, body: null, signal: ac.signal });
  await new Promise((r) => setTimeout(r, 20));
  ac.abort();
  await assert.rejects(pending, (e: any) => e.name === "AbortError");
  assert.deepEqual(fake.calls.filter((c) => c.fn === "cancel").map((c) => typeof c.args), ["string"]);
  s.close();
});

test("native connector: an open that is aborted leaves no session behind, even when the module answers late", async () => {
  // A module whose openSession answers after cancel, as a platform whose handshake had just finished would.
  const closedSessions: string[] = [];
  let release: () => void = () => {};
  const mod: AiwbNetModule = {
    openSession: () => new Promise((resolve) => { release = () => resolve({ session: "late-1", fingerprint: "AA" }); }),
    readCertificate: () => Promise.reject(new Error("unused")),
    fetch: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
    cancel: () => {},
    closeSession: (s) => { closedSessions.push(s); },
    localNetwork: async () => "unknown",
    addListener: () => ({ remove: () => {} }),
  };
  const ac = new AbortController();
  const pending = nativeConnector(mod).open({ host: "h", port: "1", trust: { selfSigned: true, pin: "AA" }, dialMs: 1, handshakeMs: 1, signal: ac.signal });
  ac.abort();
  await assert.rejects(pending, (e: any) => e.name === "AbortError");
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(closedSessions, ["late-1"]);
});

test("native connector: the text of a stream that came before the headers' promise is kept, in order", async () => {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const emit = (name: string, e: unknown) => { for (const f of listeners[name] ?? []) f(e); };
  const cancels: string[] = [];
  const mod: AiwbNetModule = {
    openSession: async () => ({ session: "s1", fingerprint: "AA" }),
    readCertificate: async () => ({ fingerprint: "AA" }),
    fetch: () => Promise.reject(new Error("unused")),
    stream: async (o) => {
      emit("chunk", { request: o.request, text: "one" });
      emit("chunk", { request: o.request, text: "two" });
      emit("end", { request: o.request });
      return { status: 200, headers: { "content-type": "text/event-stream" } };
    },
    cancel: (r) => { cancels.push(r); },
    closeSession: () => {},
    localNetwork: async () => "unknown",
    addListener: (name, f) => { (listeners[name] ??= []).push(f as any); return { remove: () => {} }; },
  };
  const s = await nativeConnector(mod).open({ host: "h", port: "1", trust: { selfSigned: true, pin: "AA" }, dialMs: 1, handshakeMs: 1 });
  const r = await s.stream({ method: "GET", path: "/api/events", headers: {}, body: null });
  const got = { text: "", ends: 0, err: undefined as unknown };
  r.body.onChunk((t) => { got.text += t; });
  r.body.onEnd((err) => { got.ends++; got.err = err; });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, { text: "onetwo", ends: 1, err: undefined });
  assert.deepEqual(cancels, [], "an ended stream is not cancelled");
  await assert.rejects(s.stream({ method: "POST", path: "/x", headers: {}, body: new Uint8Array(1) }), TypeError);
});

test("native connector: a session the module reports closed before openSession answered is closed when it is made", async () => {
  const listeners: Record<string, Array<(e: any) => void>> = {};
  const mod: AiwbNetModule = {
    openSession: async () => { for (const f of listeners.closed ?? []) f({ session: "s1" }); return { session: "s1", fingerprint: "AA" }; },
    readCertificate: async () => ({ fingerprint: "AA" }),
    fetch: () => Promise.reject(new Error("unused")),
    stream: () => Promise.reject(new Error("unused")),
    cancel: () => {},
    closeSession: () => {},
    localNetwork: async () => "unknown",
    addListener: (name, f) => { (listeners[name] ??= []).push(f as any); return { remove: () => {} }; },
  };
  const s = await nativeConnector(mod).open({ host: "h", port: "1", trust: { selfSigned: true, pin: "AA" }, dialMs: 1, handshakeMs: 1 });
  assert.equal(s.isClosed(), true);
});

test("native connector: a stub that is not implemented fails as a Problem for open and a NetError for a call", async () => {
  const no = () => Promise.reject(new Error("not implemented"));
  const mod: AiwbNetModule = {
    openSession: no, readCertificate: no, fetch: no, stream: no, cancel: () => {}, closeSession: () => {}, localNetwork: no,
    addListener: () => ({ remove: () => {} }),
  };
  await assert.rejects(
    nativeConnector(mod).open({ host: "h", port: "1", trust: { selfSigned: true, pin: "AA" }, dialMs: 1, handshakeMs: 1 }),
    (e: any) => e.name === "Problem" && e.outcome === "tls_error" && e.detail === "not implemented",
  );
  await assert.rejects(
    nativeConnector(mod).readCertificate({ host: "h", port: "1", dialMs: 1, handshakeMs: 1 }),
    (e: any) => e.name === "Problem" && e.outcome === "tls_error",
  );
});
