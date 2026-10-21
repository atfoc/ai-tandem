// The voice net (architecture VC-4, VC-5, VC-6) over fakes: `origin.ts`, the direct net (a phone's header, the web build's token) with a
// fake fetch and a fake socket, and the desktop's bridge with a fake `window.aiwbVoice`. Nothing here reaches a network, and no address
// of the real service is called. Loaded by Node: the files under test import no react-native and no expo-*.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import { createVoiceStandin } from "../../web/dev/voicestandin.mjs";
import { VoiceNetError, VoiceProblemError } from "../src/voice/ports.ts";
import type { Keystore, NetAnswer } from "../src/voice/ports.ts";
import { STT_PATH, TOKEN_PATH, VOICES_PATH, sttQuery, ttsBody, ttsPath, ttsQuery } from "../src/voice/logic/protocol.ts";
import { DEFAULTS } from "../src/voice/logic/settings.ts";
import { createDirectNet, type FetchInit, type FetchLike, type RawSocket, type ResponseLike } from "../src/voice/platform/net.core.ts";
import { bridgeNet, webNet } from "../src/voice/platform/net.web.ts";
import { createKeystore, memoryVault } from "../src/voice/platform/keystore.core.ts";
import { isLocalHost, makeVoiceURL, pageVoiceURL, voiceBase } from "../src/voice/platform/origin.ts";
import type { AiwbVoiceBridge, VoiceBridgeEvent } from "../src/voice/platform/bridge.types.ts";

const KEY = "sk_test_RecognisableKey0123";
const enc = new TextEncoder();
const dec = new TextDecoder();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function read(a: NetAnswer): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const c of a.body) out.push(c);
  return out;
}

describe("origin.ts: the one place an address is made", () => {
  it("is the service's own by default, with the path and an encoded query", () => {
    const url = makeVoiceURL(undefined, true);
    assert.equal(url("http", "/v2/voices", { page_size: "1", search: "a b&c" }), "https://api.elevenlabs.io/v2/voices?page_size=1&search=a%20b%26c");
    assert.equal(url("ws", STT_PATH, { model_id: "scribe_v2_realtime" }), "wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime");
    assert.equal(url("http", "/v1/x", {}), "https://api.elevenlabs.io/v1/x");
  });

  it("takes the override in a development build and for a local host only", () => {
    assert.deepEqual(voiceBase("http://127.0.0.1:4750", true), { http: "http://127.0.0.1:4750", ws: "ws://127.0.0.1:4750" });
    assert.deepEqual(voiceBase("https://localhost:4750/", true), { http: "https://localhost:4750", ws: "wss://localhost:4750" });
    for (const local of ["http://10.0.2.2:1", "http://192.168.1.20:80", "http://172.16.0.9", "http://172.31.255.255:9", "http://10.1.2.3"]) {
      assert.equal(voiceBase(local, true).http, local, local);
    }
    assert.equal(makeVoiceURL("http://127.0.0.1:4750", true)("ws", "/voice/x", {}), "ws://127.0.0.1:4750/voice/x");
    // the stand-in under a prefix, as the mock and the device flow serve it
    assert.deepEqual(voiceBase("http://127.0.0.1:4750/voice", true), { http: "http://127.0.0.1:4750/voice", ws: "ws://127.0.0.1:4750/voice" });
    assert.deepEqual(voiceBase("http://10.0.2.2:4750/voice/", true), { http: "http://10.0.2.2:4750/voice", ws: "ws://10.0.2.2:4750/voice" });
    assert.equal(makeVoiceURL("http://127.0.0.1:4750/voice", true)("http", "/v2/voices", {}), "http://127.0.0.1:4750/voice/v2/voices");
  });

  it("ignores the override in a Release build", () => {
    const base = voiceBase("http://127.0.0.1:4750", false);
    assert.equal(base.http, "https://api.elevenlabs.io");
    assert.equal(base.ws, "wss://api.elevenlabs.io");
    assert.equal(makeVoiceURL("http://127.0.0.1:4750", false)("http", "/v2/voices", {}), "https://api.elevenlabs.io/v2/voices");
  });

  it("ignores the override for a public host, a look-alike, a user part, a path that is not plain or a bad port", () => {
    for (const bad of [
      "http://example.com", "http://api.elevenlabs.io", "http://127.0.0.1.example.com", "http://localhost.evil.test", "http://172.32.0.1",
      "http://172.15.0.1", "http://192.169.1.1", "http://11.0.0.1", "http://256.0.0.1", "http://169.254.169.254", "http://user@127.0.0.1",
      "http://127.0.0.1@evil.test", "http://127.0.0.1:99999", "http://127.0.0.1/../x", "http://127.0.0.1//x", "http://127.0.0.1/x?y",
      "http://127.0.0.1/a.b", "http://example.com/voice", "ftp://127.0.0.1", "127.0.0.1", "", "http://[::1]:5",
    ]) {
      assert.equal(voiceBase(bad, true).http, "https://api.elevenlabs.io", bad);
    }
    assert.equal(isLocalHost("127.0.0.1") && isLocalHost("localhost") && isLocalHost("10.0.2.2"), true);
    assert.equal(isLocalHost("8.8.8.8") || isLocalHost("api.elevenlabs.io"), false);
  });

  it("refuses a path that is not plain", () => {
    const url = makeVoiceURL(undefined, false);
    for (const bad of ["//evil.test/x", "v1/x", "/v1/../x", "/v1/x?key=1", "/v1/x#y", "/v1/ x", "@evil.test", ""]) {
      assert.throws(() => url("http", bad, {}), /not a path/, bad);
    }
  });

  it("makes the page-direct address under /voice on a local origin only", () => {
    assert.equal(pageVoiceURL("http://127.0.0.1:5000", "http", "/v2/voices", { a: "1" }), "http://127.0.0.1:5000/voice/v2/voices?a=1");
    assert.equal(pageVoiceURL("http://localhost:5000", "ws", STT_PATH, {}), "ws://localhost:5000/voice/v1/speech-to-text/realtime");
    for (const origin of [undefined, "null", "https://app.example.com", "file://", "http://evil.test:80"]) {
      assert.throws(() => pageVoiceURL(origin, "http", "/v2/voices", {}), /no voice service/, String(origin));
    }
  });
});

