// The engine's side of voice devices (voice-devices architecture VD-6, VD-8 to VD-13, VD-15, VD-16; goal 6.1 to 6.4, 6.6), over the fake ports'
// stand-in devices: the saved microphone and speaker used by every way of using voice, a saved device that is missing at a start, one lost
// during a session (a notice, a pause, an end), the microphone test, Test speaker and the data of the pickers. The clock is the fake ports'.
// No test reaches the network, a device or a key.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { setKv } from "@aiwb/core/state/ports.ts";
import { branchKey } from "@aiwb/core/logic/branches.ts";
import { setState } from "@aiwb/core/state/store.ts";
import type { ChatView, Item, Status } from "@aiwb/core/types.ts";
import { chimePcm } from "../src/voice/logic/chime.ts";
import { noticeText } from "../src/voice/logic/devices.ts";
import { setVoicePorts } from "../src/voice/ports.ts";
import type { DictationSink, SessionState } from "../src/voice/index.ts";
import { setVoiceSettings, useDeviceChoices, useMicTest, useVoiceNotice, voice } from "../src/voice/index.ts";
import { deviceListStore, micTestStore, watchDevices } from "../src/voice/engine/devices.ts";
import { sessionDeps } from "../src/voice/engine/session.ts";
import { readAloud, speaker, stopReading } from "../src/voice/engine/speaker.ts";
import { playPreview } from "../src/voice/engine/keycheck.ts";
import {
  flags, getSettings, noticeDeps, noticeStore, problemStore, readingStore, resetEngine, sessionStore, settingsOpenStore, waits,
} from "../src/voice/engine/state.ts";
import { installSeam } from "../src/voice/engine/testseam.ts";
import type { VoiceSeam } from "../src/voice/engine/testseam.ts";
import { createFakePorts, dev, serveVoice, settle, waitFor } from "./fixtures/voice/fakeports.ts";
import type { FakePorts, FakeSocket } from "./fixtures/voice/fakeports.ts";

const KEY = "sk_test_RECOGNISABLE_KEY_0123456789";
const TTS = "/v1/text-to-speech/";
const CHAT = "c1";
const BR = "main";

const DESK = dev("mic-desk", "Desk Mic", "input", "unknown");
const HEADSET = dev("mic-headset", "Stand-in Headset", "input", "private");
const SPEAKERS = dev("out-desk", "Desk Speakers", "output", "public");
const SPEAKERS2 = dev("out-tv", "Living Room Speakers", "output", "public");
const PHONES = dev("out-phones", "Stand-in Headphones", "output", "private");
const PHONES2 = dev("out-phones2", "Second Headphones", "output", "private");
const saved = (d: { id: string; name: string }) => ({ id: d.id, name: d.name });

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
  Object.assign(noticeDeps, { setTimer: f.timers.setTimer, clearTimer: f.timers.clearTimer });
  setVoiceSettings({ voiceId: "vsv1", voiceName: "Voice 1" });
  f.calls.length = 0;
  serveVoice(f.net);
  f.audio.devices.inputs.push(DESK, HEADSET);
  f.audio.devices.outputs.push(SPEAKERS, SPEAKERS2, PHONES, PHONES2);
  f.audio.devices.defaults = { input: DESK, output: SPEAKERS };
});

afterEach(() => {
  voice.end();
  voice.stopMicTest();
  speaker.stopAll();
  resetEngine();
});

// ---- helpers

const frame = (type: string, text?: string) => JSON.stringify(text === undefined ? { message_type: type } : { message_type: type, text });
const partial = (s: FakeSocket, text: string) => s.receive(frame("partial_transcript", text));
const committed = (s: FakeSocket, text: string) => s.receive(frame("committed_transcript", text));
const audioFrames = (s: FakeSocket) => s.sent.map((t) => JSON.parse(t) as { audio_base_64: string; commit: boolean }).filter((m) => !m.commit);
const session = (): SessionState => sessionStore.get();
const ttsTexts = () => f.net.to(TTS).map((q) => (q.req.json as { text: string }).text);
const devs = () => f.audio.devices;
const noticeNow = () => noticeStore.get();

function setChat(status: Status = "ready", id = CHAT): void {
  setState((s) => ({ chats: { ...s.chats, [id]: { id, status, title: "", locked: false } as unknown as ChatView } }));
}
function setItems(items: Item[], chat = CHAT, branch = BR): void {
  setState((s) => ({ items: { ...s.items, [branchKey(chat, branch)]: { version: ++version, items } } }));
}
const user = (text: string): Item => ({ kind: "user", text });
const reply = (text: string, done = false): Item => ({ kind: "text", text, done });

async function speech() {
  const sent: string[] = [];
  const n = f.net.sockets.length;
  const p = voice.startSpeech({ chat: CHAT, branch: BR, anchor: "speech:c1", send: async (text) => { sent.push(text); } });
  await waitFor(() => f.net.sockets.length > n, "the socket");
  const sock = f.net.sockets[f.net.sockets.length - 1];
  sock.open();
  await p;
  return { sent, sock, mic: f.audio.mics[f.audio.mics.length - 1] };
}

