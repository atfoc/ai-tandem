// The engine of voice, part B (architecture VC-18 to VC-23, VC-9, §8.1), over fake ports: dictation, speech mode and the pill, the turn
// and its timer, sending through the screen's function, the reply follower, the mic marks, Mute and End, barge-in and the problems of the
// socket. The clock is the fake ports' (`f.advance`), so no test waits out a pause. No test reaches the network, the microphone or a key.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { setKv } from "@aiwb/core/state/ports.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";
import type { ChatView, Item, Status } from "@aiwb/core/types.ts";
import { MARKS_KEY } from "../src/voice/logic/marks.ts";
import { COMMIT_WAIT_MS, QUIET_MS } from "../src/voice/logic/turn.ts";
import { setVoicePorts } from "../src/voice/ports.ts";
import type { DictationSink, SessionState } from "../src/voice/index.ts";
import { setVoiceSettings, useSpokenMark, useVoiceSession, voice } from "../src/voice/index.ts";
import { speaker } from "../src/voice/engine/speaker.ts";
import { problemStore, resetEngine, sessionStore, flags, waits } from "../src/voice/engine/state.ts";
import { bargesIn, ECHO_TAIL_MS, sessionDeps } from "../src/voice/engine/session.ts";
import { marksStore, noteSpoken, spokenMark, turnWords } from "../src/voice/engine/marks.ts";
import { createFakePorts, ERR, serveVoice, settle, waitFor } from "./fixtures/voice/fakeports.ts";
import type { FakePorts, FakeSocket } from "./fixtures/voice/fakeports.ts";

const KEY = "sk_test_RECOGNISABLE_KEY_0123456789";
const TTS = "/v1/text-to-speech/";
const CHAT = "c1";
const BR = "main";

let f: FakePorts;
let kvMap: Map<string, string>;
let version = 0;

beforeEach(() => {
  kvMap = new Map();
  setKv({
    get: (k) => kvMap.get(k) ?? null,
    set: (k, v) => { kvMap.set(k, v); },
    remove: (k) => { kvMap.delete(k); },
    keys: () => [...kvMap.keys()],
  });
  setState({ chats: {}, items: {}, states: {}, connected: false, sections: {} });
  f = createFakePorts({ key: KEY });
  setVoicePorts(f.ports);
  resetEngine();
  Object.assign(sessionDeps, { setTimer: f.timers.setTimer, clearTimer: f.timers.clearTimer, load: async () => {} });
  setVoiceSettings({ voiceId: "vsv1", voiceName: "Voice 1" });
  f.calls.length = 0;
  serveVoice(f.net);
});

afterEach(() => {
  voice.end();
  speaker.stopAll();
  resetEngine();
});

// ---- helpers

const frame = (type: string, text?: string) => JSON.stringify(text === undefined ? { message_type: type } : { message_type: type, text });
const partial = (s: FakeSocket, text: string) => s.receive(frame("partial_transcript", text));
const committed = (s: FakeSocket, text: string) => s.receive(frame("committed_transcript", text));
const audioFrames = (s: FakeSocket) => s.sent.map((t) => JSON.parse(t) as { audio_base_64: string; commit: boolean }).filter((m) => !m.commit);
const commitFrames = (s: FakeSocket) => s.sent.map((t) => JSON.parse(t) as { commit: boolean }).filter((m) => m.commit);
const session = (): SessionState => sessionStore.get();
const ttsTexts = () => f.net.to(TTS).map((q) => (q.req.json as { text: string }).text);

function setChat(status: Status = "ready", id = CHAT): void {
  setState((s) => ({ chats: { ...s.chats, [id]: { id, status, title: "", locked: false } as unknown as ChatView } }));
}
function setItems(items: Item[], chat = CHAT, branch = BR): void {
  setState((s) => ({ items: { ...s.items, [branchKey(chat, branch)]: { version: ++version, items } } }));
}
const user = (text: string): Item => ({ kind: "user", text });
const reply = (text: string, done = false): Item => ({ kind: "text", text, done });

/** Starts speech mode on CHAT and opens its socket; `sent` collects what the composer's send was given. */
async function speech(o: { send?: (text: string) => Promise<unknown> } = {}) {
  const sent: string[] = [];
  const p = voice.startSpeech({
    chat: CHAT, branch: BR, anchor: "speech:c1",
    send: o.send ?? (async (text) => { sent.push(text); }),
  });
  await waitFor(() => f.net.sockets.length === 1, "the socket");
  const sock = f.net.sockets[0];
  sock.open();
  await p;
  return { sent, sock, mic: f.audio.mics[0] };
}