// ---- a fake fetch and a fake socket

type Call = { url: string; init: FetchInit };
function fakeFetch(answer: (c: Call) => { status?: number; chunks?: string[]; json?: unknown; hang?: boolean; cutAfter?: number } | Error) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const c = { url, init };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    const chunks = a.chunks ?? (a.json === undefined ? [] : [JSON.stringify(a.json)]);
    let i = 0;
    let cancelled = false;
    const res: ResponseLike = {
      status: a.status ?? 200,
      body: {
        getReader: () => ({
          async read() {
            if (a.hang) await new Promise<void>((resolve) => init.signal.addEventListener("abort", () => resolve(), { once: true }));
            if (cancelled || init.signal.aborted || i === a.cutAfter) throw new Error(`cut ${url} ${KEY}`);
            return i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true };
          },
          async cancel() { cancelled = true; },
        }),
      },
      text: async () => chunks.join(""),
    };
    return res;
  };
  return { f, calls };
}

class FakeSocket implements RawSocket {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code?: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  readonly url: string;
  readonly headers?: Record<string, string>;
  constructor(url: string, headers?: Record<string, string>) { this.url = url; this.headers = headers; }
  send(t: string) { this.sent.push(t); }
  close() { this.closed = true; }
}

function directNet(opts: { auth: "header" | "token"; key?: string | null; answer?: Parameters<typeof fakeFetch>[0]; origin?: string }) {
  const fetched = fakeFetch(opts.answer ?? (() => ({ json: {} })));
  const sockets: FakeSocket[] = [];
  const address = opts.auth === "header"
    ? makeVoiceURL("http://127.0.0.1:4750", true)
    : (kind: "http" | "ws", path: string, query: Record<string, string>) => pageVoiceURL("http://127.0.0.1:5000", kind, path, query);
  const net = createDirectNet({
    fetch: fetched.f,
    openSocket: (url, headers) => { const s = new FakeSocket(url, headers); sockets.push(s); return s; },
    keyOf: async () => (opts.key === undefined ? KEY : opts.key),
    address,
    socketAuth: opts.auth,
    previewOk: (url) => url.startsWith("https://"),
  });
  return { net, calls: fetched.calls, sockets };
}

const noEvents = (log: string[] = []) => ({
  open: () => { log.push("open"); },
  message: (t: string) => { log.push(`message ${t}`); },
  close: (c: number) => { log.push(`close ${c}`); },
  error: () => { log.push("error"); },
});