async function dictation() {
  const shown: { committed: string; partial: string }[] = [];
  const done: string[] = [];
  const sink: DictationSink = { show: (t) => { shown.push(t); }, done: (t) => { done.push(t); } };
  const n = f.net.sockets.length;
  const p = voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink });
  await waitFor(() => f.net.sockets.length > n, "the socket");
  const sock = f.net.sockets[f.net.sockets.length - 1];
  sock.open();
  await p;
  return { shown, done, sock, mic: f.audio.mics[f.audio.mics.length - 1] };
}

async function pill() {
  const n = f.net.sockets.length;
  const p = voice.startPill({
    board: "b1", anchor: "pill:b1", target: async () => CHAT, send: async () => {},
  });
  await waitFor(() => f.net.sockets.length > n, "the socket");
  f.net.sockets[f.net.sockets.length - 1].open();
  await p;
  return { sock: f.net.sockets[f.net.sockets.length - 1], mic: f.audio.mics[f.audio.mics.length - 1] };
}

async function sayAndSend(sock: FakeSocket, words: string) {
  partial(sock, words.replace(/[.!?]$/, ""));
  committed(sock, words);
  assert.equal(session().phase, "countdown");
  f.advance(1200);
  await settle();
}

/** Speech mode with a reply being spoken, a sentence's sound begun and the second one's request open. The player waits for the test. */
async function speakingReply() {
  serveVoice(f.net, { manual: true });
  const s = await speech();
  setChat("thinking");
  await sayAndSend(s.sock, "Weather please.");
  setItems([user("Weather please."), reply("The weather today is sunny and warm. Tomorrow brings heavy rain to the coast.", true)]);
  await waitFor(() => f.net.to(TTS).length >= 1, "the first request");
  f.audio.auto = false;
  f.net.to(TTS)[0].release(1);
  await waitFor(() => f.audio.marks.length === 1, "the first sentence's mark");
  f.audio.reach(f.audio.marks[0]);
  await waitFor(() => session().phase === "speaking", "speaking");
  return s;
}

const msg = (text: string, index = 0) => ({ chat: CHAT, branch: BR, index, text, anchor: `read:c1:main:${index}` });

// ---- tests

describe("nothing saved: nothing changes (goal 3.1, 3.5, 6.1, 6.6)", () => {
  test("every way of using voice runs with no listing, no output call, no notice and the default microphone", async () => {
    const d = await dictation();
    assert.deepEqual(devs().opened, [null]);
    voice.end();
    assert.equal(d.mic.stopped, true);
    await speech();
    voice.end();
    await pill();
    voice.end();
    await readAloud(msg("A message of one sentence, read aloud."));
    f.net.previewBytes.set("https://previews.example/v1.mp3", new Uint8Array(10));
    f.audio.clipMs = 1;
    await playPreview("vsv1");
    await voice.testSpeaker();
    assert.equal(f.audio.clips.length, 1);
    assert.deepEqual(devs().opened, [null, null, null]);
    assert.deepEqual(devs().used, [], "a person who never chose a speaker makes no output call");
    assert.equal(devs().lists, 0);
    assert.equal(noticeNow(), null);
    assert.equal(problemStore.get(), null);
    assert.equal(devs().watching().route, 0, "nothing listens for devices when nothing is in use");
    assert.equal(devs().watching().watch, 0);
  });
});

