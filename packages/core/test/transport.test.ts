// The page's transport (src/transport): the IPC way against a fake `window.aiwbTransport`, the HTTP way against a fake `fetch` and
// `EventSource`, and that the two mean the same: the same calls give the same answers, the stream gives the same envelopes in
// the same order, and a stream that ended for good is told the same way. And the choice of the way when the page starts, and
// that nothing of the page outside src/transport/ reaches the network itself.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { desktopTransport, type DesktopBridge } from "../src/transport/desktop.ts";
import { httpTransport } from "../src/transport/http.ts";
import { transport, useTransport, wayOf } from "../src/transport/index.ts";
import { sourceNames, sourceOf } from "./fixtures/bundle.ts";
import { TransportError, type CallAnswer, type CallRequest, type Envelope, type StreamState, type Transport } from "../src/transport/types.ts";

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

/** What a server of the page's tests answers, whichever way the call came: the same for both ways. */
type Backend = (c: { server: string; method: string; path: string; body: unknown; type?: string }) => CallAnswer | Promise<CallAnswer>;
const echo: Backend = (c) => {
  if (c.path === "/api/missing") return { status: 404, text: JSON.stringify({ error: "not found", code: "not_found" }), sceneRev: null };
  if (c.path.endsWith("/scene")) return { status: 200, text: JSON.stringify({ elements: [] }), sceneRev: 7 };
  if (c.path === "/api/empty") return { status: 204, text: "", sceneRev: null };
  if (c.path === "/api/text") return { status: 200, text: "plain words, not JSON", sceneRev: null };
  return { status: 200, text: JSON.stringify(c), sceneRev: null };
};

// ---- the IPC way: the desktop window's bridge (window.aiwbTransport), stood in for by a fake behind desktopTransport. The adapter's
// own mechanics (the abort handed over as data, the errors made on this side of the bridge) are tested in desktop.test.ts.

type BridgeFake = { bridge: DesktopBridge; calls: Parameters<DesktopBridge["call"]>[0][]; streams: number; closes: number;
  push(batch: Envelope[]): void; state(s: StreamState): void; backend: Backend };
function bridgeFake(): BridgeFake {
  let onEnvelope: ((e: Envelope) => void) | null = null, onState: ((s: StreamState) => void) | null = null;
  const f: BridgeFake = {
    calls: [], streams: 0, closes: 0, backend: echo,
    push: (b) => { for (const e of b) onEnvelope?.(e); }, state: (s) => onState?.(s),
    bridge: {
      way: "ipc",
      call: async (req) => {
        f.calls.push(req);
        const body = !req.body ? undefined : "json" in req.body ? JSON.parse(req.body.json) : `<${req.body.bytes instanceof Blob ? req.body.bytes.size : req.body.bytes.byteLength} bytes>`;
        return f.backend({ server: req.server, method: req.method, path: req.path, body, ...(req.body && "bytes" in req.body ? { type: req.body.type } : {}) });
      },
      stream: (e, s) => { onEnvelope = e; onState = s; f.streams++; return { close() { f.closes++; onEnvelope = null; onState = null; } }; },
      picture: async (server, chat, image) => `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`,
      app: async (op, args) => ({ status: 200, text: JSON.stringify({ op, args }) }),
      pickImages: async () => ({ files: [], skipped: [] }),
    },
  };
  return f;
}

// ---- the HTTP way

type Fetched = { url: URL; init: RequestInit };
const fetched: Fetched[] = [];
let httpBackend: Backend = echo;
let failFetch: Error | null = null;
const realFetch = globalThis.fetch;
const realES = (globalThis as any).EventSource;
class FakeES {
  static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
  static made: FakeES[] = [];
  readyState = 0; url: string; closed = false;
  onopen?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
  constructor(url: string) { this.url = url; FakeES.made.push(this); }
  close() { this.closed = true; this.readyState = 2; }
}
beforeEach(() => {
  fetched.length = 0; failFetch = null; httpBackend = echo; FakeES.made.length = 0;
  globalThis.fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, "http://127.0.0.1:1/");
    fetched.push({ url, init });
    if (failFetch) throw failFetch;
    if (init.signal?.aborted) throw init.signal.reason;
    if (url.pathname === "/host/call") {
      const type = (init.headers as Record<string, string> | undefined)?.["Content-Type"];
      const body = init.body === undefined ? undefined : typeof init.body === "string" ? JSON.parse(init.body) : `<${(init.body as Blob).size} bytes>`;
      const a = await httpBackend({ server: url.searchParams.get("server")!, method: url.searchParams.get("method")!, path: url.searchParams.get("path")!, body, ...(typeof init.body === "string" || init.body === undefined ? {} : { type }) });
      return new Response(a.status === 204 ? null : a.text, { status: a.status, headers: a.sceneRev === null ? {} : { "X-AIWB-Scene-Rev": String(a.sceneRev) } });
    }
    return new Response(JSON.stringify({ path: url.pathname, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) }), { status: 200 });
  }) as typeof fetch;
  (globalThis as any).EventSource = FakeES;
});
afterEach(() => { globalThis.fetch = realFetch; (globalThis as any).EventSource = realES; });