describe("the direct net: a phone", () => {
  it("a request adds the key as a header, sends the sentence as JSON and streams the body", async () => {
    const { net, calls } = directNet({ auth: "header", answer: () => ({ chunks: ["ab", "cde"] }) });
    const body = ttsBody("Hello there.", DEFAULTS);
    const a = await net.request({ method: "POST", path: ttsPath("vs_alice"), query: ttsQuery(), json: body }, new AbortController().signal);
    assert.equal(a.status, 200);
    assert.deepEqual((await read(a)).map((c) => dec.decode(c)), ["ab", "cde"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:4750/v1/text-to-speech/vs_alice/stream?output_format=pcm_24000");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["xi-api-key"], KEY);
    assert.equal(calls[0].init.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(calls[0].init.body as string), body);
  });

  it("the key is in no address, and a Test key (the key given in the request) wins over the stored one", async () => {
    const { net, calls } = directNet({ auth: "header" });
    await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "1" }, key: "sk_test_Typed" }, new AbortController().signal);
    await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    assert.equal(calls[0].init.headers["xi-api-key"], "sk_test_Typed");
    assert.equal(calls[1].init.headers["xi-api-key"], KEY);
    assert.equal(calls[1].init.headers["content-type"], undefined, "no body, no content type");
    assert.equal(calls[1].init.body, undefined);
    for (const c of calls) assert.ok(!c.url.includes(KEY) && !c.url.includes("Typed") && !c.url.includes("xi-api-key"));
  });

  it("reads the key for each call and keeps no copy", async () => {
    let key: string | null = "sk_test_One";
    const fetched = fakeFetch(() => ({ json: {} }));
    const net = createDirectNet({
      fetch: fetched.f, openSocket: () => new FakeSocket(""), keyOf: async () => key,
      address: makeVoiceURL(undefined, false), socketAuth: "header", previewOk: () => false,
    });
    await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    key = "sk_test_Two";
    await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    assert.deepEqual(fetched.calls.map((c) => c.init.headers["xi-api-key"]), ["sk_test_One", "sk_test_Two"]);
    key = null;
    await assert.rejects(net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal), (e) => e instanceof VoiceProblemError && e.kind === "no_key");
    assert.equal(fetched.calls.length, 2, "no key, no call");
  });

  it("an answer that is an error still has its status and its text", async () => {
    const { net } = directNet({ auth: "header", answer: () => ({ status: 401, json: { detail: { code: "invalid_api_key" } } }) });
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    assert.equal(a.status, 401);
    assert.deepEqual(JSON.parse(await a.text()), { detail: { code: "invalid_api_key" } });
  });

  it("no network is a VoiceNetError with no text of the library; a cancelled call is an AbortError", async () => {
    const down = directNet({ auth: "header", answer: (c) => new TypeError(`Network request failed ${c.url} ${KEY}`) });
    await assert.rejects(down.net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal), (e: Error) => {
      return e instanceof VoiceNetError && !e.message.includes(KEY) && !e.message.includes("127.0.0.1");
    });
    const c = new AbortController();
    const { net } = directNet({ auth: "header", answer: () => ({ chunks: ["a"], hang: true }) });
    const a = await net.request({ method: "GET", path: VOICES_PATH }, c.signal);
    const reading = read(a);
    await tick();
    c.abort();
    await assert.rejects(reading, (e: Error) => e.name === "AbortError");
    const done = new AbortController();
    done.abort();
    await assert.rejects(net.request({ method: "GET", path: VOICES_PATH }, done.signal), (e: Error) => e.name === "AbortError");
  });

  it("a body cut in the middle is a VoiceNetError without the library's text", async () => {
    const { net } = directNet({ auth: "header", answer: () => ({ chunks: ["a", "b"], cutAfter: 1 }) });
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    const got: string[] = [];
    await assert.rejects(
      (async () => { for await (const c of a.body) got.push(dec.decode(c)); })(),
      (e: Error) => e instanceof VoiceNetError && !e.message.includes(KEY) && !e.message.includes("127.0.0.1"),
    );
    assert.deepEqual(got, ["a"]);
  });

  it("the socket opens with the key as a header and no token, and carries frames both ways", async () => {
    const { net, calls, sockets } = directNet({ auth: "header" });
    const log: string[] = [];
    const s = net.socket(STT_PATH, sttQuery(DEFAULTS), noEvents(log));
    await tick();
    assert.equal(sockets.length, 1);
    const raw = sockets[0];
    assert.deepEqual(raw.headers, { "xi-api-key": KEY });
    assert.ok(raw.url.startsWith("ws://127.0.0.1:4750/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000"));
    assert.ok(!raw.url.includes("token") && !raw.url.includes(KEY));
    assert.equal(calls.length, 0, "no token request on a phone");
    s.send("early");
    raw.onopen?.();
    raw.onmessage?.({ data: "hello" });
    raw.onmessage?.({ data: new ArrayBuffer(2) });
    s.send("late");
    raw.onclose?.({ code: 1000 });
    assert.deepEqual(raw.sent, ["late"], "a frame before open is dropped");
    assert.deepEqual(log, ["open", "message hello", "close 1000"]);
  });

  it("the socket: an error then a close with a code and no text; own close() is quiet", async () => {
    const { net, sockets } = directNet({ auth: "header" });
    const log: string[] = [];
    net.socket(STT_PATH, {}, noEvents(log));
    await tick();
    sockets[0].onerror?.();
    sockets[0].onclose?.({});
    sockets[0].onclose?.({ code: 1000 });
    assert.deepEqual(log, ["error", "close 1006"], "one close only");
    const log2: string[] = [];
    const s = net.socket(STT_PATH, {}, noEvents(log2));
    await tick();
    sockets[1].onopen?.();
    s.close();
    sockets[1].onclose?.({ code: 1000 });
    sockets[1].onmessage?.({ data: "late" });
    assert.equal(sockets[1].closed, true);
    assert.deepEqual(log2, ["open"]);
  });

  it("the socket with no key says error and close, and opens nothing", async () => {
    const { net, sockets } = directNet({ auth: "header", key: null });
    const log: string[] = [];
    net.socket(STT_PATH, {}, noEvents(log));
    await tick();
    assert.deepEqual(log, ["error", "close 1008"]);
    assert.equal(sockets.length, 0);
  });

  it("close() before the key is read opens nothing", async () => {
    const { net, sockets } = directNet({ auth: "header" });
    const log: string[] = [];
    net.socket(STT_PATH, {}, noEvents(log)).close();
    await tick();
    assert.equal(sockets.length, 0);
    assert.deepEqual(log, []);
  });
});