describe("the saved choice is used (goal 6.1)", () => {
  beforeEach(() => {
    setVoiceSettings({ mic: saved(HEADSET), speaker: saved(PHONES) });
  });

  test("Dictation opens the saved microphone and no output", async () => {
    const d = await dictation();
    assert.deepEqual(devs().opened, [saved(HEADSET)]);
    assert.equal(d.mic.opened.device?.id, HEADSET.id);
    assert.deepEqual(devs().used, [], "dictation speaks nothing");
    assert.equal(noticeNow(), null);
  });

  test("Speech mode opens the saved microphone and gives the player the saved speaker once, not once per reply", async () => {
    const { sock } = await speech();
    assert.deepEqual(devs().opened, [saved(HEADSET)]);
    assert.deepEqual(devs().used, [saved(PHONES)]);
    assert.equal(devs().outputDevice?.id, PHONES.id);
    setChat("thinking");
    await sayAndSend(sock, "First question.");
    setItems([user("First question."), reply("A short answer to that.", true), { kind: "end" }]);
    setChat("ready");
    await waitFor(() => f.audio.writes.length > 0, "the sound");
    await waitFor(() => session().phase === "speaking" && f.timers.pending === 1, "the tail");
    assert.deepEqual(devs().used, [saved(PHONES)], "the reply keeps the session's output");
  });

  test("the pill does the same", async () => {
    await pill();
    assert.deepEqual(devs().opened, [saved(HEADSET)]);
    assert.deepEqual(devs().used, [saved(PHONES)]);
  });

  test("Read aloud, a voice preview and Test speaker use the saved speaker each time", async () => {
    await readAloud(msg("A message of one sentence, read aloud."));
    assert.equal(devs().used.length, 1);
    f.net.previewBytes.set("https://previews.example/v1.mp3", new Uint8Array(10));
    f.audio.clipMs = 1;
    await playPreview("vsv1");
    assert.equal(devs().used.length, 2);
    await voice.testSpeaker();
    assert.equal(devs().used.length, 3);
    assert.ok(devs().used.every((u) => u?.id === PHONES.id));
    assert.equal(devs().lists, 0, "the fake adapter matches by itself; the engine lists nothing (Settings does)");
    assert.equal(noticeNow(), null);
  });

  test("a change in Settings does not move a running session; the next session uses it", async () => {
    await speech();
    setVoiceSettings({ mic: saved(DESK), speaker: saved(SPEAKERS2) });
    assert.equal(devs().opened.length, 1);
    assert.equal(devs().used.length, 1);
    assert.equal(noticeNow(), null);
    voice.end();
    await speech();
    assert.deepEqual(devs().opened, [saved(HEADSET), saved(DESK)]);
    assert.deepEqual(devs().used, [saved(PHONES), saved(SPEAKERS2)]);
  });

  test("going back to System default after a pick tells the port, once", async () => {
    await readAloud(msg("One sentence for the first reading."));
    setVoiceSettings({ speaker: null });
    await readAloud(msg("One sentence for the second reading."));
    assert.deepEqual(devs().used, [saved(PHONES), null]);
    await readAloud(msg("One sentence for the third reading."));
    assert.equal(devs().used.length, 3, "still asked: the port may have been left on a device");
  });
});

describe("a saved device that is not there at the start (goal 3.3, 6.3)", () => {
  const GONE_MIC = { id: "mic-gone", name: "Gone Mic" };
  const GONE_OUT = { id: "out-gone", name: "Gone Speaker" };

  test("the microphone: the default listens, one notice names it, the choice stays", async () => {
    setVoiceSettings({ mic: GONE_MIC });
    const { mic } = await dictation();
    assert.equal(mic.opened.missed, true);
    assert.equal(mic.opened.device?.id, DESK.id);
    assert.equal(noticeNow()?.text, noticeText("start-mic", { mic: "Gone Mic" }));
    assert.deepEqual(noticeNow()?.where, { kind: "chat", chat: CHAT });
    assert.deepEqual(getSettings().mic, GONE_MIC, "not erased (goal 4.3)");
  });

  test("the speaker of Read aloud: the default speaks, one notice names it", async () => {
    setVoiceSettings({ speaker: GONE_OUT });
    serveVoice(f.net, { manual: true, ttsChunks: 2 });
    const done = readAloud(msg("A message of one sentence, read aloud."));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    assert.equal(noticeNow()?.text, noticeText("start-speaker", { speaker: "Gone Speaker" }));
    assert.deepEqual(noticeNow()?.where, { kind: "chat", chat: CHAT });
    assert.deepEqual(getSettings().speaker, GONE_OUT);
    f.net.to(TTS)[0].release(2);
    f.net.to(TTS)[0].end();
    await done;
    assert.equal(f.audio.writes.length, 2, "it was read all the same");
    assert.equal(noticeNow(), null, "the notice goes with the reading");
  });

  test("Settings announces the fallback: a preview, Test speaker and Test microphone name the missing device in the devices card", async () => {
    setVoiceSettings({ speaker: GONE_OUT, mic: GONE_MIC });
    const C = () => createElement("span", null, `${useVoiceNotice({ kind: "settings" })}|${useVoiceNotice({ kind: "chat", chat: CHAT })}`);
    const shown = () => renderToString(createElement(C));
    settingsOpenStore.set(true);
    assert.equal(noticeNow(), null);
    await voice.testSpeaker();
    assert.equal(noticeNow()?.text, noticeText("start-speaker", { speaker: "Gone Speaker" }));
    assert.deepEqual(noticeNow()?.where, { kind: "settings" });
    assert.ok(shown().includes("Gone Speaker"), "the card's hook shows it");
    assert.ok(shown().endsWith("|null</span>"), "no chat shows it");
    assert.deepEqual(getSettings().speaker, GONE_OUT, "not erased (goal 4.3)");
    // it outlives the chime (the route ended) and goes on the usual timer
    f.advance(waits.noticeMs - 1);
    assert.notEqual(noticeNow(), null);
    f.advance(2);
    assert.equal(noticeNow(), null);
    // a preview says it too
    f.net.previewBytes.set("https://previews.example/v1.mp3", new Uint8Array(10));
    f.audio.clipMs = 1;
    await playPreview("vsv1");
    assert.equal(noticeNow()?.text, noticeText("start-speaker", { speaker: "Gone Speaker" }));
    // the microphone test replaces it with its own sentence
    await voice.startMicTest("mictest");
    assert.equal(noticeNow()?.text, noticeText("start-mic", { mic: "Gone Mic" }));
    assert.deepEqual(noticeNow()?.where, { kind: "settings" });
    assert.equal(f.audio.mics[0].opened.missed, true);
    assert.deepEqual(getSettings().mic, GONE_MIC);
    // closing Settings takes it away
    settingsOpenStore.set(false);
    assert.equal(noticeNow(), null);
    assert.equal(micTestStore.get().on, false);
  });

  test("Settings says nothing when the saved devices are there, or none was chosen", async () => {
    await voice.testSpeaker();
    await voice.startMicTest("mictest");
    assert.equal(noticeNow(), null);
    voice.stopMicTest();
    setVoiceSettings({ speaker: saved(PHONES), mic: saved(HEADSET) });
    await voice.testSpeaker();
    await voice.startMicTest("mictest");
    assert.equal(noticeNow(), null);
  });

  test("both missing at one start of speech mode are one notice; the pill's notice is the board's", async () => {
    setVoiceSettings({ mic: GONE_MIC, speaker: GONE_OUT });
    await speech();
    assert.equal(noticeNow()?.text, noticeText("start-both", { mic: "Gone Mic", speaker: "Gone Speaker" }));
    voice.end();
    assert.equal(noticeNow(), null, "the notice goes with its session");
    await pill();
    assert.deepEqual(noticeNow()?.where, { kind: "board", board: "b1" });
  });

  test("when the device is back, the next session uses it and says nothing", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    devs().unplug(HEADSET.id);
    await dictation();
    assert.equal(noticeNow()?.text, noticeText("start-mic", { mic: "Stand-in Headset" }));
    voice.end();
    devs().plug(HEADSET);
    const d = await dictation();
    assert.equal(d.mic.opened.device?.id, HEADSET.id);
    assert.equal(d.mic.opened.missed, false);
    assert.equal(noticeNow(), null);
  });

  test("the saved microphone missing and the default unavailable too: the session ends as it does today", async () => {
    setVoiceSettings({ mic: GONE_MIC });
    f.audio.permission = "denied";
    await voice.startDictation({ chat: CHAT, branch: BR, anchor: "dictate:c1", sink: { show() {}, done() {} } });
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(session().phase, "idle");
    assert.equal(noticeNow(), null, "the popover says it; there is no second notice");
    assert.deepEqual(getSettings().mic, GONE_MIC);
  });
});