function sinkLog() {
  const shown: { committed: string; partial: string }[] = [];
  const done: string[] = [];
  const sink: DictationSink = { show: (t) => { shown.push(t); }, done: (t) => { done.push(t); } };
  return { sink, shown, done };
}

async function dictation() {
  const log = sinkLog();
  const p = voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink: log.sink });
  await waitFor(() => f.net.sockets.length === 1, "the socket");
  const sock = f.net.sockets[0];
  sock.open();
  await p;
  return { ...log, sock, mic: f.audio.mics[0] };
}

/** Says a turn and lets Auto-send's pause run out: the turn is sent. */
async function sayAndSend(sock: FakeSocket, words: string) {
  partial(sock, words.replace(/[.!?]$/, ""));
  committed(sock, words);
  assert.equal(session().phase, "countdown");
  f.advance(1200);
  await settle();
}

// ---- tests

describe("a fresh engine", () => {
  test("listening's methods make no call before a start", async () => {
    voice.end();
    voice.mute(true);
    voice.send();
    voice.cancelCountdown();
    voice.interrupt();
    session();
    spokenMark(CHAT, BR, 0);
    await settle();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(session(), sessionStore.get());
    assert.equal(session().phase, "idle");
  });

  test("the hooks answer the idle session and no mark", () => {
    const C = () => {
      const phase = useVoiceSession((s) => s.phase);
      const owner = useVoiceSession((s) => s.owner);
      const mark = useSpokenMark(CHAT, BR, 0);
      return createElement("span", null, `${phase}|${owner === null}|${mark}`);
    };
    assert.equal(renderToString(createElement(C)), "<span>idle|true|false</span>");
  });
});

describe("starting", () => {
  test("no key: the popover, and no microphone and no socket", async () => {
    f.keystore.key = null;
    await voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    assert.equal(problemStore.get()?.kind, "no_key");
    assert.equal(problemStore.get()?.anchor, "speech:c1");
    assert.equal(f.audio.mics.length, 0);
    assert.equal(f.net.sockets.length, 0);
    assert.equal(session().phase, "idle");
    assert.ok(!f.calls.some((c) => c.startsWith("audio.") || c.startsWith("net.")));
  });

  test("a blocked microphone (the checks' switch, and the port's refusal) is mic_blocked, with no socket", async () => {
    flags.denyMic = true;
    await voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink: sinkLog().sink });
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(f.audio.mics.length, 0);
    flags.denyMic = false;
    f.audio.permission = "denied";
    await voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink: sinkLog().sink });
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(f.net.sockets.length, 0);
    assert.equal(session().phase, "idle");
  });

  test("the socket asks for the model, the format, the strategy, the silence and the language", async () => {
    setVoiceSettings({ language: "de" });
    const { sock, mic } = await speech();
    assert.equal(sock.path, "/v1/speech-to-text/realtime");
    assert.deepEqual(sock.query, {
      model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "vad", vad_silence_threshold_secs: "0.6", language_code: "de",
    });
    assert.deepEqual(mic.opts, { chunkMs: 100, echoCancel: true });
    assert.equal(session().phase, "listening");
    assert.deepEqual(session().owner, { kind: "speech", chat: CHAT, branch: BR });
  });

  test("chunks said while the socket opens go up once it is open, in order", async () => {
    const p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    assert.equal(session().phase, "starting");
    f.audio.mics[0].chunk("AAA1");
    f.audio.mics[0].chunk("AAA2");
    const sock = f.net.sockets[0];
    assert.equal(sock.sent.length, 0);
    sock.open();
    await p;
    assert.deepEqual(audioFrames(sock).map((m) => m.audio_base_64), ["AAA1", "AAA2"]);
    const m = JSON.parse(sock.sent[0]);
    assert.deepEqual(Object.keys(m).sort(), ["audio_base_64", "commit", "message_type", "sample_rate"]);
    assert.equal(m.sample_rate, 16000);
  });

  test("a socket that fails before it opens is named by one voices call: rejected key, credits, or can't reach", async () => {
    f.net.on((r) => r.path === "/v2/voices", ERR.rejected);
    let p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    f.net.sockets[0].fail();
    await p;
    assert.equal(problemStore.get()?.kind, "key_rejected");
    assert.equal(f.audio.mics[0].stopped, true);
    assert.equal(session().phase, "idle");

    f.net.on((r) => r.path === "/v2/voices", ERR.credits);
    p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 2, "the second socket");
    f.net.sockets[1].fail();
    await p;
    assert.equal(problemStore.get()?.kind, "no_credits");

    f.net.on((r) => r.path === "/v2/voices", () => ({ json: { voices: [], total_count: 0 } }));
    p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 3, "the third socket");
    f.net.sockets[2].fail();
    await p;
    assert.equal(problemStore.get()?.kind, "offline");
    assert.equal(typeof problemStore.get()?.retry, "function");
  });

  test("a refusal said on the socket before it opens is that problem; the no-key close is no_key", async () => {
    let p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    f.net.sockets[0].receive(frame("quota_exceeded"));
    f.net.sockets[0].serverClose(1008);
    await p;
    assert.equal(problemStore.get()?.kind, "no_credits");
    assert.equal(f.net.to("/v2/voices").length, 0, "no call was needed to name it");

    p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 2, "the second socket");
    f.net.sockets[1].fail(1008);
    await p;
    assert.equal(problemStore.get()?.kind, "no_key");
  });

  test("a socket that never opens is can't reach after the call wait", async () => {
    waits.callMs = 30;
    const p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await p;
    assert.equal(problemStore.get()?.kind, "offline");
    assert.equal(f.net.sockets[0].closedByEngine, true);
    assert.equal(f.audio.mics[0].stopped, true);
  });

  test("End while the socket opens stops the microphone at once, and nothing is shown", async () => {
    const p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async () => {} });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    voice.end();
    await p;
    assert.equal(f.audio.mics[0].stopped, true);
    assert.equal(f.net.sockets[0].closedByEngine, true);
    assert.equal(problemStore.get(), null);
    assert.equal(session().phase, "idle");
  });

  test("one session at a time: a start ends the session running", async () => {
    const { sock, mic } = await speech();
    const d = voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink: sinkLog().sink });
    assert.equal(sock.closedByEngine, true);
    assert.equal(mic.stopped, true);
    await waitFor(() => f.net.sockets.length === 2, "the dictation's socket");
    f.net.sockets[1].open();
    await d;
    assert.equal(session().owner?.kind, "dictation");
    assert.equal(f.audio.mics.length, 2);
  });
});