test("http call: a POST to the host with the server, method and path in the query, the JSON body as it is, no cache; the answer is the call's status, body and scene revision", async () => {
  const t = httpTransport();
  assert.equal(t.way, "http");
  const a = await t.call({ server: "s_1", method: "PUT", path: "/api/boards/b_1/scene?rev=3", body: { json: '{"elements":[]}' }, keepalive: true });
  const { url, init } = fetched[0];
  assert.deepEqual([url.pathname, init.method, init.cache, init.keepalive], ["/host/call", "POST", "no-store", true]);
  assert.deepEqual([url.searchParams.get("server"), url.searchParams.get("method"), url.searchParams.get("path")], ["s_1", "PUT", "/api/boards/b_1/scene?rev=3"]);
  assert.equal(init.body, '{"elements":[]}');
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.equal(a.status, 200);
  assert.deepEqual(await t.call({ server: "local", method: "GET", path: "/api/boards/b_1/scene" }), { status: 200, text: '{"elements":[]}', sceneRev: 7 });
  assert.equal("body" in fetched[1].init, false, "no body, none sent");
  assert.deepEqual(await t.call({ server: "local", method: "GET", path: "/api/missing" }), { status: 404, text: JSON.stringify({ error: "not found", code: "not_found" }), sceneRev: null });
});

test("http call: bytes go as they are with their type", async () => {
  const t = httpTransport();
  const blob = new Blob([new Uint8Array([1, 2, 3])]);
  await t.call({ server: "local", method: "POST", path: "/api/chats/c_1/images?name=a.png", body: { bytes: blob, type: "image/png" } });
  assert.equal(fetched[0].init.body, blob);
  assert.deepEqual(fetched[0].init.headers, { "Content-Type": "image/png" });
});

test("http call: aborting rejects with the abort; the way failing is a TransportError", async () => {
  const t = httpTransport();
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => t.call({ server: "local", method: "GET", path: "/api/x", signal: ac.signal }), isAbort);
  const why = new AbortController();
  failFetch = new Error("connection refused");
  why.abort(new Error("the user left"));
  await assert.rejects(() => t.call({ server: "local", method: "GET", path: "/api/x", signal: why.signal }), /the user left/);
  await assert.rejects(() => t.call({ server: "local", method: "GET", path: "/api/x" }), (e: unknown) => e instanceof TransportError && /connection refused/.test(e.message));
});

test("http stream: one EventSource on the host; open and closed are its states; a reconnecting error is none; a message that is no JSON is dropped; close ends it", () => {
  const t = httpTransport();
  const got: Envelope[] = [], states: StreamState[] = [];
  const s = t.stream((e) => got.push(e), (x) => states.push(x));
  const es = FakeES.made[0];
  assert.equal(es.url, "/host/events");
  es.onopen!(); assert.deepEqual(states, ["open"]);
  const a = { server: "local", event: { type: "hello" } }, b = { app: { type: "server_state", server: { id: "s_1", name: "x", state: "connected" } } };
  es.onmessage!({ data: JSON.stringify(a) }); es.onmessage!({ data: "not json" }); es.onmessage!({ data: JSON.stringify(b) });
  assert.deepEqual(got, [a, b]);
  es.readyState = 0; es.onerror!();
  assert.deepEqual(states, ["open"], "the browser reconnects by itself: the host greets again");
  es.readyState = 2; es.onerror!();
  assert.deepEqual(states, ["open", "closed"]);
  s.close();
  assert.equal(es.closed, true);
  es.onmessage!({ data: JSON.stringify(a) }); es.onerror!();
  assert.equal(got.length, 2);
  assert.deepEqual(states, ["open", "closed"]);
});

