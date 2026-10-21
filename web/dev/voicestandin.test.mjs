// The stand-in voice service (dev/voicestandin.mjs, plans/voice-chats/architecture.md VC-31) checked for what the checks that stand on
// it need of it: the token, the voices and their paging, the TTS answer's chunks and their pace, the cancelled request, the
// WebSocket's handshake and frames of every length (from Node's own client, and by hand for what a client does not do), the scripts by
// chunk count, `commit`, each failure, and a log that never holds a key. It listens on 127.0.0.1 and calls nothing else; the mounts
// (the test host's face, the mock) are at the end. Run with: node --test web/dev/voicestandin.test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHostFace } from "./hostface.mjs";
import { startHost } from "./host.mjs";
import { startMock } from "./mock.mjs";
import { createVoiceStandin, wsFrame, wsReader } from "./voicestandin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KEY = "sk_test_CANARY_9f3a1c";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const NOOP_CLIENT = { subscribe: () => ({ close() {} }), call: async () => ({ status: 200, text: "{}" }), picture: async () => ({ ok: false, status: 404, text: "" }), app: async () => ({ status: 200, body: null }) };

async function until(fn, what, ms = 15000) {
  for (const end = Date.now() + ms; ; await sleep(10)) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); }
}

const closers = [];
after(async () => { for (const c of closers.reverse()) await c().catch(() => {}); });

/** A stand-in on a port of its own. */
async function serve(opts) {
  const standin = createVoiceStandin(opts);
  const server = http.createServer();
  standin.routes(server);
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const port = server.address().port, base = `http://127.0.0.1:${port}${standin.prefix}`;
  closers.push(() => new Promise((ok) => { standin.control.reset(); server.closeAllConnections?.(); server.close(ok); }));
  return { standin, c: standin.control, server, port, base, ws: `ws://127.0.0.1:${port}${standin.prefix}` };
}

const withKey = (key = KEY, more = {}) => ({ headers: { "xi-api-key": key, ...more } });

/** A WebSocket (Node's own client) whose messages are kept: next(type) answers the first of that type not taken yet. */
function socketTo(url, headers) {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  const got = [];
  let closed = null, failed = false;
  ws.addEventListener("message", (e) => got.push(JSON.parse(e.data)));
  ws.addEventListener("close", (e) => { closed = { code: e.code }; });
  ws.addEventListener("error", () => { failed = true; });
  const opened = new Promise((ok) => { ws.addEventListener("open", () => ok(true)); ws.addEventListener("close", () => ok(false)); });
  return {
    ws, got, opened, failed: () => failed, closed: () => closed,
    types: () => got.map((m) => m.message_type),
    async next(type) { const m = await until(() => got.find((x) => x.message_type === type && !x.taken), `a ${type} message (got ${JSON.stringify(got.map((x) => x.message_type))})`); m.taken = true; return m; },
    chunk(ms = 100, more = {}) { ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.alloc(Math.round(ms * 32)).toString("base64"), commit: false, sample_rate: 16000, ...more })); },
    commit() { ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 })); },
    close: () => { try { ws.close(); } catch {} },
  };
}

/** The log entry of the last session of a kind. */
const lastOf = (c, kind) => c.log().filter((e) => e.kind === kind).at(-1);

describe("the token", () => {
  test("a key gets a token; no key and a wrong key get the 401 of the service in its form", async () => {
    const { base } = await serve();
    let r = await fetch(`${base}/v1/single-use-token/realtime_scribe`, { method: "POST", ...withKey() });
    assert.equal(r.status, 200);
    assert.match((await r.json()).token, /^sutkn_[0-9a-f]{32}$/);
    r = await fetch(`${base}/v1/single-use-token/realtime_scribe`, { method: "POST" });
    assert.equal(r.status, 401);
    assert.equal((await r.json()).detail.code, "missing_api_key");
    r = await fetch(`${base}/v1/single-use-token/realtime_scribe`, { method: "POST", ...withKey("sk_live_nope") });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.deepEqual([body.detail.code, body.detail.status], ["invalid_api_key", "invalid_api_key"]);
    assert.ok(body.detail.message && body.detail.request_id);
  });

  test("a token opens the socket once; a used one and an expired one get auth_error", async () => {
    const { base, ws, c } = await serve({ tokenMs: 300 });
    const mint = async () => (await (await fetch(`${base}/v1/single-use-token/realtime_scribe`, { method: "POST", ...withKey() })).json()).token;
    const token = await mint();
    const a = socketTo(`${ws}/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&audio_format=pcm_16000&token=${token}`);
    assert.equal(await a.opened, true);
    await a.next("session_started");
    a.close();
    const b = socketTo(`${ws}/v1/speech-to-text/realtime?token=${token}`);
    await b.opened;
    await b.next("auth_error");
    const old = await mint();
    await sleep(350);
    const d = socketTo(`${ws}/v1/speech-to-text/realtime?token=${old}`);
    await d.opened;
    await d.next("auth_error");
    const log = c.log().filter((e) => e.kind === "stt");
    assert.deepEqual(log.map((e) => e.token), [true, true, true]);
    assert.ok(log.every((e) => !("token" in e.query)), "the token is not kept in the query");
    assert.ok(!JSON.stringify(c.log()).includes(token));
  });
});