describe("dictation", () => {
  test("shows the guess, appends the committed words, never sends however long the silence, and ends with the final words", async () => {
    const d = await dictation();
    assert.deepEqual(d.mic.opts, { chunkMs: 100, echoCancel: false });
    partial(d.sock, "hello");
    assert.deepEqual(d.shown.at(-1), { committed: "", partial: "hello" });
    partial(d.sock, "hello wor");
    assert.deepEqual(d.shown.at(-1), { committed: "", partial: "hello wor" });
    committed(d.sock, "Hello world.");
    assert.deepEqual(d.shown.at(-1), { committed: "Hello world.", partial: "" });
    partial(d.sock, "and more");
    committed(d.sock, "And more.");
    assert.deepEqual(d.shown.at(-1), { committed: "Hello world. And more.", partial: "" });
    f.advance(60_000);
    await settle();
    assert.equal(session().phase, "listening");
    assert.equal(session().countdown, null);
    assert.equal(f.timers.pending, 0, "dictation waits for no pause");
    assert.equal(commitFrames(d.sock).length, 0);
    partial(d.sock, "last words");
    voice.send(); // nothing: dictation has no Send
    assert.equal(commitFrames(d.sock).length, 0);
    voice.end();
    assert.deepEqual(d.done, ["Hello world. And more. last words"]);
    assert.equal(d.sock.closedByEngine, true);
    assert.equal(d.mic.stopped, true);
    assert.equal(session().phase, "idle");
    assert.equal(f.net.to(TTS).length, 0, "dictation speaks nothing");
    assert.equal(speaker.current(), null);
  });

  test("a problem of the socket ends dictation and gives its words", async () => {
    const d = await dictation();
    committed(d.sock, "Kept words.");
    d.sock.receive(JSON.stringify({ message_type: "auth_error", error: "bad" }));
    assert.equal(problemStore.get()?.kind, "key_rejected");
    assert.equal(problemStore.get()?.anchor, "dictate:c1");
    assert.deepEqual(d.done, ["Kept words."]);
    assert.equal(d.mic.stopped, true);
    assert.equal(session().phase, "idle");
  });
});