test("http: the address of a picture is on the host with the server, the chat and the image, each one segment; an app operation is a POST to the host", async () => {
  const t = httpTransport();
  assert.equal(t.pictureURL!("s_1", "c_1", "ab12"), "/host/picture/s_1/c_1/ab12");
  assert.equal(t.pictureURL!("local", "c 1", "a/b?c"), "/host/picture/local/c%201/a%2Fb%3Fc");
  assert.equal(t.pickImages, undefined, "the composer uses the browser's own picker");
  const a = await t.app("servers.remove", { id: "s_1" });
  assert.deepEqual([a.status, JSON.parse(a.text)], [200, { path: "/host/app/servers.remove", body: { id: "s_1" } }]);
  assert.equal(fetched[0].init.method, "POST");
  await t.app("owner.restart");
  assert.equal("body" in fetched[1].init, false);
});

// ---- the two ways mean the same

/** The same fake server behind both ways: a call answers by the backend, whichever way it came. */
function bothWays(): { name: string; t: Transport; push(batch: Envelope[]): void; end(): void; opened(): void }[] {
  const f = bridgeFake(), ipc = desktopTransport(f.bridge);
  const http = httpTransport();
  return [
    { name: "ipc", t: ipc, push: (b) => f.push(b), end: () => f.state("closed"), opened: () => f.state("open") },
    { name: "http", t: http, push: (b) => { const es = FakeES.made.at(-1)!; for (const e of b) es.onmessage!({ data: JSON.stringify(e) }); }, end: () => { const es = FakeES.made.at(-1)!; es.readyState = 2; es.onerror!(); }, opened: () => FakeES.made.at(-1)!.onopen!() },
  ];
}

const REQUESTS: CallRequest[] = [
  { server: "local", method: "GET", path: "/api/state" },
  { server: "s_1", method: "POST", path: "/api/chats/c_1/messages?branch=main", body: { json: '{"text":"hi","context":""}' } },
  { server: "s_1", method: "PUT", path: "/api/boards/b_1/scene?rev=2", body: { json: '{"elements":[{"id":"a"}]}' } },
  { server: "s_1", method: "GET", path: "/api/boards/b_1/scene" },
  { server: "local", method: "DELETE", path: "/api/chats/c_9" },
  { server: "local", method: "GET", path: "/api/missing" },
  { server: "local", method: "POST", path: "/api/empty" },
  { server: "local", method: "GET", path: "/api/text" },
  { server: "s_2", method: "POST", path: "/api/chats/c_1/images?name=a%20b.png", body: { bytes: new Blob([new Uint8Array([137, 80])]), type: "image/png" } },
];

test("the same requests give the same answers over IPC and over HTTP: status, body, scene revision, refusals, empty and plain bodies, bytes", async () => {
  const answers: Record<string, CallAnswer[]> = {};
  for (const w of bothWays()) {
    answers[w.name] = [];
    for (const r of REQUESTS) answers[w.name].push(await w.t.call(r));
  }
  assert.deepEqual(answers.ipc, answers.http);
  assert.equal(answers.ipc.length, REQUESTS.length);
  assert.equal(answers.ipc[3].sceneRev, 7);
  assert.equal(answers.ipc[5].status, 404);
});

test("the same envelopes arrive in the same order over IPC and over HTTP, and a stream closed for good is told the same", async () => {
  const seen: Record<string, (Envelope | StreamState)[]> = {};
  const script: Envelope[] = [
    { app: { type: "servers", servers: [{ id: "local", local: true, name: "This computer", state: "connected" }], notice: "" } },
    { server: "local", event: { type: "hello" } },
    { server: "local", event: { type: "snapshot", groups: [] } },
    { server: "s_1", event: { type: "hello" } },
    { app: { type: "server_state", server: { id: "s_1", name: "Studio", state: "connected" } } },
    { server: "s_1", event: { type: "chat_items", chat: "c_1", version: 2 } },
    { server: "local", event: { type: "chat_items", chat: "c_1", version: 7 } },
  ];
  for (const w of bothWays()) {
    seen[w.name] = [];
    const s = w.t.stream((e) => seen[w.name].push(e), (st) => seen[w.name].push(st));
    await tick();
    w.opened();
    w.push(script.slice(0, 3)); w.push(script.slice(3, 4)); w.push(script.slice(4));
    w.end();
    s.close();
  }
  assert.deepEqual(seen.ipc, seen.http);
  assert.deepEqual(seen.ipc, ["open", ...script, "closed"]);
});

