// The page's adapter of the window's bridge (src/transport/desktop.ts) against a fake bridge. The bridge itself and
// the whole path through the real IPC face are tested in desktop/test/{preload,bridge-e2e}.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { desktopTransport, type DesktopBridge } from "../src/transport/desktop.ts";
import { TransportError } from "../src/transport/types.ts";
import { wayOf } from "../src/transport/index.ts";

type CallArg = Parameters<DesktopBridge["call"]>[0];

function fakeBridge(over: Partial<DesktopBridge> = {}) {
  const calls: CallArg[] = [];
  const bridge: DesktopBridge = {
    way: "ipc",
    call: async (req) => { calls.push(req); return { status: 200, text: "{}", sceneRev: null }; },
    stream: () => ({ close() {} }),
    picture: async (server, chat, image) => `aiwb-picture://p/${server}/${chat}/${image}`,
    app: async () => ({ status: 200, text: "[]" }),
    pickImages: async () => ({ files: [], skipped: [] }),
    ...over,
  };
  return { bridge, calls, transport: desktopTransport(bridge) };
}

test("the transport is the ipc way, has no pictureURL, and hands the call its four fields", async () => {
  const { transport, calls } = fakeBridge();
  assert.equal(transport.way, "ipc");
  assert.equal("pictureURL" in transport, false);
  await transport.call({ server: "local", method: "POST", path: "/api/groups", body: { json: "{}" }, keepalive: true });
  assert.deepEqual(calls, [{ server: "local", method: "POST", path: "/api/groups", body: { json: "{}" } }]);
});

test("with a signal the call carries abort = { aborted, listen }, and no signal itself", async () => {
  const { transport, calls } = fakeBridge();
  const ac = new AbortController();
  await transport.call({ server: "local", method: "GET", path: "/x", signal: ac.signal });
  const abort = calls[0].abort!;
  assert.deepEqual(Object.keys(abort).sort(), ["aborted", "listen"]);
  assert.equal(abort.aborted, false);
  assert.equal("signal" in calls[0], false);
  let ran = 0;
  const off = abort.listen(() => ran++);
  ac.abort();
  ac.abort();
  assert.equal(ran, 1);
  off();
});

test("listen's remover takes the listener off the signal", () => {
  const { calls, transport } = fakeBridge();
  const ac = new AbortController();
  return transport.call({ server: "local", method: "GET", path: "/x", signal: ac.signal }).then(() => {
    let ran = 0;
    const off = calls[0].abort!.listen(() => ran++);
    off();
    ac.abort();
    assert.equal(ran, 0);
  });
});

test("a call without a signal carries no abort", async () => {
  const { transport, calls } = fakeBridge();
  await transport.call({ server: "local", method: "GET", path: "/x" });
  assert.equal("abort" in calls[0], false);
});

test("a signal already aborted: the signal's own reason, and the bridge is not asked", async () => {
  const { transport, calls } = fakeBridge();
  const ac = new AbortController();
  ac.abort(new Error("mine"));
  await assert.rejects(transport.call({ server: "local", method: "GET", path: "/x", signal: ac.signal }), (e) => e === ac.signal.reason);
  const plain = new AbortController();
  plain.abort();
  await assert.rejects(transport.call({ server: "local", method: "GET", path: "/x", signal: plain.signal }), (e: any) => e.name === "AbortError");
  assert.deepEqual(calls, []);
});

test("the bridge's plain Error becomes the signal's reason when the signal aborted, else a TransportError with its message", async () => {
  const ac = new AbortController();
  const { transport } = fakeBridge({ call: async () => { ac.abort(new Error("why")); throw new Error("The call was aborted."); } });
  await assert.rejects(transport.call({ server: "local", method: "GET", path: "/x", signal: ac.signal }), (e) => e === ac.signal.reason);

  const cause = new Error("the call did not reach the app: boom");
  const { transport: t2 } = fakeBridge({ call: async () => { throw cause; } });
  await assert.rejects(t2.call({ server: "local", method: "GET", path: "/x" }), (e: any) => e instanceof TransportError && e.name === "TransportError" && e.message === cause.message && e.cause === cause);
});

test("bytes: a Uint8Array crosses as its ArrayBuffer, a view is cut to its own bytes, a Blob as it is", async () => {
  const { transport, calls } = fakeBridge();
  const big = new Uint8Array(1000).map((_, i) => i & 255);
  const blob = new Blob([big]);
  const call = (bytes: Uint8Array | Blob) => transport.call({ server: "local", method: "POST", path: "/x", body: { bytes, type: "image/png" } });
  await call(big);
  await call(big.subarray(10, 20));
  await call(blob);
  const bodies = calls.map((c) => c.body as { bytes: ArrayBuffer | Blob; type: string });
  assert.ok(bodies[0].bytes instanceof ArrayBuffer);
  assert.deepEqual(Array.from(new Uint8Array(bodies[0].bytes as ArrayBuffer)), Array.from(big));
  assert.ok(bodies[1].bytes instanceof ArrayBuffer);
  assert.equal((bodies[1].bytes as ArrayBuffer).byteLength, 10);
  assert.deepEqual(Array.from(new Uint8Array(bodies[1].bytes as ArrayBuffer)), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  assert.equal(bodies[2].bytes, blob);
  assert.equal(bodies[2].type, "image/png");
});

test("stream is the bridge's; picture, app and pickImages go to it, and their failures are TransportErrors", async () => {
  const seen: unknown[] = [];
  const { transport } = fakeBridge({ stream: (e, s) => { seen.push(e, s); return { close() { seen.push("closed"); } }; } });
  const onEnvelope = () => {}, onState = () => {};
  transport.stream(onEnvelope, onState).close();
  assert.deepEqual(seen, [onEnvelope, onState, "closed"]);
  assert.equal(await transport.picture("s_000000000001", "c1", "ab"), "aiwb-picture://p/s_000000000001/c1/ab");
  assert.deepEqual(await transport.app("servers.list"), { status: 200, text: "[]" });
  assert.deepEqual(await transport.pickImages!(), { files: [], skipped: [] });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(transport.picture("local", "c", "i", ac.signal), (e: any) => e.name === "AbortError");

  const { transport: bad } = fakeBridge({ picture: async () => { throw new Error("nope"); }, app: async () => { throw new Error("the app did not answer: x"); } });
  await assert.rejects(bad.picture("local", "c", "i"), (e: any) => e instanceof TransportError && /nope/.test(e.message));
  await assert.rejects(bad.app("servers.list"), (e: any) => e instanceof TransportError && /did not answer/.test(e.message));
});

test("wayOf: the bridge is the ipc way, whatever the address; native on React Native; http over http:; else none", () => {
  assert.equal(wayOf({ aiwbTransport: {} }), "ipc");
  assert.equal(wayOf({ aiwbTransport: {}, location: { protocol: "http:" } }), "ipc", "the window's bridge wins");
  assert.equal(wayOf({ aiwbTransport: {} }, { product: "ReactNative" }), "native");
  assert.equal(wayOf({ location: { protocol: "http:" } }), "http");
  assert.equal(wayOf({ location: { protocol: "file:" } }), null);
  assert.equal(wayOf(undefined), null);
});