describe("speech mode: the turn", () => {
  test("Auto-send: the pause after the last words runs, then the turn is sent through the screen's send", async () => {
    const { sent, sock } = await speech();
    setChat("thinking");
    partial(sock, "hello there");
    assert.equal(session().partial, "hello there");
    f.advance(QUIET_MS - 1);
    assert.equal(session().phase, "listening");
    f.advance(1);
    assert.equal(session().phase, "countdown");
    assert.deepEqual(session().countdown, { startedAt: f.ports.now(), ms: 1200 });
    f.advance(1199);
    assert.deepEqual(sent, []);
    f.advance(1);
    // the guess was not committed: Send asked the service to commit it, and waits for the segment
    assert.equal(commitFrames(sock).length, 1);
    assert.equal(session().phase, "sending");
    committed(sock, "Hello there.");
    await settle();
    assert.deepEqual(sent, ["Hello there."]);
    assert.equal(session().phase, "thinking");
    assert.equal(session().committed, "Hello there.", "the words of the turn stay shown until the reply starts");
  });

  test("Send waits up to a second for the segment, then sends the guess", async () => {
    setVoiceSettings({ autoSend: false });
    const { sent, sock } = await speech();
    partial(sock, "just the guess");
    voice.send();
    assert.equal(commitFrames(sock).length, 1);
    f.advance(COMMIT_WAIT_MS - 1);
    assert.deepEqual(sent, []);
    f.advance(1);
    await settle();
    assert.deepEqual(sent, ["just the guess"]);
  });

  test("Cancel stops the countdown and keeps the words; nothing is sent until Send", async () => {
    const { sent, sock } = await speech();
    partial(sock, "keep these words");
    committed(sock, "Keep these words.");
    assert.equal(session().phase, "countdown");
    voice.cancelCountdown();
    assert.equal(session().phase, "waiting");
    assert.equal(session().committed, "Keep these words.");
    assert.equal(session().countdown, null);
    f.advance(30_000);
    await settle();
    assert.deepEqual(sent, []);
    voice.send();
    await settle();
    assert.deepEqual(sent, ["Keep these words."]);
  });

  test("talking on during the countdown ends it and the words go on", async () => {
    const { sent, sock } = await speech();
    committed(sock, "First part.");
    assert.equal(session().phase, "countdown");
    f.advance(600);
    partial(sock, "and the second");
    assert.equal(session().phase, "listening");
    committed(sock, "And the second.");
    f.advance(1199);
    assert.deepEqual(sent, []);
    f.advance(1);
    await settle();
    assert.deepEqual(sent, ["First part. And the second."]);
  });

  test("Auto-send off: the words wait for Send", async () => {
    setVoiceSettings({ autoSend: false });
    const { sent, sock } = await speech();
    committed(sock, "Waiting for send.");
    assert.equal(session().phase, "waiting");
    f.advance(60_000);
    await settle();
    assert.deepEqual(sent, []);
    voice.send();
    await settle();
    assert.deepEqual(sent, ["Waiting for send."]);
  });

  test("the Auto-send toggle is read live: turned off during a countdown, the turn waits", async () => {
    const { sent, sock } = await speech();
    committed(sock, "Toggle me.");
    assert.equal(session().phase, "countdown");
    setVoiceSettings({ autoSend: false });
    assert.equal(session().phase, "waiting");
    f.advance(10_000);
    assert.deepEqual(sent, []);
  });

  test("a send that fails gives the words back to send again", async () => {
    let fail = true;
    const sent: string[] = [];
    const { sock } = await speech({ send: async (t) => { if (fail) throw new Error("refused"); sent.push(t); } });
    await sayAndSend(sock, "Try this.");
    assert.equal(session().phase, "waiting");
    assert.equal(session().committed, "Try this.");
    assert.equal(problemStore.get(), null, "a refused send is the screen's to say, not a voice problem");
    fail = false;
    voice.send();
    await settle();
    assert.deepEqual(sent, ["Try this."]);
  });

  test("nothing said while the turn is on its way counts, and no chunk goes up", async () => {
    let release!: () => void;
    const { sock, mic } = await speech({ send: () => new Promise<void>((r) => { release = r; }) });
    setChat("thinking");
    await sayAndSend(sock, "On its way.");
    assert.equal(session().phase, "sending");
    const before = audioFrames(sock).length;
    mic.chunk("LATE");
    assert.equal(audioFrames(sock).length, before);
    assert.equal(mic.muted, true, "the microphone is muted while the turn is on its way");
    partial(sock, "late words");
    assert.equal(session().partial, "");
    release();
    await settle();
    assert.equal(session().phase, "thinking");
    mic.chunk("STILL");
    assert.equal(audioFrames(sock).length, before);
  });
});