describe("the direct net: the web build's page-direct way", () => {
  const tokenAnswer = (c: Call) => (c.url.includes(TOKEN_PATH) ? { json: { token: "sutkn_abc123" } } : { json: {} });

  it("asks a token with the key in a header, then opens the socket with the token in the query and no header", async () => {
    const { net, calls, sockets } = directNet({ auth: "token", answer: tokenAnswer });
    const log: string[] = [];
    net.socket(STT_PATH, sttQuery(DEFAULTS), noEvents(log));
    await tick();
    await tick();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:5000/voice/v1/single-use-token/realtime_scribe");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["xi-api-key"], KEY);
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].headers, undefined, "a browser's socket cannot set one");
    assert.ok(sockets[0].url.startsWith("ws://127.0.0.1:5000/voice/v1/speech-to-text/realtime?"));
    assert.ok(sockets[0].url.endsWith("&token=sutkn_abc123"));
    assert.ok(!sockets[0].url.includes(KEY), "the key is in no address");
    sockets[0].onopen?.();
    assert.deepEqual(log, ["open"]);
  });

  it("a request is the same as on a phone: the header, never a token", async () => {
    const { net, calls } = directNet({ auth: "token" });
    await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "4" } }, new AbortController().signal);
    assert.equal(calls[0].url, "http://127.0.0.1:5000/voice/v2/voices?page_size=4");
    assert.equal(calls[0].init.headers["xi-api-key"], KEY);
    assert.ok(!calls[0].url.includes("token"));
  });

  it("a refused token reaches the socket's owner as the service's own socket would say it", async () => {
    for (const [status, type] of [[401, "auth_error"], [402, "quota_exceeded"], [429, "rate_limited"]] as const) {
      const { net, sockets } = directNet({ auth: "token", answer: () => ({ status, json: {} }) });
      const log: string[] = [];
      net.socket(STT_PATH, {}, noEvents(log));
      await tick();
      await tick();
      assert.deepEqual(log, [`message {"message_type":"${type}"}`, "close 1008"]);
      assert.equal(sockets.length, 0);
    }
    const { net } = directNet({ auth: "token", answer: () => ({ status: 500, json: {} }) });
    const log: string[] = [];
    net.socket(STT_PATH, {}, noEvents(log));
    await tick();
    await tick();
    assert.deepEqual(log, ["error", "close 1006"]);
  });
});