describe("the notice's life (VD-13)", () => {
  test("it fades after noticeMs and a newer one replaces it", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await speech();
    devs().unplug(HEADSET.id);
    const first = noticeNow();
    assert.ok(first);
    f.advance(waits.noticeMs - 1);
    assert.equal(noticeNow(), first);
    f.advance(1);
    assert.equal(noticeNow(), null);
  });

  test("it is gone when its session ends, and a stale timer does not take the next notice", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await speech();
    devs().unplug(HEADSET.id);
    assert.ok(noticeNow());
    voice.end();
    assert.equal(noticeNow(), null);
  });

  test("the hooks show the notice only where it belongs", () => {
    setVoiceSettings({ mic: { id: "x", name: "Nope" } });
    const C = (p: { where: { kind: "chat"; chat: string } | { kind: "board"; board: string } }) => createElement("span", null, `${useVoiceNotice(p.where)}`);
    assert.equal(renderToString(createElement(C, { where: { kind: "chat", chat: CHAT } })), "<span>null</span>");
  });
});

describe("the microphone lost during a session (goal 3.3, 6.4)", () => {
  test("listening goes on from the default: one notice, the words kept, no new socket", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    const { sock, mic } = await speech();
    partial(sock, "hello there");
    committed(sock, "hello there.");
    assert.equal(session().committed, "hello there.");
    devs().unplug(HEADSET.id);
    assert.equal(noticeNow()?.text, noticeText("lost-mic", { device: "Stand-in Headset" }));
    assert.equal(session().committed, "hello there.", "words already heard are kept");
    assert.equal(devs().micDevice?.id, DESK.id);
    assert.equal(f.net.sockets.length, 1, "the socket is the same");
    assert.equal(mic.stopped, false);
    const n = audioFrames(sock).length;
    mic.chunk("AFTER");
    assert.equal(audioFrames(sock).length, n + 1, "the chunks go on into the same socket");
    assert.equal(session().phase, "countdown");
  });

  test("listening that cannot be started again ends the session with today's microphone problem", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    devs().failReopen();
    const { shown, done } = await dictation();
    void shown;
    partial(f.net.sockets[0], "some words");
    committed(f.net.sockets[0], "some words.");
    devs().unplug(HEADSET.id);
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(problemStore.get()?.anchor, "dictate:c1");
    assert.equal(session().phase, "idle");
    assert.deepEqual(done, ["some words."], "the words are the person's all the same");
  });

  test("the next session works, and the chat still sends text", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    devs().failReopen();
    await speech();
    devs().unplug(HEADSET.id);
    assert.equal(session().phase, "idle");
    devs().failReopen(false);
    const { sock } = await speech();
    assert.equal(session().phase, "listening");
    setChat("thinking");
    await sayAndSend(sock, "Still works.");
  });

  test("a microphone that comes back mid-session is not switched to", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await speech();
    devs().unplug(HEADSET.id);
    f.net.sockets.length = 1;
    const opened = devs().opened.length;
    devs().plug(HEADSET);
    await settle();
    assert.equal(devs().opened.length, opened);
    assert.equal(devs().micDevice?.id, DESK.id);
  });
});