describe("Mute and End", () => {
  test("Mute: no chunk goes up and the socket stays; unmuted, chunks go again", async () => {
    const { sock, mic } = await speech();
    mic.chunk("ONE");
    assert.equal(audioFrames(sock).length, 1);
    voice.mute(true);
    assert.equal(session().muted, true);
    assert.equal(mic.muted, true);
    mic.chunk("TWO");
    mic.chunk("THREE");
    assert.equal(audioFrames(sock).length, 1);
    assert.equal(sock.closed, false);
    voice.mute(false);
    mic.chunk("FOUR");
    assert.deepEqual(audioFrames(sock).map((m) => m.audio_base_64), ["ONE", "FOUR"]);
  });

  test("End: the microphone stops, the socket closes, and no chunk goes up after it", async () => {
    const { sock, mic } = await speech();
    mic.chunk("ONE");
    voice.end();
    assert.equal(sock.closedByEngine, true);
    assert.equal(mic.stopped, true);
    const n = sock.sent.length;
    mic.chunk("TWO"); // a port that still gave one
    assert.equal(sock.sent.length, n);
    assert.deepEqual(session(), { ...session(), owner: null, phase: "idle" });
  });

  test("the system taking the audio ends the session quietly", async () => {
    const { sock } = await speech();
    f.audio.interrupt();
    assert.equal(sock.closedByEngine, true);
    assert.equal(session().phase, "idle");
    assert.equal(problemStore.get(), null);
  });
});

describe("the socket during a session", () => {
  test("closed by the service, it is opened again at the next chunk", async () => {
    const { sock, mic } = await speech();
    sock.serverClose(1000);
    assert.equal(session().phase, "listening");
    mic.chunk("AFTER");
    assert.equal(f.net.sockets.length, 2);
    const again = f.net.sockets[1];
    again.open();
    assert.deepEqual(audioFrames(again).map((m) => m.audio_base_64), ["AFTER"]);
    assert.equal(problemStore.get(), null);
  });

  test("a session time limit is no problem: the next chunk opens another socket", async () => {
    const { sock, mic } = await speech();
    sock.receive(frame("session_time_limit_exceeded"));
    assert.equal(sock.closedByEngine, true);
    mic.chunk("NEXT");
    assert.equal(f.net.sockets.length, 2);
    assert.equal(problemStore.get(), null);
  });

  test("a problem of the socket ends the session and leaves the turn already sent alone", async () => {
    const { sent, sock, mic } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Already sent.");
    assert.deepEqual(sent, ["Already sent."]);
    sock.receive(JSON.stringify({ message_type: "quota_exceeded", error: "no credits" }));
    assert.equal(problemStore.get()?.kind, "no_credits");
    assert.equal(session().phase, "idle");
    assert.equal(mic.stopped, true);
    assert.deepEqual(sent, ["Already sent."]);
    assert.equal(f.net.to(TTS).length, 0);
  });
});