describe("preview clips", () => {
  const voices = { voices: [{ voice_id: "vs_alice", preview_url: "https://storage.example.test/alice.mp3" }, { voice_id: "b", preview_url: "https://storage.example.test/b.mp3" }] };

  function withVoices(extra?: (c: Call) => ReturnType<Parameters<typeof fakeFetch>[0]>) {
    return directNet({
      auth: "header",
      answer: (c) => (extra?.(c) ?? (c.url.includes("/v2/voices") ? { json: voices } : { chunks: ["clip", "bytes"] })),
    });
  }

  it("fetches an address that came in a voices answer (read as text), with no key", async () => {
    const { net, calls } = withVoices();
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    await a.text();
    const bytes = await net.preview("https://storage.example.test/alice.mp3", new AbortController().signal);
    assert.equal(dec.decode(bytes), "clipbytes");
    const clip = calls[calls.length - 1];
    assert.equal(clip.url, "https://storage.example.test/alice.mp3");
    assert.deepEqual(clip.init.headers, {}, "the key never goes to the clip's host");
  });

  it("learns the addresses from the body when that is what was read", async () => {
    const { net } = withVoices();
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    await read(a);
    assert.equal((await net.preview("https://storage.example.test/b.mp3", new AbortController().signal)).length, 9);
  });

  it("refuses an address that did not come in a voices answer, and one that is not https", async () => {
    const { net, calls } = withVoices();
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    await a.text();
    const before = calls.length;
    for (const bad of ["https://evil.test/x.mp3", "https://storage.example.test/other.mp3", "http://storage.example.test/alice.mp3", "file:///etc/passwd", ""]) {
      await assert.rejects(net.preview(bad, new AbortController().signal), VoiceNetError, bad);
    }
    assert.equal(calls.length, before, "nothing was fetched");
  });

  it("learns nothing from another path's answer or an answer that is an error", async () => {
    const { net } = withVoices((c) => (c.url.includes("/v1/text-to-speech") ? { json: voices } : c.url.includes("page_size=9") ? { status: 401, json: voices } : undefined) as never);
    await (await net.request({ method: "POST", path: ttsPath("vs_alice"), json: {} }, new AbortController().signal)).text();
    await (await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "9" } }, new AbortController().signal)).text();
    await assert.rejects(net.preview("https://storage.example.test/alice.mp3", new AbortController().signal), VoiceNetError);
  });

  it("refuses a clip of more than 2 MB and an answer that is not 200", async () => {
    const big = "x".repeat(1024 * 1024);
    const { net } = withVoices((c) => (c.url.endsWith("alice.mp3") ? { chunks: [big, big, "y"] } : c.url.endsWith("b.mp3") ? { status: 404 } : undefined) as never);
    await (await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal)).text();
    await assert.rejects(net.preview("https://storage.example.test/alice.mp3", new AbortController().signal), VoiceNetError);
    await assert.rejects(net.preview("https://storage.example.test/b.mp3", new AbortController().signal), VoiceNetError);
  });
});

// ---- the desktop's bridge

function fakeBridge(opts: { status?: number; body?: string[]; failWith?: string; hang?: boolean } = {}) {
  const log: unknown[][] = [];
  let listener: ((e: VoiceBridgeEvent) => void) | null = null;
  let listeners = 0;
  const emit = (e: VoiceBridgeEvent) => listener?.(e);
  const bridge: AiwbVoiceBridge = {
    key: { has: async () => true, set: async () => {}, clear: async () => {} },
    async request(req) {
      log.push(["request", req]);
      if (opts.failWith) throw new Error(`Error invoking remote method: ${opts.failWith} (${KEY})`);
      // Body events come before the promise settles, as P5's notes say they may.
      for (const chunk of opts.body ?? []) emit({ id: req.id, kind: "data", bytes: enc.encode(chunk) });
      if (!opts.hang) emit({ id: req.id, kind: "end" });
      return { status: opts.status ?? 200 };
    },
    cancel: (id) => { log.push(["cancel", id]); },
    socket: {
      open: async (o) => { log.push(["socket.open", o]); if (opts.failWith) throw new Error(opts.failWith); },
      send: (id, text) => { log.push(["socket.send", id, text]); },
      close: (id) => { log.push(["socket.close", id]); },
    },
    preview: async (url) => { log.push(["preview", url]); if (opts.failWith) throw new Error(opts.failWith); return enc.encode("clip"); },
    mic: { status: async () => "granted", ask: async () => true, openSettings: async () => {} },
    on(cb) { listeners++; listener = cb; return () => { listeners--; listener = null; }; },
  };
  return { bridge, log, emit, listeners: () => listeners };
}