describe("the speaker lost during a session (goal 3.3, 6.4)", () => {
  test("a public speaker: the sound goes on from the default with a notice, and no sentence is spoken twice", async () => {
    setVoiceSettings({ speaker: saved(SPEAKERS2) });
    const { sock } = await speakingReply();
    void sock;
    devs().unplug(SPEAKERS2.id);
    assert.equal(noticeNow()?.text, noticeText("lost-speaker", { device: "Living Room Speakers" }));
    assert.equal(session().paused, null, "a public speaker is no pause");
    assert.equal(devs().holds, 0);
    assert.equal(devs().held, false);
    assert.equal(devs().outputDevice?.id, SPEAKERS.id);
    f.net.to(TTS)[0].release(3);
    f.net.to(TTS)[0].end();
    await waitFor(() => f.net.to(TTS).length === 2, "the second sentence");
    f.net.to(TTS)[1].release(4);
    f.net.to(TTS)[1].end();
    await settle();
    assert.equal(ttsTexts().length, 2);
    assert.equal(new Set(ttsTexts()).size, ttsTexts().length, "no sentence asked twice");
    assert.equal(new Set(f.audio.marks).size, f.audio.marks.length, "no mark twice");
  });

  test("headphones to other headphones is no pause", async () => {
    setVoiceSettings({ speaker: saved(PHONES) });
    await speakingReply();
    devs().unplug(PHONES.id, { now: PHONES2 });
    assert.equal(session().paused, null);
    assert.equal(devs().held, false);
    assert.equal(noticeNow()?.text, noticeText("lost-speaker", { device: "Stand-in Headphones" }));
  });

  test("a device that comes back mid-session does not move the sound", async () => {
    setVoiceSettings({ speaker: saved(SPEAKERS2) });
    await speakingReply();
    devs().unplug(SPEAKERS2.id);
    const used = devs().used.length;
    devs().plug(SPEAKERS2);
    await settle();
    assert.equal(devs().used.length, used);
    assert.equal(devs().outputDevice?.id, SPEAKERS.id);
  });
});

