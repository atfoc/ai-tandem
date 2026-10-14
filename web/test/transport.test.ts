// The page's transport (src/transport): the IPC way against a fake `window.aiwbApp`, the HTTP way against a fake `fetch` and
// `EventSource`, and that the two mean the same: the same calls give the same answers, the stream gives the same envelopes in
// the same order, and a stream that ended for good is told the same way. And the choice of the way when the page starts, and
// that nothing of the page outside src/transport/ reaches the network itself.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ipcTransport, type AiwbApp } from "../src/transport/ipc.ts";
import { httpTransport } from "../src/transport/http.ts";
import { transport, useTransport, wayOf } from "../src/transport/index.ts";
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

// ---- the IPC way

type IpcFake = { app: AiwbApp; calls: { id: string; server: string; method: string; path: string; body?: any }[]; cancelled: string[]; streamCalls: boolean[];
  push(batch: Envelope[]): void; state(s: StreamState): void; offs: string[]; apps: { op: string; args: unknown }[]; failStream: boolean; backend: Backend; held: Map<string, (a: CallAnswer) => void> };
function ipcFake(): IpcFake {
  let events: ((b: Envelope[]) => void) | null = null, states: ((s: StreamState) => void) | null = null;
  const f: IpcFake = {
    calls: [], cancelled: [], streamCalls: [], offs: [], apps: [], failStream: false, backend: echo, held: new Map(),
    push: (b) => events?.(b), state: (s) => states?.(s),
    app: {
      call: async (req) => {
        f.calls.push(req);
        if (req.path === "/api/hang") return new Promise<CallAnswer>((resolve) => f.held.set(req.id, resolve));
        if (req.path === "/api/broken") throw new Error("the window lost the app");
        const body = req.body && "json" in req.body ? JSON.parse(req.body.json) : req.body ? `<${req.body.bytes.length} bytes>` : undefined;
        return f.backend({ server: req.server, method: req.method, path: req.path, body, ...(req.body && "bytes" in req.body ? { type: req.body.type } : {}) });
      },
      cancel: (id) => { f.cancelled.push(id); },
      stream: async (open) => { f.streamCalls.push(open); if (open && f.failStream) throw new Error("no"); return { ok: true as const }; },
      onEvents: (cb) => { events = cb; return () => { f.offs.push("events"); events = null; }; },
      onStreamState: (cb) => { states = cb; return () => { f.offs.push("state"); states = null; }; },
      app: async (op, args) => { f.apps.push({ op, args }); return { status: 200, text: JSON.stringify({ op, args }) }; },
      pickImages: async () => ({ files: [], skipped: [] }),
    },
  };
  return f;
}

test("ipc call: the server, method, path and a JSON body go as they are, with an id of the call's own; the answer comes as it is", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  assert.equal(t.way, "ipc");
  const a = await t.call({ server: "s_1", method: "POST", path: "/api/chats/c_1/messages?branch=main", body: { json: '{"text":"hi"}' } });
  assert.deepEqual(a, { status: 200, text: JSON.stringify({ server: "s_1", method: "POST", path: "/api/chats/c_1/messages?branch=main", body: { text: "hi" } }), sceneRev: null });
  assert.match(f.calls[0].id, /^[0-9a-f-]{36}$/);
  await t.call({ server: "local", method: "GET", path: "/api/state" });
  assert.notEqual(f.calls[0].id, f.calls[1].id);
  assert.equal("body" in f.calls[1], false, "no body, none sent");
  assert.deepEqual(await t.call({ server: "local", method: "GET", path: "/api/missing" }), { status: 404, text: JSON.stringify({ error: "not found", code: "not_found" }), sceneRev: null }, "a refusal is an answer, not a rejection");
  assert.deepEqual(await t.call({ server: "local", method: "GET", path: "/api/boards/b_1/scene" }), { status: 200, text: '{"elements":[]}', sceneRev: 7 });
});

test("ipc call: a Blob goes as bytes with its type; bytes stay bytes", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  await t.call({ server: "local", method: "POST", path: "/api/chats/c_1/images", body: { bytes: new Blob([new Uint8Array([1, 2, 3])]), type: "image/png" } });
  const sent = f.calls[0].body;
  assert.ok(sent.bytes instanceof Uint8Array);
  assert.deepEqual([...sent.bytes], [1, 2, 3]);
  assert.equal(sent.type, "image/png");
  const raw = new Uint8Array([9, 8]);
  await t.call({ server: "local", method: "POST", path: "/api/chats/c_1/images", body: { bytes: raw, type: "image/jpeg" } });
  assert.equal(f.calls[1].body.bytes, raw);
});

test("ipc call: aborting cancels the call in the app by its id and rejects with the abort; one aborted already makes no call; the answer of an aborted call is dropped", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  const ac = new AbortController();
  const p = t.call({ server: "local", method: "GET", path: "/api/hang", signal: ac.signal });
  await tick();
  assert.equal(f.cancelled.length, 0);
  ac.abort();
  await assert.rejects(p, isAbort);
  assert.deepEqual(f.cancelled, [f.calls[0].id]);
  f.held.get(f.calls[0].id)!({ status: 200, text: "late", sceneRev: null }); // (the answer that comes anyway is nobody's)
  await tick();
  const done = new AbortController();
  await assert.rejects(() => t.call({ server: "local", method: "GET", path: "/api/x", signal: (done.abort(), done.signal) }), isAbort);
  assert.equal(f.calls.length, 1, "no call for a signal that was aborted");
  // a call that ended is not cancelled by an abort after it
  const late = new AbortController();
  await t.call({ server: "local", method: "GET", path: "/api/x", signal: late.signal });
  late.abort();
  assert.equal(f.cancelled.length, 1);
  // a signal with a reason rejects with it
  const why = new AbortController();
  const q = t.call({ server: "local", method: "GET", path: "/api/hang", signal: why.signal });
  await tick();
  why.abort(new Error("the user left"));
  await assert.rejects(q, /the user left/);
});