describe("the desktop's bridge", () => {
  it("a request goes to main with no key of the page's own, and the body comes as events", async () => {
    const f = fakeBridge({ body: ["ab", "cd"] });
    const net = bridgeNet(f.bridge);
    const a = await net.request({ method: "POST", path: ttsPath("vs_alice"), query: ttsQuery(), json: { text: "Hi." } }, new AbortController().signal);
    assert.equal(a.status, 200);
    assert.deepEqual((await read(a)).map((c) => dec.decode(c)), ["ab", "cd"]);
    const req = f.log[0][1] as { id: number; key?: string; method: string; path: string; query: unknown; json: unknown };
    assert.equal(req.key, undefined);
    assert.deepEqual([req.method, req.path, req.query, req.json], ["POST", "/v1/text-to-speech/vs_alice/stream", { output_format: "pcm_24000" }, { text: "Hi." }]);
    assert.equal(f.listeners(), 0, "no listener once every call is over");
  });

  it("a Test key typed in Settings is passed in the request, and in no other field", async () => {
    const f = fakeBridge({ body: ["{}"] });
    const net = bridgeNet(f.bridge);
    const a = await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "1" }, key: "sk_test_Typed" }, new AbortController().signal);
    assert.equal(await a.text(), "{}");
    const req = f.log[0][1] as Record<string, unknown>;
    assert.equal(req.key, "sk_test_Typed");
    assert.ok(!JSON.stringify({ ...req, key: undefined }).includes("Typed"));
  });

  it("the body of a call is its own: events of another call do not mix in", async () => {
    const f = fakeBridge({ body: ["one"], hang: true });
    const net = bridgeNet(f.bridge);
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    const id = (f.log[0][1] as { id: number }).id;
    f.emit({ id: id + 50, kind: "data", bytes: enc.encode("other") });
    f.emit({ id, kind: "data", bytes: enc.encode("two") });
    f.emit({ id, kind: "end" });
    assert.deepEqual((await read(a)).map((c) => dec.decode(c)), ["one", "two"]);
  });

  it("main's one-word failures become the port's errors, with none of the text", async () => {
    const abort = () => new AbortController().signal;
    await assert.rejects(bridgeNet(fakeBridge({ failWith: "voice_no_key" }).bridge).request({ method: "GET", path: VOICES_PATH }, abort()), (e) => e instanceof VoiceProblemError && e.kind === "no_key");
    await assert.rejects(bridgeNet(fakeBridge({ failWith: "voice_cancelled" }).bridge).request({ method: "GET", path: VOICES_PATH }, abort()), (e: Error) => e.name === "AbortError");
    for (const word of ["voice_unreachable", "voice_refused", "voice_failed", "something else"]) {
      const f = fakeBridge({ failWith: word });
      await assert.rejects(bridgeNet(f.bridge).request({ method: "GET", path: VOICES_PATH }, abort()), (e: Error) => e instanceof VoiceNetError && !e.message.includes(KEY) && !e.message.includes(word));
      assert.equal(f.listeners(), 0);
    }
  });

  it("a body that errors is a VoiceNetError; a cancel reaches main and is an AbortError", async () => {
    const f = fakeBridge({ hang: true });
    const net = bridgeNet(f.bridge);
    const a = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    const id = (f.log[0][1] as { id: number }).id;
    const reading = read(a);
    f.emit({ id, kind: "error" });
    await assert.rejects(reading, VoiceNetError);

    const g = fakeBridge({ hang: true });
    const c = new AbortController();
    const b = await bridgeNet(g.bridge).request({ method: "GET", path: VOICES_PATH }, c.signal);
    const reading2 = read(b);
    await tick();
    c.abort();
    assert.deepEqual(g.log.filter((l) => l[0] === "cancel"), [["cancel", (g.log[0][1] as { id: number }).id]]);
    g.emit({ id: (g.log[0][1] as { id: number }).id, kind: "error" });
    await assert.rejects(reading2, (e: Error) => e.name === "AbortError");
  });

  it("a socket is opened through main with the path and query only, and relays the events", async () => {
    const f = fakeBridge();
    const net = bridgeNet(f.bridge);
    const log: string[] = [];
    const s = net.socket(STT_PATH, sttQuery(DEFAULTS), noEvents(log));
    const open = f.log[0][1] as { id: number; path: string; query: Record<string, string> };
    assert.equal(f.log[0][0], "socket.open");
    assert.equal(open.path, STT_PATH);
    assert.deepEqual(open.query, sttQuery(DEFAULTS));
    assert.ok(!("key" in open) && !JSON.stringify(open).includes("token"));
    s.send("before");
    f.emit({ id: open.id, kind: "open" });
    s.send("after");
    f.emit({ id: open.id, kind: "message", text: "hi" });
    f.emit({ id: open.id + 9, kind: "message", text: "not mine" });
    f.emit({ id: open.id, kind: "close", code: 1000 });
    f.emit({ id: open.id, kind: "message", text: "after close" });
    assert.deepEqual(log, ["open", "message hi", "close 1000"]);
    assert.deepEqual(f.log.filter((l) => l[0] === "socket.send"), [["socket.send", open.id, "after"]]);
    assert.equal(f.listeners(), 0);
  });

  it("a socket that cannot be opened says error and close; own close() reaches main and then is quiet", async () => {
    const bad = fakeBridge({ failWith: "voice_unreachable" });
    const log: string[] = [];
    bridgeNet(bad.bridge).socket(STT_PATH, {}, noEvents(log));
    await tick();
    assert.deepEqual(log, ["error", "close 1006"]);
    const noKey = fakeBridge({ failWith: "voice_no_key" });
    const log2: string[] = [];
    bridgeNet(noKey.bridge).socket(STT_PATH, {}, noEvents(log2));
    await tick();
    assert.deepEqual(log2, ["error", "close 1008"]);

    const f = fakeBridge();
    const log3: string[] = [];
    const s = bridgeNet(f.bridge).socket(STT_PATH, {}, noEvents(log3));
    const id = (f.log[0][1] as { id: number }).id;
    f.emit({ id, kind: "open" });
    s.close();
    f.emit({ id, kind: "close", code: 1000 });
    assert.deepEqual(f.log.filter((l) => l[0] === "socket.close"), [["socket.close", id]]);
    assert.deepEqual(log3, ["open"]);
  });

  it("a preview is main's: the page passes the address and gets bytes, errors are the port's", async () => {
    const f = fakeBridge();
    const bytes = await bridgeNet(f.bridge).preview("https://storage.example.test/a.mp3", new AbortController().signal);
    assert.equal(dec.decode(bytes), "clip");
    assert.deepEqual(f.log[0], ["preview", "https://storage.example.test/a.mp3"]);
    await assert.rejects(bridgeNet(fakeBridge({ failWith: "voice_refused" }).bridge).preview("https://x.test/a.mp3", new AbortController().signal), VoiceNetError);
    const c = new AbortController();
    c.abort();
    await assert.rejects(bridgeNet(fakeBridge().bridge).preview("https://x.test/a.mp3", c.signal), (e: Error) => e.name === "AbortError");
  });
});