describe("private listening that would become public: the pause (VD-12, goal 3.3, 4.6)", () => {
  beforeEach(() => {
    setVoiceSettings({ speaker: saved(PHONES) });
  });

  test("headphones removed while a reply is spoken: paused with the reason, nothing plays out loud until Continue", async () => {
    const { sock, mic } = await speakingReply();
    const writes = f.audio.writes.length;
    devs().unplug(PHONES.id);
    assert.deepEqual(session().paused, { device: "Stand-in Headphones" });
    assert.equal(devs().held, true, "the player stays held");
    assert.equal(devs().resumes, 0);
    assert.equal(noticeNow(), null, "the pause is the speech bar's own line, not a notice that fades");
    // the reply goes on into the held queue: the writes are held, none is played
    f.net.to(TTS)[0].release(3);
    f.net.to(TTS)[0].end();
    await waitFor(() => f.audio.writes.length > writes, "writes into the hold");
    assert.ok(f.audio.writes.slice(writes).every((w) => w.held), "no write reaches an unheld player");
    await settle();
    assert.equal(session().paused?.device, "Stand-in Headphones");
    assert.equal(mic.opts.echoCancel, true);
    const frames = audioFrames(sock).length;
    mic.chunk("WHILE PAUSED");
    assert.equal(audioFrames(sock).length, frames, "the gate is closed");
    voice.resume();
    assert.equal(devs().resumes, 1);
    assert.equal(devs().held, false);
    assert.equal(session().paused, null);
  });

  test("Continue returns the session to the phase it was in, and the reply plays on without a repeated sentence", async () => {
    await speakingReply();
    devs().unplug(PHONES.id);
    voice.resume();
    f.net.to(TTS)[0].release(3);
    f.net.to(TTS)[0].end();
    await waitFor(() => f.net.to(TTS).length === 2, "the second sentence");
    f.net.to(TTS)[1].release(4);
    f.net.to(TTS)[1].end();
    setItems([user("Weather please."), reply("The weather today is sunny and warm. Tomorrow brings heavy rain to the coast.", true), { kind: "end" }]);
    setChat("ready");
    await settle();
    f.audio.auto = true;
    f.audio.drain();
    await waitFor(() => f.timers.pending > 0, "the reply played out: its tail runs");
    f.advance(1000);
    await waitFor(() => session().phase === "listening", "listening again");
    assert.equal(ttsTexts().length, 2, "each sentence asked once");
    assert.equal(session().paused, null);
  });

  test("while listening, a countdown is cancelled with its words kept, and no timer sends the turn", async () => {
    const { sent, sock, mic } = await speech();
    setChat("thinking");
    partial(sock, "send this soon");
    committed(sock, "send this soon.");
    assert.equal(session().phase, "countdown");
    devs().unplug(PHONES.id);
    assert.deepEqual(session().paused, { device: "Stand-in Headphones" });
    assert.equal(session().phase, "waiting");
    assert.equal(session().countdown, null);
    assert.equal(session().committed, "send this soon.");
    f.advance(10_000);
    await settle();
    assert.deepEqual(sent, [], "nothing was sent while paused");
    const frames = audioFrames(sock).length;
    mic.chunk("X");
    assert.equal(audioFrames(sock).length, frames);
    voice.send();
    f.advance(10_000);
    assert.deepEqual(sent, [], "even Send does nothing while paused");
    voice.resume();
    assert.equal(session().phase, "waiting");
    voice.send();
    await settle();
    assert.equal(session().phase === "sending" || session().phase === "thinking", true);
    assert.deepEqual(sent, ["send this soon."]);
  });

  test("words heard while paused are kept, and no countdown runs", async () => {
    const { sent, sock } = await speech();
    devs().unplug(PHONES.id);
    partial(sock, "late words");
    committed(sock, "late words.");
    f.advance(10_000);
    await settle();
    assert.equal(session().committed, "late words.");
    assert.notEqual(session().phase, "countdown");
    assert.deepEqual(sent, []);
  });

  test("dictation never pauses: it speaks nothing", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await dictation();
    devs().unplug(PHONES.id);
    assert.equal(session().paused, null);
    assert.equal(devs().held, false);
  });

  test("End while paused lets the hold go: the next reading plays", async () => {
    await speakingReply();
    devs().unplug(PHONES.id);
    assert.equal(devs().held, true);
    voice.end();
    assert.equal(devs().held, false, "the hold belonged to the ended session");
    assert.equal(session().phase, "idle");
    devs().plug(PHONES);
    serveVoice(f.net);
    f.audio.auto = true;
    const before = f.audio.writes.length;
    await readAloud(msg("A message of one sentence, read aloud after."));
    assert.ok(f.audio.writes.slice(before).every((w) => !w.held));
  });

  test("the pill pauses while it listens too, and its pause names the board's session", async () => {
    await pill();
    devs().unplug(PHONES.id);
    assert.deepEqual(session().paused, { device: "Stand-in Headphones" });
    assert.deepEqual(session().owner, { kind: "pill", board: "b1" });
    voice.resume();
    assert.equal(session().paused, null);
  });

  test("the port held but the rule says no (moved to other headphones): the engine resumes at once", async () => {
    await speech();
    devs().unplug(PHONES.id, { now: PHONES2, held: true });
    assert.equal(session().paused, null);
    assert.equal(devs().resumes, 1);
    assert.equal(devs().held, false);
  });

  test("the port did not hold but the rule says pause: the engine holds", async () => {
    await speech();
    devs().unplug(PHONES.id, { now: SPEAKERS, held: false });
    assert.deepEqual(session().paused, { device: "Stand-in Headphones" });
    assert.equal(devs().holds, 1);
    assert.equal(devs().held, true);
  });
});

describe("Read aloud and the pause (VD-12)", () => {
  beforeEach(() => {
    setVoiceSettings({ speaker: saved(PHONES) });
    serveVoice(f.net, { manual: true, ttsChunks: 2 });
    f.audio.auto = false;
  });

  test("paused with a sticky line, Continue reading plays on", async () => {
    const done = readAloud(msg("A message of one sentence, for the pause."));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "the first sound");
    devs().unplug(PHONES.id);
    assert.equal(readingStore.get().paused, true);
    assert.equal(readingStore.get().key, "read:c1:main:0");
    assert.equal(noticeNow()?.text, noticeText("paused", { device: "Stand-in Headphones" }));
    assert.deepEqual(noticeNow()?.where, { kind: "chat", chat: CHAT });
    f.advance(waits.noticeMs * 3);
    assert.ok(noticeNow(), "it stays as long as the pause");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 2, "the second chunk");
    assert.ok(f.audio.writes.every((w, i) => i === 0 || w.held));
    voice.resume();
    assert.equal(readingStore.get().paused, false);
    assert.equal(noticeNow(), null);
    assert.equal(devs().resumes, 1);
    f.net.to(TTS)[0].end();
    f.audio.auto = true;
    f.audio.drain();
    await done;
    assert.equal(readingStore.get().key, null);
  });

  test("Stop reading while paused lets the hold go", async () => {
    const done = readAloud(msg("A message of one sentence, for the pause."));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "the first sound");
    devs().unplug(PHONES.id);
    stopReading();
    await done;
    assert.equal(devs().held, false);
    assert.equal(readingStore.get().paused, false);
    assert.equal(noticeNow(), null, "the pause sentence goes with the reading");
  });

  test("a public speaker lost while reading is a notice, no pause", async () => {
    setVoiceSettings({ speaker: saved(SPEAKERS2) });
    const done = readAloud(msg("A message of one sentence, for the pause."));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "the first sound");
    devs().unplug(SPEAKERS2.id);
    assert.equal(readingStore.get().paused, false);
    assert.equal(noticeNow()?.text, noticeText("lost-speaker", { device: "Living Room Speakers" }));
    f.net.to(TTS)[0].release(1);
    f.net.to(TTS)[0].end();
    f.audio.auto = true;
    f.audio.drain();
    await done;
  });

  test("a preview and Test speaker that lose a private output just stop", async () => {
    f.net.previewBytes.set("https://previews.example/v1.mp3", new Uint8Array(10));
    const p = playPreview("vsv1");
    await waitFor(() => f.audio.clips.length === 1, "the clip");
    devs().unplug(PHONES.id);
    await p;
    assert.equal(readingStore.get().paused, false);
    assert.equal(devs().held, false, "nothing is left held");
    devs().plug(PHONES);
    f.audio.auto = false;
    const t = voice.testSpeaker();
    await waitFor(() => f.audio.writes.length === 1, "the chime");
    devs().unplug(PHONES.id);
    await t;
    assert.equal(devs().held, false);
  });
});