describe("the voices", () => {
  test("six voices, paged by page_size and next_page_token, with the total", async () => {
    const { base } = await serve();
    const get = async (q) => (await fetch(`${base}/v2/voices?${q}`, withKey())).json();
    const one = await get("page_size=1&include_total_count=true");
    assert.deepEqual([one.voices.length, one.total_count, one.has_more], [1, 6, true]);
    const a = await get("page_size=4&sort=name&include_total_count=true");
    assert.equal(a.voices.length, 4);
    assert.equal(a.has_more, true);
    const b = await get(`page_size=4&next_page_token=${a.next_page_token}`);
    assert.deepEqual([b.voices.length, b.has_more, b.next_page_token], [2, false, null]);
    assert.equal(new Set([...a.voices, ...b.voices].map((v) => v.voice_id)).size, 6);
    for (const v of a.voices) {
      assert.match(v.voice_id, /^vs[A-Z][a-z]+$/);
      assert.ok(v.name && v.description && v.labels && v.category);
      assert.equal(v.preview_url, `${new URL(base).origin}/voice/_preview/${v.voice_id}.wav`);
    }
    assert.equal((await get("page_size=100")).voices.length, 6);
    assert.deepEqual((await get("search=bo")).voices.map((v) => v.name), ["Bob"]);
    assert.equal((await fetch(`${base}/v2/voices?page_size=101`, withKey())).status, 400);
    assert.equal((await fetch(`${base}/v2/voices?page_size=0`, withKey())).status, 400);
    assert.equal((await fetch(`${base}/v2/voices`)).status, 401);
  });

  test("a preview is a 0.5 s WAV tone that takes no key, and is logged without one", async () => {
    const { base, c } = await serve();
    const { voices } = await (await fetch(`${base}/v2/voices?page_size=1`, withKey())).json();
    const r = await fetch(voices[0].preview_url);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/wav");
    const wav = Buffer.from(await r.arrayBuffer());
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    assert.equal(wav.toString("latin1", 8, 12), "WAVE");
    assert.equal(wav.readUInt32LE(24), 24000);
    assert.equal(wav.length, 44 + 24000);
    assert.equal(wav.readUInt32LE(40), 24000);
    assert.ok(wav.subarray(44).some((b) => b !== 0));
    assert.equal(lastOf(c, "preview").keyHeader, false);
    assert.equal((await fetch(`${base}/_preview/vs_nobody.wav`)).status, 404);
  });
});