describe("webNet picks its way", () => {
  const memory = (): Keystore => createKeystore(memoryVault());

  it("with the bridge it uses the bridge and never fetch or WebSocket", async () => {
    const f = fakeBridge({ body: ["{}"] });
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, WebSocket: g.WebSocket };
    g.fetch = () => { throw new Error("fetch used"); };
    g.WebSocket = function () { throw new Error("WebSocket used"); };
    try {
      const net = webNet({ aiwbVoice: f.bridge, location: { origin: "file://" } }, memory());
      await (await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal)).text();
      net.socket(STT_PATH, {}, noEvents()).close();
      assert.deepEqual(f.log.map((l) => l[0]), ["request", "socket.open", "socket.close"]);
    } finally {
      Object.assign(g, saved);
    }
  });

  it("with no bridge on a local page it calls the stand-in under /voice with the memory key, and the token for the socket", async () => {
    const keystore = memory();
    await keystore.set(KEY);
    const g = globalThis as Record<string, unknown>;
    const saved = { fetch: g.fetch, WebSocket: g.WebSocket };
    const fetched = fakeFetch((c) => (c.url.includes(TOKEN_PATH) ? { json: { token: "sutkn_t" } } : { json: { voices: [] } }));
    const urls: string[] = [];
    g.fetch = fetched.f;
    g.WebSocket = function (this: unknown, url: string, ...rest: unknown[]) { urls.push(url); assert.equal(rest.length, 0, "no protocols or options"); return new FakeSocket(url); };
    try {
      const net = webNet({ location: { origin: "http://127.0.0.1:4173" } }, keystore);
      await (await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "4" } }, new AbortController().signal)).text();
      net.socket(STT_PATH, { model_id: "scribe_v2_realtime" }, noEvents());
      await tick();
      await tick();
      assert.deepEqual(fetched.calls.map((c) => c.url), ["http://127.0.0.1:4173/voice/v2/voices?page_size=4", "http://127.0.0.1:4173/voice/v1/single-use-token/realtime_scribe"]);
      assert.ok(fetched.calls.every((c) => c.init.headers["xi-api-key"] === KEY));
      assert.deepEqual(urls, ["ws://127.0.0.1:4173/voice/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&token=sutkn_t"]);
    } finally {
      Object.assign(g, saved);
    }
  });

  it("a page from a public origin or a file with no bridge has no way out: nothing is fetched", async () => {
    const g = globalThis as Record<string, unknown>;
    const saved = g.fetch;
    g.fetch = () => { throw new Error("fetch used"); };
    try {
      for (const origin of [undefined, "null", "https://app.example.com", "file://"]) {
        const keystore = memory();
        await keystore.set(KEY);
        const net = webNet({ location: { origin } }, keystore);
        await assert.rejects(net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal), VoiceNetError);
        await assert.rejects(net.preview("https://x.test/a.mp3", new AbortController().signal), VoiceNetError);
        const log: string[] = [];
        net.socket(STT_PATH, {}, noEvents(log));
        await tick();
        assert.deepEqual(log, ["error", "close 1006"]);
      }
    } finally {
      g.fetch = saved;
    }
  });

  it("page-direct accepts a clip at the stand-in's own address and an https one, from a voices answer", async () => {
    const keystore = memory();
    await keystore.set(KEY);
    const g = globalThis as Record<string, unknown>;
    const saved = g.fetch;
    const own = "http://127.0.0.1:4173/voice/_preview/vs_alice.wav";
    const other = "http://127.0.0.1:4173/elsewhere/vs_alice.wav";
    const fetched = fakeFetch((c) => (c.url.includes("/v2/voices") ? { json: { voices: [{ voice_id: "vs_alice", preview_url: own }, { voice_id: "x", preview_url: other }] } } : { chunks: ["wav"] }));
    g.fetch = fetched.f;
    try {
      const net = webNet({ location: { origin: "http://127.0.0.1:4173" } }, keystore);
      await (await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal)).text();
      assert.equal(dec.decode(await net.preview(own, new AbortController().signal)), "wav");
      assert.deepEqual(fetched.calls[fetched.calls.length - 1].init.headers, {});
      await assert.rejects(net.preview(other, new AbortController().signal), VoiceNetError);
    } finally {
      g.fetch = saved;
    }
  });
});