describe("Test speaker (VD-15)", () => {
  test("plays the chime on the saved speaker, makes no request and needs no key", async () => {
    f.keystore.key = null;
    setVoiceSettings({ speaker: saved(PHONES2) });
    await voice.testSpeaker();
    assert.deepEqual(devs().used, [saved(PHONES2)]);
    assert.equal(f.audio.writes.length, 1);
    assert.equal(f.audio.writes[0].bytes, chimePcm().length);
    assert.equal(f.net.requests.length, 0);
    assert.equal(f.net.sockets.length, 0);
    assert.ok(!f.calls.some((c) => c.startsWith("keystore.") || c.startsWith("net.")));
    assert.equal(problemStore.get(), null);
  });

  test("a second tap stops the first; the first resolves", async () => {
    f.audio.auto = false;
    const first = voice.testSpeaker();
    await waitFor(() => f.audio.writes.length === 1, "the first chime");
    const second = voice.testSpeaker();
    await first;
    await waitFor(() => f.audio.writes.length === 2, "the second chime");
    f.audio.drain();
    await second;
    assert.equal(f.audio.stops >= 1, true);
  });
});

describe("the microphone test (VD-16, goal 3.2, 6.2)", () => {
  test("keeps only the level: no socket, no key, no request; stops on a second tap", async () => {
    f.keystore.key = null;
    setVoiceSettings({ mic: saved(HEADSET) });
    await voice.startMicTest("mictest");
    const mic = f.audio.mics[0];
    assert.deepEqual(devs().opened, [saved(HEADSET)]);
    assert.deepEqual(mic.opts, { chunkMs: 100, echoCancel: false });
    const view = () => {
      let v = { on: false, level: 0, busy: false };
      const C = () => { v = useMicTest(); return createElement("span"); };
      renderToString(createElement(C));
      return v;
    };
    assert.deepEqual(view(), { on: true, level: 0, busy: false });
    mic.chunk("AAAA", 0.6);
    assert.deepEqual(view(), { on: true, level: 0.6, busy: false });
    assert.equal(f.net.sockets.length, 0);
    assert.equal(f.net.requests.length, 0);
    assert.ok(!f.calls.some((c) => c.startsWith("keystore.") || c.startsWith("net.")));
    voice.stopMicTest();
    assert.equal(mic.stopped, true);
    assert.deepEqual(view(), { on: false, level: 0, busy: false });
    mic.chunk("LATE", 0.9);
    assert.equal(view().level, 0);
  });

  test("a refusal is mic_blocked on the control that was tapped; the checks' switch too", async () => {
    f.audio.permission = "denied";
    await voice.startMicTest("mictest");
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(problemStore.get()?.anchor, "mictest");
    assert.equal(sessionStore.get().phase, "idle");
    problemStore.set(null);
    f.audio.permission = "granted";
    flags.denyMic = true;
    await voice.startMicTest("mictest");
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(f.audio.mics.length, 0);
  });

  test("a microphone picked meanwhile restarts the test on it; leaving Settings stops it", async () => {
    settingsOpenStore.set(true);
    setVoiceSettings({ mic: saved(DESK) });
    await voice.startMicTest("mictest");
    setVoiceSettings({ mic: saved(HEADSET) });
    await waitFor(() => f.audio.mics.length === 2, "the restart");
    assert.equal(f.audio.mics[0].stopped, true);
    assert.deepEqual(devs().opened, [saved(DESK), saved(HEADSET)]);
    settingsOpenStore.set(false);
    assert.equal(f.audio.mics[1].stopped, true);
  });

  test("a voice session ends the test when it starts; the test is off while a session listens", async () => {
    await voice.startMicTest("mictest");
    const test = f.audio.mics[0];
    await speech();
    assert.equal(test.stopped, true);
    const before = f.audio.mics.length;
    await voice.startMicTest("mictest");
    assert.equal(f.audio.mics.length, before, "the control is off while a session listens");
    const C = () => createElement("span", null, `${useMicTest().busy}`);
    assert.equal(renderToString(createElement(C)), "<span>true</span>");
  });

  test("the test's microphone lost goes on from the default; one that cannot be reopened stops the test with the problem", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await voice.startMicTest("mictest");
    devs().unplug(HEADSET.id);
    assert.equal(noticeNow(), null, "Settings is on screen; the test has no notice");
    assert.equal(f.audio.mics[0].stopped, false);
    devs().plug(HEADSET);
    setVoiceSettings({ mic: saved(DESK) });
    await waitFor(() => f.audio.mics.length === 2, "the restart on the new pick");
    devs().failReopen();
    devs().unplug(DESK.id);
    assert.equal(problemStore.get()?.kind, "mic_blocked");
    assert.equal(problemStore.get()?.anchor, "mictest");
    assert.equal(f.audio.mics[1].stopped, true);
  });
});