describe("the text to speech", () => {
  const speak = (base, body, { voice = "vsAlice", query = "output_format=pcm_24000", key = KEY, signal } = {}) =>
    fetch(`${base}/v1/text-to-speech/${voice}/stream?${query}`, { method: "POST", headers: { "xi-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const SENTENCE = { text: "Hello there, this is a sentence.", model_id: "eleven_flash_v2_5" };

  test("raw PCM in chunks, paced; the bytes follow the text; the log has the request", async () => {
    const { base, c } = await serve();
    c.pace({ chunkMs: 40, chunks: 5 });
    const r = await speak(base, SENTENCE);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "audio/pcm");
    const pcm = Buffer.from(await r.arrayBuffer());
    assert.equal(pcm.length, Math.round(SENTENCE.text.length * 0.05 * 24000) * 2);
    assert.equal(pcm.length % 2, 0);
    assert.ok(pcm.some((b) => b !== 0));
    const e = lastOf(c, "tts");
    assert.deepEqual([e.text, e.voice, e.model, e.status, e.chunks, e.bytes, e.cancelled, e.sampleRates, e.keyHeader, e.problems], [SENTENCE.text, "vsAlice", "eleven_flash_v2_5", 200, 5, pcm.length, false, [24000], true, []]);
    assert.ok(e.finishedAt - e.startedAt >= 4 * 40 - 15, `the chunks were ${e.finishedAt - e.startedAt} ms apart in all`);
    assert.ok(e.chunkMsMin >= 40 - 8 && e.chunkMsMax >= e.chunkMsMin, `${e.chunkMsMin}..${e.chunkMsMax}`);
    const longer = await (await speak(base, { ...SENTENCE, text: SENTENCE.text.repeat(2) })).arrayBuffer();
    assert.equal(longer.byteLength, Math.round(SENTENCE.text.length * 2 * 0.05 * 24000) * 2);
  });

  test("the chunks arrive one at a time and the first before the last is written; a cut may fall in the middle of a sample", async () => {
    const { base, c } = await serve();
    c.pace({ chunkMs: 120, chunks: 4 });
    const r = await speak(base, SENTENCE);
    const arrivals = [];
    for (const reader = r.body.getReader(); ;) { const { value, done } = await reader.read(); if (done) break; arrivals.push({ n: value.length, at: Date.now() }); }
    assert.ok(arrivals.length >= 2, "the answer came in more than one piece");
    assert.ok(arrivals.at(-1).at - arrivals[0].at >= 150, "the pieces are spread in time");
    assert.ok(arrivals.slice(0, -1).some((a) => a.n % 2 === 1) || arrivals.length < 4, "a cut on an odd byte");
    const e = lastOf(c, "tts");
    assert.ok(e.startedAt <= arrivals[0].at && e.finishedAt >= arrivals[0].at);
  });

  test("a request closed before its end is cancelled and stops writing", async () => {
    const { base, c } = await serve();
    c.pace({ chunkMs: 200, chunks: 6 });
    const ctl = new AbortController();
    const r = await speak(base, SENTENCE, { signal: ctl.signal });
    const reader = r.body.getReader();
    await reader.read();
    ctl.abort();
    const e = await until(() => { const x = lastOf(c, "tts"); return x.cancelled && x; }, "the cancelled request in the log");
    assert.equal(e.finishedAt, null);
    assert.ok(e.chunks < 6);
    const was = e.chunks;
    await sleep(500);
    assert.equal(lastOf(c, "tts").chunks, was, "nothing is written after the cancel");
  });

  test("it checks what voice must send: the format, the model, the voice, the text, the speed; and notes what it must not", async () => {
    const { base, c } = await serve();
    let r = await speak(base, SENTENCE, { query: "output_format=mp3_44100" });
    assert.equal(r.status, 400);
    assert.match(lastOf(c, "tts").problems[0], /pcm_24000/);
    assert.equal((await speak(base, { ...SENTENCE, model_id: "eleven_turbo_v2" })).status, 400);
    c.pace({ chunkMs: 0, chunks: 1 });
    r = await speak(base, { ...SENTENCE, model_id: "eleven_v4_turbo", language_code: "hr" });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.deepEqual([lastOf(c, "tts").model, lastOf(c, "tts").problems], ["eleven_v4_turbo", []]);
    assert.equal((await speak(base, { ...SENTENCE, text: " " })).status, 400);
    assert.equal((await speak(base, SENTENCE, { voice: "vs_nobody" })).status, 404);
    assert.equal((await speak(base, { ...SENTENCE, voice_settings: { speed: 2 } })).status, 400);
    assert.equal((await speak(base, SENTENCE, { key: "sk_live_x" })).status, 401);
    c.pace({ chunkMs: 0, chunks: 2 });
    r = await speak(base, { ...SENTENCE, voice_settings: { speed: 1.0 } });
    assert.equal(r.status, 200);
    await r.arrayBuffer();
    assert.match(lastOf(c, "tts").problems[0], /speed of 1\.0/);
    const fast = Buffer.from(await (await speak(base, { ...SENTENCE, voice_settings: { speed: 1.2 }, language_code: "en" })).arrayBuffer());
    const slow = Buffer.from(await (await speak(base, { ...SENTENCE, voice_settings: { speed: 0.7 } })).arrayBuffer());
    assert.ok(fast.length < slow.length);
    assert.deepEqual(lastOf(c, "tts").problems, []);
    assert.equal(lastOf(c, "tts").speed, 0.7);
  });
});

describe("the realtime socket", () => {
  const url = (s, q = "model_id=scribe_v2_realtime&audio_format=pcm_16000&commit_strategy=vad&vad_silence_threshold_secs=1.2") => `${s.ws}/v1/speech-to-text/realtime?${q}`;

  test("the handshake with the key header; session_started; chunks counted with their length and rate; closing is logged", async () => {
    const s = await serve();
    const sock = socketTo(url(s), { "xi-api-key": KEY });
    assert.equal(await sock.opened, true);
    const started = await sock.next("session_started");
    assert.match(started.session_id, /^sess_/);
    assert.equal(started.config.sample_rate, 16000);
    for (let i = 0; i < 3; i++) sock.chunk(100);
    sock.chunk(250);
    await until(() => lastOf(s.c, "stt").chunks === 4, "four chunks");
    sock.ws.close(1000);
    const e = await until(() => lastOf(s.c, "stt").finishedAt && lastOf(s.c, "stt"), "the session's end");
    assert.deepEqual([e.status, e.keyHeader, e.token, e.chunks, e.bytes, e.sampleRates, e.problems, e.closeCode], [101, true, false, 4, 3 * 3200 + 8000, [16000], [], 1000]);
    assert.ok(e.chunkMsMin === 100 && e.chunkMsMax === 250, `${e.chunkMsMin}..${e.chunkMsMax}`);
    assert.deepEqual(e.query, { model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "vad", vad_silence_threshold_secs: "1.2" });
  });

  test("a script answers by the count of chunks, in order, partials then a committed text; commit commits the last partial", async () => {
    const s = await serve();
    s.c.script([{ after: 0, partial: "ready" }, { after: 2, partial: "hel" }, { after: 3, partial: "hello wor" }, { after: 3, committed: "hello world" }, { after: 5, partial: "and" }]);
    const sock = socketTo(url(s), { "xi-api-key": KEY });
    await sock.opened;
    await sock.next("session_started");
    await sock.next("partial_transcript");
    sock.chunk(); sock.chunk();
    await sock.next("partial_transcript");
    await sleep(60);
    assert.deepEqual(sock.types(), ["session_started", "partial_transcript", "partial_transcript"], "nothing before the third chunk");
    sock.chunk();
    await sock.next("partial_transcript");
    await sock.next("committed_transcript");
    assert.deepEqual(sock.got.slice(1).map((m) => m.text), ["ready", "hel", "hello wor", "hello world"]);
    sock.chunk(); sock.chunk();
    await until(() => sock.got.at(-1).text === "and", "the partial of the fifth chunk");
    sock.commit();
    const c2 = await sock.next("committed_transcript");
    assert.equal(c2.text, "and");
    sock.commit();
    await until(() => lastOf(s.c, "stt").commits === 2, "the second commit");
    assert.equal(sock.got.filter((m) => m.message_type === "committed_transcript").length, 2, "a commit with no partial commits nothing");
    assert.equal(lastOf(s.c, "stt").chunks, 5, "a commit frame is no chunk of audio");
    // (the script was for one session: the next has none)
    const again = socketTo(url(s), { "xi-api-key": KEY });
    await again.next("session_started");
    again.chunk();
    await sleep(60);
    assert.deepEqual(again.types(), ["session_started"]);
  });

  test("frames of 125, 126 and 65536 bytes (7, 16 and 64 bit lengths) are read", async () => {
    const s = await serve();
    const sock = socketTo(url(s), { "xi-api-key": KEY });
    await sock.opened;
    await sock.next("session_started");
    const framed = (n) => {
      const base = JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: false, sample_rate: 16000, previous_text: "" });
      return base.replace('"previous_text":""', `"previous_text":"${"x".repeat(n - Buffer.byteLength(base))}"`);
    };
    for (const n of [125, 126, 65535, 65536, 200000]) {
      const text = framed(n);
      assert.equal(Buffer.byteLength(text), n);
      sock.ws.send(text);
    }
    sock.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.alloc(3200).toString("base64"), commit: false, sample_rate: 16000 }));
    // (empty audio is no chunk: only the last of the six counts, and none of the others is a problem)
    await until(() => lastOf(s.c, "stt").chunks === 1, "the last frame, after the long ones");
    assert.deepEqual(lastOf(s.c, "stt").problems, []);
    assert.equal(sock.types().length, 1);
  });

  test("a frame against the protocol is a problem in the log and an input_error to the client, and the session goes on", async () => {
    const s = await serve();
    const sock = socketTo(url(s), { "xi-api-key": KEY });
    await sock.opened;
    await sock.next("session_started");
    sock.ws.send("not json");
    await sock.next("input_error");
    sock.chunk(100, { sample_rate: 24000 });
    await sock.next("input_error");
    sock.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "***", commit: false, sample_rate: 16000 }));
    await sock.next("input_error");
    sock.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "AAAAAAAA", sample_rate: 16000 }));
    await sock.next("input_error");
    sock.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "AAAA", commit: false, sample_rate: 16000 }));
    await sock.next("input_error"); // (an odd number of bytes: 16-bit samples)
    sock.chunk();
    await until(() => lastOf(s.c, "stt").chunks === 1, "a good chunk after the bad ones");
    const e = lastOf(s.c, "stt");
    assert.equal(e.problems.length, 5);
    assert.match(e.problems.join("\n"), /not JSON[^]*sample_rate is 24000[^]*not base64[^]*commit is missing[^]*odd number/);
  });

  test("a query voice does not send is a problem; a wrong model or format too", async () => {
    const s = await serve();
    const sock = socketTo(url(s, "model_id=scribe_v1&audio_format=pcm_8000&keyterms=a"), { "xi-api-key": KEY });
    await sock.next("session_started");
    assert.equal(lastOf(s.c, "stt").problems.length, 3);
  });

  test("by hand: an unmasked frame closes with 1002; ping gets pong; a message in fragments is joined; the close is answered", async () => {
    const s = await serve();
    const raw = await rawSocket(s.port, `${s.standin.prefix}/v1/speech-to-text/realtime?model_id=scribe_v2_realtime`, { "xi-api-key": KEY });
    assert.equal((await raw.frame()).text.message_type, "session_started");
    const ping = Buffer.from("are you there");
    raw.send(9, ping);
    const pong = await raw.frame();
    assert.deepEqual([pong.opcode, pong.payload.toString()], [10, "are you there"]);
    const chunk = Buffer.from(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: Buffer.alloc(3200).toString("base64"), commit: false, sample_rate: 16000 }));
    raw.send(1, chunk.subarray(0, 100), { fin: false });
    raw.send(9, Buffer.from("between"));
    assert.equal((await raw.frame()).opcode, 10, "a ping between the fragments is answered");
    raw.send(0, chunk.subarray(100, 5000), { fin: false });
    raw.send(0, chunk.subarray(5000), { fin: true });
    await until(() => lastOf(s.c, "stt").chunks === 1, "the joined message");
    raw.send(8, Buffer.from([0x03, 0xe8]));
    const close = await raw.frame();
    assert.deepEqual([close.opcode, close.payload.readUInt16BE(0)], [8, 1000]);
    assert.equal(lastOf(s.c, "stt").closeCode, 1000);
    raw.end();

    const bad = await rawSocket(s.port, `${s.standin.prefix}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await bad.frame();
    bad.send(1, Buffer.from("{}"), { mask: false });
    const closed = await bad.frame();
    assert.deepEqual([closed.opcode, closed.payload.readUInt16BE(0)], [8, 1002]);
    assert.match(lastOf(s.c, "stt").problems[0], /not masked/);
    bad.end();
  });

  test("a wsReader/wsFrame round trip of each length", () => {
    for (const n of [0, 1, 125, 126, 127, 65535, 65536, 70000]) {
      const payload = crypto.randomBytes(n), seen = [];
      const feed = wsReader((f) => seen.push(f), (code, why) => assert.fail(why));
      const server = wsFrame(1, payload);
      assert.equal(server[1] & 0x80, 0, "a server frame is not masked");
      assert.equal(server.length, n + (n < 126 ? 2 : n < 65536 ? 4 : 10));
      const masked = maskedFrame(1, payload);
      feed(masked.subarray(0, 3)); // (cut anywhere)
      feed(masked.subarray(3, 7));
      feed(masked.subarray(7));
      assert.equal(seen.length, 1);
      assert.ok(seen[0].payload.equals(payload));
    }
  });
});

describe("the failures", () => {
  const voices = (base) => fetch(`${base}/v2/voices?page_size=1`, withKey());

  test("a wrong key: 401 on every route, auth_error and the close on the socket", async () => {
    const s = await serve();
    assert.equal((await fetch(`${s.base}/v2/voices?page_size=1`, withKey("sk_live_x"))).status, 401);
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": "sk_live_x" });
    assert.equal(await sock.opened, true);
    await sock.next("auth_error");
    await until(() => sock.closed(), "the close");
    assert.equal(sock.closed().code, 1008);
    const none = socketTo(`${s.ws}/v1/speech-to-text/realtime`);
    await none.next("auth_error");
  });

  const cases = [
    ["key_rejected", 401, "invalid_api_key", "auth_error"],
    ["no_credits", 402, "insufficient_credits", "quota_exceeded"],
    ["rate_limited", 429, "rate_limit_exceeded", "rate_limited"],
  ];
  for (const [name, status, code, socket] of cases) {
    test(`${name}: HTTP ${status} ${code}, and the socket's ${socket}; fail(null) ends it`, async () => {
      const s = await serve();
      s.c.fail(name);
      let r = await voices(s.base);
      assert.equal(r.status, status);
      assert.equal((await r.json()).detail.code, code);
      r = await fetch(`${s.base}/v1/single-use-token/realtime_scribe`, { method: "POST", ...withKey() });
      assert.equal(r.status, status);
      r = await fetch(`${s.base}/v1/text-to-speech/vsAlice/stream?output_format=pcm_24000`, { method: "POST", ...withKey(KEY, { "content-type": "application/json" }), body: "{}" });
      assert.equal(r.status, status);
      const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
      await sock.opened;
      await sock.next(socket);
      assert.deepEqual(sock.types(), [socket], "the error is sent in place of session_started");
      await until(() => sock.closed(), "the close");
      assert.equal(lastOf(s.c, "stt").sent[0], socket);
      s.c.fail(null);
      assert.equal((await voices(s.base)).status, 200);
    });
  }

  test("the old form of no credits: 401 with a status alone", async () => {
    const s = await serve();
    s.c.fail("no_credits_legacy");
    const r = await voices(s.base);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { detail: { status: "quota_exceeded", message: "The quota is used up." } });
  });

  test("{ http } alone refuses the socket's upgrade with that status; { socket } alone leaves HTTP as it was", async () => {
    const s = await serve();
    s.c.fail({ http: { status: 429, code: "rate_limit_exceeded" } });
    const refused = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    assert.equal(await refused.opened, false);
    assert.equal(lastOf(s.c, "stt").status, 429);
    s.c.fail({ socket: "transcriber_error" });
    assert.equal((await voices(s.base)).status, 200);
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("transcriber_error");
  });

  test("a socket failure after n chunks, and once: the error comes after session_started and the next session is clean", async () => {
    const s = await serve();
    s.c.fail({ socket: "session_time_limit_exceeded", after: 2, once: true });
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    sock.chunk();
    await sleep(60);
    assert.deepEqual(sock.types(), ["session_started"]);
    sock.chunk();
    await sock.next("session_time_limit_exceeded");
    await until(() => sock.closed(), "the close");
    const again = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await again.next("session_started");
    again.chunk(); again.chunk(); again.chunk();
    await sleep(60);
    assert.deepEqual(again.types(), ["session_started"]);
  });

  test("offline: every request destroyed, every socket refused; and back", async () => {
    const s = await serve();
    s.c.fail("offline");
    await assert.rejects(voices(s.base));
    await assert.rejects(fetch(`${s.base}/_preview/vsAlice.wav`));
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    assert.equal(await sock.opened, false);
    assert.equal(sock.got.length, 0);
    s.c.fail(null);
    assert.equal((await voices(s.base)).status, 200);
  });

  test("a failure that does not exist, and a script that is not one, are refused", async () => {
    const s = await serve();
    assert.throws(() => s.c.fail("on_fire"), /no failure/);
    assert.throws(() => s.c.fail({}), /http/);
    assert.throws(() => s.c.script([{ partial: "x" }]), /after/);
    assert.throws(() => s.c.pace({ chunks: 0 }), /chunks/);
  });
});