test("ipc call: the way failing is a TransportError, not an answer", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  await assert.rejects(() => t.call({ server: "local", method: "GET", path: "/api/broken" }), (e: unknown) => e instanceof TransportError && /lost the app/.test(e.message));
});

test("ipc stream: the window is asked to subscribe after the page listens; envelopes come in the order of the batches; close lets go of both", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  const got: Envelope[] = [], states: StreamState[] = [];
  const s = t.stream((e) => got.push(e), (x) => states.push(x));
  await tick();
  assert.deepEqual(f.streamCalls, [true]);
  const a = { app: { type: "servers", servers: [], notice: "" } } as Envelope, b = { server: "local", event: { type: "hello" } }, c = { server: "s_1", event: { type: "snapshot" } }, d = { server: "local", event: { type: "chat" } };
  f.push([a, b]); f.push([c]); f.push([d]);
  f.state("open");
  assert.deepEqual(got, [a, b, c, d]);
  assert.deepEqual(states, ["open"]);
  s.close();
  assert.deepEqual(f.offs.sort(), ["events", "state"]);
  assert.deepEqual(f.streamCalls, [true, false]);
  f.push([a]); f.state("closed");
  assert.equal(got.length, 4);
  s.close();
  assert.deepEqual(f.streamCalls, [true, false], "closing twice asks once");
});

test("ipc stream: a subscription the window refused is a stream closed for good", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  f.failStream = true;
  const states: StreamState[] = [];
  t.stream(() => {}, (x) => states.push(x));
  await tick();
  assert.deepEqual(states, ["closed"]);
});

test("ipc: the address of a picture is the app's scheme with the server, the chat and the image, each one segment; the app's operations go through; the dialog is the window's", async () => {
  const f = ipcFake(), t = ipcTransport(f.app);
  assert.equal(t.pictureURL("s_1", "c_1", "ab12"), "aiwb-picture://p/s_1/c_1/ab12");
  assert.equal(t.pictureURL("local", "c 1", "a/b?c"), "aiwb-picture://p/local/c%201/a%2Fb%3Fc");
  assert.deepEqual(await t.app("servers.remove", { id: "s_1" }), { status: 200, text: JSON.stringify({ op: "servers.remove", args: { id: "s_1" } }) });
  assert.deepEqual(await t.app("owner.restart"), { status: 200, text: JSON.stringify({ op: "owner.restart" }) });
  assert.deepEqual(await t.pickImages!(), { files: [], skipped: [] });
});

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
  assert.equal(t.pictureURL("s_1", "c_1", "ab12"), "/host/picture/s_1/c_1/ab12");
  assert.equal(t.pictureURL("local", "c 1", "a/b?c"), "/host/picture/local/c%201/a%2Fb%3Fc");
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
  const f = ipcFake(), ipc = ipcTransport(f.app);
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

test("the way is IPC when the window gave the page its functions, HTTP when the page was loaded over http, none otherwise", () => {
  assert.equal(wayOf({ aiwbApp: {}, location: { protocol: "file:" } }), "ipc");
  assert.equal(wayOf({ aiwbApp: {}, location: { protocol: "http:" } }), "ipc", "the window's functions win");
  assert.equal(wayOf({ location: { protocol: "http:" } }), "http");
  assert.equal(wayOf({ location: { protocol: "file:" } }), null);
  assert.equal(wayOf({ location: { protocol: "https:" } }), null, "https is no host of the tests");
  assert.equal(wayOf(undefined), null);
});

test("transport(): the one the page has, the same each time; none is an error that names the app; a test puts its own in the place", () => {
  useTransport(null);
  assert.throws(() => transport(), /runs in its app/);
  const fake = ipcTransport(ipcFake().app);
  useTransport(fake);
  assert.equal(transport(), fake);
  assert.equal(transport(), transport());
  useTransport(null);
});

// ---- the one place

test("nothing of the page outside src/transport reaches the network, the app's functions or the host: no fetch, no EventSource, no aiwbApp, no /host/, no /api/on, no aiwbDesktop", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "transport") walk(p); } else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  })(root);
  assert.ok(files.length > 100, "the page was found");
  /** The code of a file without its comments and the text of its strings that are not paths. */
  const code = (f: string) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  // the files that write the paths of the client API for the transport (a path is not a URL to load)
  const paths = new Set(["api.ts", "libraryapi.ts", "logic/keys.ts"].map((f) => path.join(root, f)));
  for (const f of files) {
    const c = code(f), rel = path.relative(root, f);
    for (const bad of [/\bfetch\(/, /\bEventSource\b/, /\baiwbApp\b/, /\baiwbDesktop\b/, /\/host\//, /\/api\/on\b/, /\bXMLHttpRequest\b/, /\bsendBeacon\b/, /\bWebSocket\b/])
      assert.equal(bad.test(c), false, `${rel} has ${bad}`);
    if (!paths.has(f)) assert.equal(/["'`]\/api\//.test(c), false, `${rel} names a path of the client API`);
  }
});