describe("the page-direct net against the stand-in voice service (web/dev/voicestandin.mjs)", () => {
  let server: http.Server;
  let origin = "";
  const standin = createVoiceStandin();
  before(async () => {
    server = http.createServer();
    standin.routes(server);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(() => { standin.control.reset(); server.closeAllConnections(); server.close(); });

  const memoryKey = async (key: string): Promise<Keystore> => { const k = createKeystore(memoryVault()); await k.set(key); return k; };
  const waitFor = async (what: string, ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(ok(), `waited for ${what}`);
  };

  it("lists voices, plays a preview, streams a sentence and takes a transcript socket, with the key in a header and the token on the socket alone", async () => {
    standin.control.reset();
    const net = webNet({ location: { origin } }, await memoryKey(KEY));
    const none = new AbortController().signal;

    const voices = await net.request({ method: "GET", path: VOICES_PATH, query: { page_size: "2", include_total_count: "true" } }, none);
    assert.equal(voices.status, 200);
    const list = JSON.parse(await voices.text()) as { voices: { voice_id: string; preview_url: string }[] };
    assert.equal(list.voices.length, 2);
    const clip = await net.preview(list.voices[0].preview_url, none);
    assert.ok(clip.length > 44, "a WAV");

    const speech = await net.request({ method: "POST", path: ttsPath(list.voices[0].voice_id), query: ttsQuery(), json: ttsBody("One sentence here.", DEFAULTS) }, none);
    assert.equal(speech.status, 200);
    let pcm = 0;
    for await (const c of speech.body) pcm += c.length;
    assert.ok(pcm > 0 && pcm % 1 === 0);

    const seen: string[] = [];
    let opened = false;
    const socket = net.socket(STT_PATH, sttQuery(DEFAULTS), {
      open: () => { opened = true; }, message: (t) => { seen.push(t); }, close: () => {}, error: () => {},
    });
    await waitFor("the socket to open", () => opened);
    await waitFor("session_started", () => seen.some((t) => t.includes("session_started")));
    socket.close();

    const log = standin.control.log() as { kind: string; keyHeader: boolean; token: boolean; query: Record<string, string> }[];
    const by = (kind: string) => log.filter((e) => e.kind === kind);
    assert.ok(by("voices").every((e) => e.keyHeader && !e.token));
    assert.ok(by("tts").every((e) => e.keyHeader && !e.token));
    assert.ok(by("preview").every((e) => !e.keyHeader), "the clip is fetched with no key");
    assert.ok(by("token").every((e) => e.keyHeader), "the token is asked with the key");
    assert.ok(by("stt").length === 1 && by("stt")[0].token && !by("stt")[0].keyHeader, "the socket takes the token alone");
    assert.ok(!JSON.stringify(log).includes(KEY), "the key is in no log entry, address or query");
  });

  it("a key the service rejects: 401 on a request, and auth_error on the socket", async () => {
    standin.control.reset();
    const net = webNet({ location: { origin } }, await memoryKey("sk_live_not_accepted"));
    const answer = await net.request({ method: "GET", path: VOICES_PATH }, new AbortController().signal);
    assert.equal(answer.status, 401);
    await answer.text();
    const seen: string[] = [];
    let closed = -1;
    net.socket(STT_PATH, sttQuery(DEFAULTS), { open: () => {}, message: (t) => { seen.push(t); }, close: (c) => { closed = c; }, error: () => {} });
    await waitFor("the socket to close", () => closed >= 0);
    assert.ok(seen.some((t) => t.includes("auth_error")), seen.join());
  });
});

describe("what is in the sources", () => {
  it("the protocol's constants are the ones the net uses", () => {
    assert.equal(TOKEN_PATH, "/v1/single-use-token/realtime_scribe");
    assert.equal(VOICES_PATH, "/v2/voices");
  });
});