describe("the log", () => {
  test("a key is never in it: only keyHeader; not in the query either; reset empties it", async () => {
    const s = await serve();
    const canary = "sk_test_CANARY_log_check_77";
    await fetch(`${s.base}/v2/voices?page_size=1&xi-api-key=${canary}&api_key=${canary}`, withKey(canary));
    const t = await (await fetch(`${s.base}/v1/single-use-token/realtime_scribe`, { method: "POST", ...withKey(canary) })).json();
    await fetch(`${s.base}/v1/text-to-speech/vsAlice/stream?output_format=pcm_24000`, { method: "POST", ...withKey(canary, { "content-type": "application/json" }), body: JSON.stringify({ text: "Hi.", model_id: "eleven_flash_v2_5" }) }).then((r) => r.arrayBuffer());
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime?token=${t.token}&xi-api-key=${canary}`);
    await sock.next("session_started");
    sock.close();
    await fetch(`${s.base}/v2/voices`, withKey("sk_live_wrong_one"));
    const text = JSON.stringify(s.c.log());
    assert.ok(!text.includes(canary) && !text.includes("sk_live_wrong_one") && !text.includes(t.token), text);
    assert.deepEqual(s.c.log().map((e) => [e.kind, e.keyHeader, e.token]), [["voices", true, false], ["token", true, false], ["tts", true, false], ["stt", false, true], ["voices", true, false]]);
    assert.ok(s.c.log().every((e) => typeof e.at === "number" && e.path.startsWith("/voice/")));
    s.c.reset();
    assert.deepEqual(s.c.log(), []);
  });

  test("reset clears the script, the failure and the pace, and cuts what is open", async () => {
    const s = await serve();
    s.c.script([{ after: 0, partial: "x" }]);
    s.c.fail("no_credits");
    s.c.pace({ chunkMs: 1, chunks: 2 });
    s.c.reset();
    const sock = socketTo(`${s.ws}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    await sleep(50);
    assert.deepEqual(sock.types(), ["session_started"]);
    s.c.reset();
    await until(() => sock.closed(), "the socket cut by reset");
  });
});