test("a stream is opened again after a close: the new one has its own listeners and the old one none", async () => {
  for (const w of bothWays()) {
    const a: Envelope[] = [], b: Envelope[] = [];
    const first = w.t.stream((e) => a.push(e), () => {});
    await tick();
    first.close();
    w.t.stream((e) => b.push(e), () => {});
    await tick();
    const e = { server: "local", event: { type: "hello" } };
    w.push([e]);
    assert.deepEqual([a.length, b.length], [0, 1], w.name);
  }
});

// ---- the choice of the way

test("the way is IPC when the window gave the page its bridge, HTTP when the page was loaded over http, none otherwise", () => {
  assert.equal(wayOf({ aiwbTransport: {}, location: { protocol: "file:" } }), "ipc");
  assert.equal(wayOf({ aiwbTransport: {}, location: { protocol: "http:" } }), "ipc", "the window's bridge wins");
  assert.equal(wayOf({ location: { protocol: "http:" } }), "http");
  assert.equal(wayOf({ location: { protocol: "file:" } }), null);
  assert.equal(wayOf({ location: { protocol: "https:" } }), null, "https is no host of the tests");
  assert.equal(wayOf(undefined), null);
});

test("the way is native in the phone's app (navigator.product), before any other; transport() there is the one the app set, and none until then", () => {
  const rn = { product: "ReactNative" };
  assert.equal(wayOf(undefined, rn), "native");
  assert.equal(wayOf({ location: { protocol: "http:" } }, rn), "native");
  assert.equal(wayOf({ aiwbTransport: {} }, rn), "native");
  assert.equal(wayOf({ location: { protocol: "http:" } }, { product: "Gecko" }), "http");
  assert.equal(wayOf(undefined, undefined), null);
  const was = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: rn, configurable: true });
  try {
    useTransport(null);
    assert.throws(() => transport(), /useTransport/);
    const own = { ...desktopTransport(bridgeFake().bridge), way: "native" as const };
    useTransport(own);
    assert.equal(transport(), own);
  } finally {
    useTransport(null);
    if (was) Object.defineProperty(globalThis, "navigator", was); else delete (globalThis as any).navigator;
  }
});

// ---- picture(): the address, given asynchronously

for (const way of ["http"] as const) {
  test(`${way}: picture() gives the same address as pictureURL(), each part one segment; an aborted signal rejects before an address is given`, async () => {
    const t = httpTransport();
    for (const [s, c, i] of [["s_1", "c_1", "ab12"], ["local", "c 1", "a/b?c"]]) {
      assert.equal(await t.picture(s, c, i), t.pictureURL!(s, c, i));
      assert.equal(await t.picture(s, c, i, new AbortController().signal), t.pictureURL!(s, c, i));
    }
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(t.picture("s_1", "c_1", "ab12", ac.signal), isAbort);
    const reason = new Error("because");
    const ac2 = new AbortController();
    ac2.abort(reason);
    await assert.rejects(t.picture("s_1", "c_1", "ab12", ac2.signal), (e) => e === reason);
  });
}

test("transport(): the one the page has, the same each time; none is an error that names the app; a test puts its own in the place", () => {
  useTransport(null);
  assert.throws(() => transport(), /runs in its app/);
  const fake = desktopTransport(bridgeFake().bridge);
  useTransport(fake);
  assert.equal(transport(), fake);
  assert.equal(transport(), transport());
  useTransport(null);
});

// ---- the one place (core's half; the app's whole is read by app/test/noplainhttp.test.ts)

test("nothing of the page outside src/transport reaches the network, the app's functions or the host: no fetch, no EventSource, no aiwbTransport, no /host/, no /api/on, no aiwbDesktop", () => {
  const files = sourceNames().filter((f) => /\.(ts|tsx)$/.test(f) && !f.startsWith("transport" + path.sep));
  assert.ok(files.length > 50, "core was found");
  /** The code of a file without its comments and the text of its strings that are not paths. */
  const code = (f: string) => sourceOf(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  // the files that write the paths of the client API for the transport (a path is not a URL to load)
  const paths = new Set(["api.ts", "libraryapi.ts", "logic/keys.ts"]);
  for (const f of files) {
    const c = code(f), rel = f;
    for (const bad of [/\bfetch\(/, /\bEventSource\b/, /\baiwbTransport\b/, /\baiwbDesktop\b/, /\/host\//, /\/api\/on\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bWebSocket\b/])
      assert.equal(bad.test(c), false, `${rel} has ${bad}`);
    if (!paths.has(f)) assert.equal(/["'`]\/api\//.test(c), false, `${rel} names a path of the client API`);
  }
});