describe("the reply", () => {
  test("is spoken sentence by sentence while it grows, each sentence once, and flushed at done", async () => {
    const { sock } = await speech();
    setItems([user("Earlier."), reply("Earlier reply.", true)]);
    setChat("thinking");
    await sayAndSend(sock, "Tell me.");
    assert.equal(session().phase, "thinking");
    setItems([user("Earlier."), reply("Earlier reply.", true), user("Tell me."), reply("The first sentence is here. The sec")]);
    await waitFor(() => ttsTexts().length === 1, "the first sentence's request");
    assert.deepEqual(ttsTexts(), ["The first sentence is here."]);
    await waitFor(() => session().phase === "speaking", "speaking");
    assert.equal(session().spoken, "The first sentence is here.");
    setItems([user("Earlier."), reply("Earlier reply.", true), user("Tell me."), reply("The first sentence is here. The second one is longer now. And a thi")]);
    setItems([user("Earlier."), reply("Earlier reply.", true), user("Tell me."), reply("The first sentence is here. The second one is longer now. And a third without an end", true)]);
    setItems([user("Earlier."), reply("Earlier reply.", true), user("Tell me."), reply("The first sentence is here. The second one is longer now. And a third without an end", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    assert.deepEqual(ttsTexts(), ["The first sentence is here.", "The second one is longer now.", "And a third without an end"]);
    assert.equal(session().spoken, "");
  });

  test("a rewritten text repeats nothing", async () => {
    const { sock } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Rewrite.");
    setItems([user("Rewrite."), reply("Alpha is the first sentence. Beta goes")]);
    await waitFor(() => ttsTexts().length === 1, "the first request");
    setItems([user("Rewrite."), reply("Something else entirely here now. Gamma is a new sentence.", true)]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    const texts = ttsTexts();
    assert.equal(texts[0], "Alpha is the first sentence.");
    assert.equal(texts.filter((t) => t.includes("Alpha")).length, 1);
    assert.ok(!texts.slice(1).some((t) => t.includes("Something else")), `nothing before the length fed is said: ${JSON.stringify(texts)}`);
  });

  test("several text items: each is flushed when the next one comes; tools are passed by", async () => {
    const { sock } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Two items.");
    setItems([user("Two items."), reply("Looking at the board first"), { kind: "tool", name: "read" }, reply("Done with the board now.", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    assert.deepEqual(ttsTexts(), ["Looking at the board first", "Done with the board now."]);
  });

  test("a server that sends no end item: the reply is over when its last text is finished and the branch is idle", async () => {
    const { sock } = await speech();
    setChat("ready");
    await sayAndSend(sock, "No end item.");
    setItems([user("No end item."), reply("A reply that a server finishes without an end.", true)]);
    await waitFor(() => session().phase === "listening", "listening again");
    assert.deepEqual(ttsTexts(), ["A reply that a server finishes without an end."]);
  });

  test("a reply with nothing to say goes back to listening at once", async () => {
    const { sock } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Silent.");
    setItems([user("Silent."), { kind: "tool", name: "edit" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    assert.equal(f.net.to(TTS).length, 0);
  });

  test("the next turn goes after the reply, with the socket kept", async () => {
    const { sent, sock } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "First turn.");
    setItems([user("First turn."), reply("Short answer here.", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    await sayAndSend(sock, "Second turn.");
    assert.deepEqual(sent, ["First turn.", "Second turn."]);
    assert.equal(f.net.sockets.length, 1);
  });

  test("a problem of a sentence ends the session with its popover; the turn stays sent", async () => {
    f.net.on((r) => r.path.startsWith(TTS), ERR.rejected);
    const { sent, sock, mic } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Speak up.");
    setItems([user("Speak up."), reply("This will not be heard at all.", true)]);
    await waitFor(() => session().phase === "idle", "the session ended");
    assert.equal(problemStore.get()?.kind, "key_rejected");
    assert.equal(problemStore.get()?.anchor, "speech:c1");
    assert.equal(mic.stopped, true);
    assert.deepEqual(sent, ["Speak up."]);
  });
});

describe("barge-in", () => {
  /** Speech mode with a reply being spoken: the first sentence's sound has begun, its request still streams. */
  async function speaking(bargeIn: boolean) {
    f.audio.voiceBargeIn = bargeIn;
    serveVoice(f.net, { manual: true });
    const s = await speech();
    setChat("thinking");
    await sayAndSend(s.sock, "Weather please.");
    setItems([user("Weather please."), reply("The weather today is sunny and warm. Tomorrow brings heavy rain to the coast.")]);
    await waitFor(() => f.net.to(TTS).length >= 1, "the first request");
    f.audio.auto = false; // the player plays at the test's word: the sound is still going
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.marks.length === 1, "the first sentence's mark");
    f.audio.reach(f.audio.marks[0]);
    await waitFor(() => session().phase === "speaking", "speaking");
    return s;
  }

  test("the echo rule: two words or more, fewer than half of them in what is being spoken", () => {
    const said = ["The weather today is sunny and warm."];
    assert.equal(bargesIn("weather today is sunny", said), false);
    assert.equal(bargesIn("stop", said), false);
    assert.equal(bargesIn("wait stop please", said), true);
    assert.equal(bargesIn("the weather stop please now", said), true);
    assert.equal(bargesIn("the weather is stop", said), false);
  });

  test("with voice barge-in: chunks go up while the reply plays; its echo does not interrupt, new words do", async () => {
    const { sock, mic } = await speaking(true);
    assert.equal(mic.opts.echoCancel, true);
    const n = audioFrames(sock).length;
    mic.chunk("WHILE");
    assert.equal(audioFrames(sock).length, n + 1, "the microphone is heard while the reply plays");
    partial(sock, "weather today is sunny");
    assert.equal(session().phase, "speaking", "the echo of the sentence playing does not interrupt");
    const stopsBefore = f.audio.stops;
    partial(sock, "wait a moment");
    assert.equal(session().phase, "listening");
    assert.equal(session().partial, "wait a moment", "what interrupted starts the next turn");
    assert.ok(f.audio.stops > stopsBefore, "the sound stopped");
    assert.ok(f.net.to(TTS).every((q) => q.aborted || q.finished), "the requests were cancelled");
  });

  test("after the reply played, its echo is not taken for a new turn", async () => {
    f.audio.voiceBargeIn = true;
    const { sent, sock } = await speech();
    setChat("thinking");
    await sayAndSend(sock, "Short one.");
    setItems([user("Short one."), reply("Here is the short reply.", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    committed(sock, "the short reply");
    assert.equal(session().committed, "");
    f.advance(ECHO_TAIL_MS);
    committed(sock, "the short reply");
    assert.equal(session().committed, "the short reply", "after the tail it is the person's");
    assert.deepEqual(sent, ["Short one."]);
  });

  test("without voice barge-in: no chunk goes up while the reply plays, and nothing heard interrupts", async () => {
    const { sock, mic } = await speaking(false);
    assert.equal(mic.muted, true, "the engine mutes the microphone while the reply plays");
    const n = audioFrames(sock).length;
    mic.chunk("WHILE");
    assert.equal(audioFrames(sock).length, n);
    partial(sock, "wait a moment please");
    assert.equal(session().phase, "speaking");
  });

  test("a tap interrupts: the sound stops, the requests are cancelled, the session listens again", async () => {
    const { sock, mic } = await speaking(false);
    voice.interrupt();
    assert.equal(session().phase, "listening");
    assert.ok(f.net.to(TTS).every((q) => q.aborted || q.finished));
    assert.equal(mic.muted, false, "listening again: the microphone is open");
    mic.chunk("AGAIN");
    assert.equal(audioFrames(sock).at(-1)?.audio_base_64, "AGAIN");
    // the reply goes on growing: nothing more is spoken of it
    const asked = f.net.to(TTS).length;
    setItems([user("Weather please."), reply("The weather today is sunny and warm. Tomorrow brings heavy rain to the coast. And more after that.", true)]);
    await settle();
    assert.equal(f.net.to(TTS).length, asked);
  });

  test("without voice barge-in, a message read aloud during the session closes the gate until it ends", async () => {
    serveVoice(f.net, { manual: true });
    const { sock, mic } = await speech();
    const reading = voice.readAloud({ chat: CHAT, branch: BR, index: 0, text: "A message read aloud here.", anchor: "read:c1:main:0" });
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    const n = audioFrames(sock).length;
    mic.chunk("DURING");
    assert.equal(audioFrames(sock).length, n);
    assert.equal(mic.muted, true);
    voice.stopReading();
    await reading;
    mic.chunk("AFTER");
    assert.equal(audioFrames(sock).at(-1)?.audio_base_64, "AFTER");
    assert.equal(session().phase, "listening", "Read aloud does not end the session");
  });

  test("a tap interrupts a message read aloud, with no session", async () => {
    serveVoice(f.net, { manual: true });
    const reading = voice.readAloud({ chat: CHAT, branch: BR, index: 0, text: "A message read aloud here.", anchor: "read:c1:main:0" });
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    voice.interrupt();
    await reading;
    assert.equal(f.net.to(TTS)[0].aborted, true);
  });

  test("End while the reply plays stops it", async () => {
    const { sock } = await speaking(false);
    voice.end();
    assert.ok(f.net.to(TTS).every((q) => q.aborted || q.finished));
    assert.equal(sock.closedByEngine, true);
    assert.equal(session().phase, "idle");
  });
});

describe("the pill", () => {
  test("the turn goes to the target the pill names at send, through its send, and the reply is spoken", async () => {
    const asked: string[] = [];
    const sent: [string, string][] = [];
    const p = voice.startPill({
      board: "b1", anchor: "orb:b1",
      target: async () => { asked.push("target"); setChat("thinking"); return CHAT; },
      send: async (chat, text) => { sent.push([chat, text]); },
    });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    f.net.sockets[0].open();
    await p;
    assert.deepEqual(session().owner, { kind: "pill", board: "b1" });
    assert.deepEqual(asked, [], "no chat is made by opening the pill");
    await sayAndSend(f.net.sockets[0], "Draw a box.");
    assert.deepEqual(asked, ["target"]);
    assert.deepEqual(sent, [[CHAT, "Draw a box."]]);
    assert.equal(session().target, CHAT);
    setItems([user("<selection ids=\"a\" label=\"1 element\">box</selection> Draw a box."), reply("I drew the box for you.", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => session().phase === "listening", "listening again");
    assert.deepEqual(ttsTexts(), ["I drew the box for you."]);
    assert.equal(spokenMark(CHAT, BR, 0), true, "the mark is set on the message that carries the selection tag before the words");
  });

  test("a list not loaded is loaded before the turn is sent", async () => {
    const loads: string[] = [];
    sessionDeps.load = async (chat) => { loads.push(chat); setItems([user("Old.")]); };
    const sent: string[] = [];
    const p = voice.startPill({ board: "b1", anchor: "orb:b1", target: async () => CHAT, send: async (_c, t) => { sent.push(t); } });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    f.net.sockets[0].open();
    await p;
    await sayAndSend(f.net.sockets[0], "Old.");
    assert.deepEqual(loads, [CHAT]);
    assert.deepEqual(sent, ["Old."]);
    setItems([user("Old."), user("Old.")]);
    await settle();
    assert.equal(spokenMark(CHAT, BR, 0), false, "the message before the send is not the turn's");
    assert.equal(spokenMark(CHAT, BR, 1), true);
  });

  test("no target (the chat could not be made): the words wait to be sent again", async () => {
    const sent: string[] = [];
    const p = voice.startPill({ board: "b1", anchor: "orb:b1", target: async () => null, send: async (_c, t) => { sent.push(t); } });
    await waitFor(() => f.net.sockets.length === 1, "the socket");
    f.net.sockets[0].open();
    await p;
    await sayAndSend(f.net.sockets[0], "Nowhere to go.");
    assert.deepEqual(sent, []);
    assert.equal(session().phase, "waiting");
    assert.equal(session().committed, "Nowhere to go.");
  });
});

describe("the mic marks", () => {
  test("the arriving user message of a spoken turn is marked and kept in the kv; a typed one is not", async () => {
    const { sock } = await speech();
    setItems([user("Typed before.")]);
    await sayAndSend(sock, "Spoken now.");
    assert.equal(spokenMark(CHAT, BR, 1), false, "not before it arrives");
    setItems([user("Typed before."), user("Spoken now."), reply("ok", true), user("Typed after.")]);
    assert.equal(spokenMark(CHAT, BR, 1), true);
    assert.equal(spokenMark(CHAT, BR, 0), false);
    assert.equal(spokenMark(CHAT, BR, 3), false);
    assert.deepEqual(JSON.parse(kvMap.get(MARKS_KEY) ?? "[]"), [[CHAT, BR, 1]]);
    // a fresh engine reads them back
    resetEngine();
    assert.equal(spokenMark(CHAT, BR, 1), true);
  });

  test("the hook re-renders when the mark arrives", () => {
    noteSpoken({ chat: CHAT, branch: BR, before: 0, text: "Hello." });
    const C = () => createElement("span", null, String(useSpokenMark(CHAT, BR, 0)));
    assert.equal(renderToString(createElement(C)), "<span>false</span>");
    setItems([user("Hello.")]);
    assert.equal(renderToString(createElement(C)), "<span>true</span>");
  });

  test("marks of a chat that is gone are pruned once its server's tree is in, not before", () => {
    kvMap.set(MARKS_KEY, JSON.stringify([["gone", "main", 0], [CHAT, "main", 2], ["srv~x", "main", 1]]));
    resetEngine();
    setChat("ready");
    spokenMark(CHAT, BR, 0); // the first use: the store starts watching
    noteSpoken({ chat: "other", branch: BR, before: 0, text: "x" });
    assert.equal(spokenMark("gone", "main", 0), true, "this computer's tree is not in yet");
    setState({ connected: true, chats: { ...getState().chats } });
    assert.equal(spokenMark("gone", "main", 0), false);
    assert.equal(spokenMark(CHAT, "main", 2), true);
    assert.equal(spokenMark("srv~x", "main", 1), true, "a section that has not connected keeps its marks");
    assert.deepEqual(marksStore.get().marks.map((m) => m.chat).sort(), [CHAT, "srv~x"].sort());
  });

  test("a turn is compared without the reference tags it starts with", () => {
    assert.equal(turnWords("<selection ids=\"a,b\" label=\"2 elements\">x</selection> Make it red. "), "Make it red.");
    assert.equal(turnWords("<point x=\"1\" y=\"2\"/> <selection ids=\"a\" label=\"1\">y</selection>Here."), "Here.");
    assert.equal(turnWords("Middle <point x=\"1\" y=\"2\"/> stays."), "Middle <point x=\"1\" y=\"2\"/> stays.");
  });
});

describe("the session hook", () => {
  test("a selector that answers the same value does not re-render on a level change", async () => {
    const { mic } = await speech();
    let renders = 0;
    const phases: string[] = [];
    const C = () => {
      renders++;
      const phase = useVoiceSession((s) => s.phase);
      phases.push(phase);
      return createElement("span", null, phase);
    };
    assert.equal(renderToString(createElement(C)), "<span>listening</span>");
    mic.chunk("LVL", 0.7);
    assert.equal(session().level, 0.7);
    assert.equal(renders, 1);
    assert.deepEqual(phases, ["listening"]);
  });
});