describe("standalone", () => {
  test("the command prints its address; the control is over HTTP at <prefix>/_control/", async () => {
    const p = spawn(process.execPath, [path.join(HERE, "voicestandin.mjs"), "--port", "0", "--prefix", "/vx"], { stdio: ["ignore", "pipe", "inherit"] });
    closers.push(async () => { p.kill(); });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const line = await until(() => /^Voice: (http:\/\/127\.0\.0.1:\d+\/vx)$/m.exec(out), "the address line");
    const base = line[1];
    const post = async (name, body) => (await fetch(`${base}/_control/${name}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) })).json();
    assert.equal((await fetch(`${base}/v2/voices`, withKey())).status, 200);
    assert.equal((await fetch(`${new URL(base).origin}/voice/v2/voices`)).status, 404, "only its own prefix");
    assert.deepEqual(await post("fail", "rate_limited"), { ok: true });
    assert.equal((await fetch(`${base}/v2/voices`, withKey())).status, 429);
    await post("fail", null);
    await post("pace", { chunkMs: 5, chunks: 3 });
    await post("script", [{ after: 1, committed: "hi" }]);
    const sock = socketTo(`${base.replace("http", "ws")}/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    sock.chunk();
    assert.equal((await sock.next("committed_transcript")).text, "hi");
    const log = await (await fetch(`${base}/_control/log`)).json();
    assert.deepEqual(log.map((e) => e.kind), ["voices", "voices", "stt"]);
    assert.equal((await fetch(`${base}/_control/pace`, { method: "POST", body: JSON.stringify({ chunks: 0 }) })).status, 400);
    assert.equal((await fetch(`${base}/_control/nothing`, { method: "POST" })).status, 404);
    assert.deepEqual(await post("reset"), { ok: true });
    assert.deepEqual(await (await fetch(`${base}/_control/log`)).json(), []);
  });
});

describe("the mounts", () => {
  test("the host's face answers the stand-in under its prefix, for its own page alone, and the page's files elsewhere", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-voicedist-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>page</html>");
    closers.push(async () => fs.rmSync(dist, { recursive: true, force: true }));
    const voice = createVoiceStandin();
    const face = createHostFace({ client: NOOP_CLIENT, distDir: dist, voice });
    const server = http.createServer(face.handle);
    server.on("upgrade", face.upgrade);
    await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
    closers.push(() => new Promise((ok) => { voice.control.reset(); face.close(); server.closeAllConnections?.(); server.close(ok); }));
    const port = server.address().port, base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/voice/v2/voices?page_size=2`, withKey())).status, 200);
    assert.match(await (await fetch(`${base}/`)).text(), /page/);
    assert.equal((await fetch(`${base}/host/nothing`)).status, 404);
    // another site's page, in the same browser, is not served (the face's own rule)
    const other = await rawRequest(port, "GET", "/voice/v2/voices?page_size=1", { host: "evil.example", "xi-api-key": KEY });
    assert.equal(other.status, 403);
    const cross = await rawRequest(port, "GET", "/voice/v2/voices?page_size=1", { host: `127.0.0.1:${port}`, origin: "http://evil.example", "xi-api-key": KEY });
    assert.equal(cross.status, 403);
    // the socket
    const sock = socketTo(`ws://127.0.0.1:${port}/voice/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    sock.close();
    const foreign = socketTo(`ws://127.0.0.1:${port}/voice/v1/speech-to-text/realtime`, { "xi-api-key": KEY, origin: "http://evil.example" });
    assert.equal(await foreign.opened, false);
    const away = socketTo(`ws://127.0.0.1:${port}/elsewhere`, { "xi-api-key": KEY });
    assert.equal(await away.opened, false);
    // a face with no stand-in has no /voice
    const plain = createHostFace({ client: NOOP_CLIENT, distDir: dist });
    assert.equal(plain.upgrade, undefined);
  });

  test("startHost({ voice: true }) mounts one and returns it as host.voice; without it there is none", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-voicehost-"));
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const host = await startHost({ stateDir: path.join(dir, "state"), dist: dir, voice: true, log: () => {} });
    closers.push(() => host.close());
    assert.equal((await fetch(`${host.url}voice/v2/voices?page_size=1`, withKey())).status, 200);
    assert.equal(host.voice.control.log().length, 1);
    const sock = socketTo(`ws://127.0.0.1:${host.port}/voice/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    sock.close();
    const bare = await startHost({ stateDir: path.join(dir, "state2"), dist: dir, log: () => {} });
    closers.push(() => bare.close());
    assert.equal(bare.voice, null);
    assert.equal((await fetch(`${bare.url}voice/v2/voices`, withKey())).status, 404);
  });

  test("the mock mounts it at /voice with its control as `voice` in /mock/eval; flags.reply streams the next reply once", async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-mockvoice-"));
    fs.writeFileSync(path.join(dist, "index.html"), "<html>mock</html>");
    closers.push(async () => fs.rmSync(dist, { recursive: true, force: true }));
    const server = await startMock({ port: 0, dist });
    closers.push(() => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); }));
    const base = `http://127.0.0.1:${server.address().port}`;
    const mock = async (code) => { const j = await (await fetch(`${base}/mock/eval`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })).json(); if (!j.ok) throw new Error(j.error); return j.r; };
    assert.equal((await fetch(`${base}/voice/v2/voices?page_size=1`, withKey())).status, 200);
    assert.deepEqual((await mock("return voice.log().map((e) => e.kind)")), ["voices"]);
    await mock(`voice.fail("no_credits")`);
    assert.equal((await fetch(`${base}/voice/v2/voices?page_size=1`, withKey())).status, 402);
    await mock(`voice.reset()`);
    const sock = socketTo(`ws://127.0.0.1:${server.address().port}/voice/v1/speech-to-text/realtime`, { "xi-api-key": KEY });
    await sock.next("session_started");
    sock.close();

    const TEXT = "First sentence here. Second one follows it. And a third to end with.";
    await mock(`flags.reply = { text: ${JSON.stringify(TEXT)}, parts: 4, pace: 60 }`);
    const send = async (text) => (await fetch(`${base}/host/call?server=local&method=POST&path=${encodeURIComponent("/api/chats/c_plain/messages")}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })).json();
    const itemsOf = async () => JSON.parse(await (await fetch(`${base}/host/call?server=local&method=GET&path=${encodeURIComponent("/api/chats/c_plain/items?branch=main")}`, { method: "POST" })).text());
    const before = (await itemsOf()).items?.length ?? (await itemsOf()).length;
    assert.equal((await send("read me a story")).ok, true);
    const seen = new Set();
    const items = await until(async () => {
      const r = await itemsOf(), list = r.items ?? r, say = list.find((x, i) => i >= before && x.kind === "text");
      if (say) seen.add(say.text);
      return say?.done && list;
    }, "the whole reply");
    const list = items, say = list.find((x, i) => i >= before && x.kind === "text");
    assert.equal(say.text, TEXT);
    assert.equal(list.slice(before).some((x) => x.kind === "tool"), false, "no tool call before a reply of flags.reply");
    assert.equal(list.at(-1).kind, "end");
    assert.equal(await mock("return 'reply' in flags"), false, "the knob is used up");
    for (const t of seen) assert.ok(TEXT.startsWith(t), "every update is the start of the text");
    // the next reply is the mock's own canned one
    const n = list.length;
    await send("again");
    const canned = await until(async () => { const r = await itemsOf(); const l = r.items ?? r; return l.length > n && l.slice(n).some((x) => x.kind === "text" && x.text === "A canned reply of the mock.") && l; }, "the canned reply");
    assert.ok(canned);
  });
});

// ---- by hand

function maskedFrame(opcode, payload, { fin = true, mask = true } = {}) {
  const n = payload.length, key = crypto.randomBytes(4);
  const head = n < 126 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | n]) : n < 65536 ? Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | 126, n >> 8, n & 255])
    : (() => { const h = Buffer.alloc(10); h[0] = (fin ? 0x80 : 0) | opcode; h[1] = (mask ? 0x80 : 0) | 127; h.writeBigUInt64BE(BigInt(n), 2); return h; })();
  if (!mask) return Buffer.concat([head, payload]);
  const body = Buffer.from(payload);
  for (let i = 0; i < n; i++) body[i] ^= key[i & 3];
  return Buffer.concat([head, key, body]);
}

/** A WebSocket by hand: the handshake over a TCP socket; send(opcode, payload, { fin, mask }) writes a client frame; frame() reads a server one. */
async function rawSocket(port, pathAndQuery, headers = {}) {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise((ok, no) => { sock.once("connect", ok); sock.once("error", no); });
  const key = crypto.randomBytes(16).toString("base64");
  sock.write([`GET ${pathAndQuery} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));
  let buf = Buffer.alloc(0), shaken = false;
  const frames = [], waiting = [];
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (!shaken) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString();
      assert.match(head, /^HTTP\/1.1 101/);
      assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64").replace(/[+/=]/g, "\\$&")}`, "i"));
      buf = buf.subarray(end + 4); shaken = true;
    }
    for (;;) {
      if (buf.length < 2) break;
      let len = buf[1] & 127, at = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); at = 4; } else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (buf.length < at + len) break;
      const f = { opcode: buf[0] & 15, payload: buf.subarray(at, at + len) };
      f.text = f.opcode === 1 ? JSON.parse(f.payload.toString()) : undefined;
      buf = buf.subarray(at + len);
      frames.push(f);
    }
    while (waiting.length && frames.length) waiting.shift()(frames.shift());
  });
  return {
    send: (opcode, payload, o) => sock.write(maskedFrame(opcode, payload, o)),
    frame: () => new Promise((ok) => (frames.length ? ok(frames.shift()) : waiting.push(ok))),
    end: () => sock.destroy(),
  };
}

/** A request with the Host and Origin of the caller's choosing (fetch takes neither). */
function rawRequest(port, method, p, headers) {
  return new Promise((ok, no) => {
    const r = http.request({ host: "127.0.0.1", port, path: p, method, headers, setHost: false }, (res) => { res.resume(); res.on("end", () => ok({ status: res.statusCode })); });
    r.on("error", no);
    r.end();
  });
}