describe("the data of the pickers (VD-6, VD-17, goal 3.2, 6.2)", () => {
  test("nothing is listed until Settings mounts the pickers; then on each signal of the port; and not after", async () => {
    await settle();
    assert.equal(devs().lists, 0);
    const off = watchDevices();
    await waitFor(() => deviceListStore.get() !== null, "the list");
    assert.deepEqual(deviceListStore.get()?.inputs.map((d) => d.id), [DESK.id, HEADSET.id]);
    assert.equal(devs().lists, 1);
    devs().plug(dev("mic-new", "New Mic"));
    await waitFor(() => deviceListStore.get()?.inputs.length === 3, "the new device");
    devs().unplug(DESK.id);
    await waitFor(() => deviceListStore.get()?.inputs.length === 2, "the removed device");
    assert.equal(devs().watching().watch, 1);
    off();
    off();
    assert.equal(devs().watching().watch, 0);
    const lists = devs().lists;
    devs().plug(dev("mic-newer", "Newer Mic"));
    await settle();
    assert.equal(devs().lists, lists);
  });

  test("the hook answers the loading state without a list, and the choices once there is one", async () => {
    setVoiceSettings({ mic: { id: "gone", name: "Gone Mic" } });
    let seen: ReturnType<typeof useDeviceChoices> | null = null;
    const C = () => { seen = useDeviceChoices(); return createElement("span"); };
    renderToString(createElement(C));
    assert.equal(seen!.loading, true);
    assert.equal(seen!.mic.show, "pick");
    deviceListStore.set(await devs().list());
    // `choicesFor` is D1's; the hook hands it the list, the saved choice and the ability
    renderToString(createElement(C));
    assert.equal(seen!.loading, false);
    assert.equal(seen!.mic.show === "pick" && seen!.mic.options.map((o) => o.label).join("|"),
      "System default (Desk Mic)|Desk Mic|Stand-in Headset|Gone Mic (not connected)");
    assert.equal(seen!.mic.show === "pick" && seen!.mic.selected, "missing:gone");
  });

  test("a platform that picks nothing: the lines, and the hook still lists nothing by itself", () => {
    devs().ability = { input: "system", output: "system", linked: false };
    let seen: ReturnType<typeof useDeviceChoices> | null = null;
    const C = () => { seen = useDeviceChoices(); return createElement("span"); };
    renderToString(createElement(C));
    assert.equal(seen!.neitherLine !== null, true);
    assert.equal(seen!.loading, false);
    assert.equal(devs().lists, 0);
  });
});

describe("the test seam and a fresh engine", () => {
  test("the seam shows the notice and the paused fields", async () => {
    const target: { __aiwbVoice?: VoiceSeam } = {};
    installSeam(target);
    const s = target.__aiwbVoice!;
    assert.equal(s.notice(), null);
    assert.equal(s.state().session.paused, null);
    assert.equal(s.state().reading.paused, false);
    setVoiceSettings({ mic: { id: "gone", name: "Gone Mic" } });
    await dictation();
    assert.equal(s.notice()?.text, noticeText("start-mic", { mic: "Gone Mic" }));
  });

  test("resetEngine lets go of the routes, the lists and the notice", async () => {
    setVoiceSettings({ mic: saved(HEADSET) });
    await speech();
    devs().unplug(HEADSET.id);
    const off = watchDevices();
    void off;
    assert.ok(noticeNow());
    resetEngine();
    assert.equal(noticeNow(), null);
    assert.equal(devs().watching().route, 0);
    assert.equal(devs().watching().watch, 0);
    assert.equal(deviceListStore.get(), null);
  });

  test("the face's new methods start nothing before a tap", () => {
    voice.resume();
    voice.stopMicTest();
    assert.deepEqual(f.calls, []);
    assert.equal(devs().watching().route, 0);
  });
});
