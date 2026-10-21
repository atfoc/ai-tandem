// The engine of voice, part A (architecture VC-11, VC-12, VC-14, VC-32, §12), over fake ports: the stores, the one player, speaking,
// Read aloud, the key, the voices and the preview. No test here reaches the network, the microphone or a key's real store.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { setKv } from "@aiwb/core/state/ports.ts";
import { SETTINGS_KEY } from "../src/voice/logic/settings.ts";
import { VoiceProblemError, setVoicePorts, voicePorts } from "../src/voice/ports.ts";
import type { VoiceProblem } from "../src/voice/index.ts";
import {
  closeVoiceSettings, openVoiceSettings, setVoiceSettings, useReading, useVoiceProblem, useVoiceSettings, useVoiceSettingsOpen, voice,
} from "../src/voice/index.ts";
import { hasKey, playPreview, removeKey, setKey, testKey, voices } from "../src/voice/engine/keycheck.ts";
import { MAX_IN_FLIGHT, readAloud, speaker, stopReading } from "../src/voice/engine/speaker.ts";
import { player } from "../src/voice/engine/player.ts";
import {
  dismissProblem, flags, getSettings, problemStore, readingStore, resetEngine, settingsOpenStore, settingsStore, waits,
} from "../src/voice/engine/state.ts";
import { installSeam } from "../src/voice/engine/testseam.ts";
import type { VoiceSeam } from "../src/voice/engine/testseam.ts";
import {
  createFakePorts, deferred, ERR, pcm, serveVoice, settle, voicesJson, waitFor,
} from "./fixtures/voice/fakeports.ts";
import type { FakePorts } from "./fixtures/voice/fakeports.ts";

const KEY = "sk_test_RECOGNISABLE_KEY_0123456789";
const TTS = "/v1/text-to-speech/";

let f: FakePorts;
let kvMap: Map<string, string>;

beforeEach(() => {
  kvMap = new Map();
  setKv({
    get: (k) => kvMap.get(k) ?? null,
    set: (k, v) => { kvMap.set(k, v); },
    remove: (k) => { kvMap.delete(k); },
    keys: () => [...kvMap.keys()],
  });
  f = createFakePorts({ key: KEY });
  setVoicePorts(f.ports);
  resetEngine();
  setVoiceSettings({ voiceId: "vsv1", voiceName: "Voice 1" });
  f.calls.length = 0;
  serveVoice(f.net);
});

afterEach(() => {
  speaker.stopAll();
  resetEngine();
});

const msg = (text: string, index = 0) => ({ chat: "c1", branch: "main", index, text, anchor: `read:c1:main:${index}` });
const ttsTexts = () => f.net.to(TTS).map((q) => (q.req.json as { text: string }).text);
const problem = (): VoiceProblem | null => problemStore.get();
const FIVE = "One is the first sentence here. Two is the second sentence here. Three is the third sentence here. Four is the fourth one here. Five is the last sentence here.";

describe("a fresh engine", () => {
  test("makes no call at all until a method is called", async () => {
    // Everything a screen may do before a tap: read the stores, the hooks' values, the seam's state.
    getSettings();
    problemStore.get();
    readingStore.get();
    settingsOpenStore.get();
    player.stats();
    speaker.current();
    stopReading();
    speaker.stopAll();
    voice.dismissProblem();
    voice.stopReading();
    await settle();
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.keystore.log, []);
  });
});

describe("settings (one value for every place)", () => {
  test("a change is seen by every subscriber, kept in the kv port, clamped", () => {
    const seen: number[][] = [[], []];
    const offs = [0, 1].map((i) => settingsStore.subscribe(() => seen[i].push(getSettings().pauseMs)));
    setVoiceSettings({ pauseMs: 100 }); // clamped up to 600
    setVoiceSettings({ pauseMs: 2000, autoSend: false });
    setVoiceSettings({ pauseMs: 2000 }); // nothing changed: nobody is told
    assert.deepEqual(seen, [[600, 2000], [600, 2000]]);
    assert.equal(getSettings().autoSend, false);
    assert.deepEqual(JSON.parse(kvMap.get(SETTINGS_KEY)!), getSettings());
    offs.forEach((off) => off());
    setVoiceSettings({ pauseMs: 1000 });
    assert.deepEqual(seen, [[600, 2000], [600, 2000]]);
  });

  test("a fresh engine reads the stored value; text that does not parse is the defaults", () => {
    kvMap.set(SETTINGS_KEY, JSON.stringify({ speed: 1.2, autoSend: false, skipCode: false }));
    resetEngine();
    assert.equal(getSettings().speed, 1.2);
    assert.equal(getSettings().autoSend, false);
    assert.equal(getSettings().skipCode, false);
    kvMap.set(SETTINGS_KEY, "{not json");
    resetEngine();
    assert.equal(getSettings().autoSend, true);
    assert.equal(getSettings().voiceId, null);
  });

  test("the hooks show the stored value (the app's React reads the same store)", () => {
    setVoiceSettings({ speed: 0.8 });
    const C = () => createElement("span", null, String(useVoiceSettings((s) => s.speed)), "|", String(useReading().key), "|", String(useVoiceProblem()?.kind ?? "none"), "|", String(useVoiceSettingsOpen()));
    assert.match(renderToString(createElement(C)), /0\.8.*null.*none.*false/);
    problemStore.set({ kind: "offline", anchor: "x" });
    openVoiceSettings();
    assert.match(renderToString(createElement(C)), /0\.8.*null.*offline.*true/);
    closeVoiceSettings();
    assert.equal(settingsOpenStore.get(), false);
  });

  test("the key is in no setting and no kv entry", async () => {
    await voice.setKey(KEY);
    await voice.testKey();
    await readAloud(msg("Hello there, this is a message."));
    assert.deepEqual([...kvMap.keys()], [SETTINGS_KEY]);
    assert.ok(!JSON.stringify([...kvMap.values()]).includes(KEY));
  });
});

describe("Read aloud", () => {
  test("with no key: the popover, and no net call, no audio call", async () => {
    f.keystore.key = null;
    await readAloud(msg("Anything at all."));
    assert.equal(problem()?.kind, "no_key");
    assert.equal(problem()?.anchor, "read:c1:main:0");
    assert.deepEqual(f.calls, ["keystore.has"]);
    assert.equal(readingStore.get().key, null);
  });

  test("a store that fails is a missing key, not a crash", async () => {
    f.keystore.failHas = true;
    await readAloud(msg("Anything at all."));
    assert.equal(problem()?.kind, "no_key");
    assert.equal(f.net.requests.length, 0);
  });

  test("speaks each sentence as one request: the voice, the model, the format, nothing else", async () => {
    await readAloud(msg(FIVE));
    assert.equal(f.net.requests.length, 5);
    const first = f.net.requests[0];
    assert.equal(first.req.method, "POST");
    assert.equal(first.req.path, "/v1/text-to-speech/vsv1/stream");
    assert.deepEqual(first.req.query, { output_format: "pcm_24000" });
    assert.deepEqual(first.req.json, { text: "One is the first sentence here.", model_id: "eleven_flash_v2_5" });
    assert.equal(first.req.key, undefined);
    assert.deepEqual(ttsTexts(), [
      "One is the first sentence here.", "Two is the second sentence here.", "Three is the third sentence here.",
      "Four is the fourth one here.", "Five is the last sentence here.",
    ]);
    // 5 sentences x 4 chunks x 3200 bytes, a mark before each sentence's first chunk, in order
    assert.equal(f.audio.writes.length, 20);
    assert.equal(f.audio.marks.length, 5);
    const log = f.audio.playerLog;
    assert.deepEqual(log.slice(0, 6), [`mark:${f.audio.marks[0]}`, "write", "write", "write", "write", `mark:${f.audio.marks[1]}`]);
    assert.equal(readingStore.get().key, null);
    assert.equal(problem(), null);
  });

  test("the reading key is set while it plays and cleared after", async () => {
    serveVoice(f.net, { manual: true, ttsChunks: 2 });
    const done = readAloud(msg("A short message that is one sentence.", 3));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    assert.equal(readingStore.get().key, "read:c1:main:3");
    const q = f.net.to(TTS)[0];
    q.release(2);
    q.end();
    await done;
    assert.equal(readingStore.get().key, null);
  });

  test("playback starts before the service has finished the sentence", async () => {
    serveVoice(f.net, { manual: true, ttsChunks: 3 });
    const done = readAloud(msg("This sentence is long enough to be one request."));
    await waitFor(() => f.net.to(TTS).length === 1, "the request");
    const q = f.net.to(TTS)[0];
    q.release(1);
    await waitFor(() => f.audio.writes.length === 1, "the first write");
    assert.equal(q.finished, false, "the service has not ended the sentence");
    assert.equal(f.audio.marks.length, 1);
    assert.ok(f.audio.playerLog.indexOf("write") > f.audio.playerLog.indexOf(`mark:${f.audio.marks[0]}`));
    assert.equal(player.stats().firstWriteAt, f.ports.now());
    q.release(2);
    q.end();
    await done;
    assert.equal(f.audio.writes.length, 3);
  });

  test("at most two requests are in flight, and the third starts when one is written out", async () => {
    serveVoice(f.net, { manual: true, ttsChunks: 1 });
    const done = readAloud(msg(FIVE));
    await waitFor(() => f.net.to(TTS).length === 2, "two requests");
    await settle(10);
    assert.equal(f.net.to(TTS).length, MAX_IN_FLIGHT, "no third request while two are open");
    const [a, b] = f.net.to(TTS);
    a.release(1);
    a.end();
    await waitFor(() => f.net.to(TTS).length === 3, "the third request");
    // the second finishes first: it is buffered, not played, until the first is out; the fourth still waits for room
    b.release(1);
    b.end();
    await settle(10);
    assert.ok(f.net.maxInflight <= 2);
    for (let i = 2; i < 5; i++) {
      await waitFor(() => f.net.to(TTS).length > i, `request ${i}`);
      const q = f.net.to(TTS)[i];
      q.release(1);
      q.end();
    }
    await done;
    assert.ok(f.net.maxInflight <= 2, `most in flight was ${f.net.maxInflight}`);
    assert.equal(f.net.requests.filter((q) => q.req.path.startsWith(TTS)).length, 5);
  });

  test("sentences are written in their order, whichever request finishes first", async () => {
    f.net.on((r) => r.path.startsWith(TTS), (_r, n) => ({ manual: true, chunks: [pcm(3200, 100 + n)] }));
    const done = readAloud(msg("The first sentence is this one. The second sentence is this other one."));
    await waitFor(() => f.net.to(TTS).length === 2, "two requests");
    const [a, b] = f.net.to(TTS);
    b.release(1);
    b.end();
    await settle(10);
    assert.equal(f.audio.writes.length, 0, "the second sentence waits for the first");
    a.release(1);
    a.end();
    await done;
    assert.equal(f.audio.writes.length, 2);
    assert.equal(f.audio.writes[0].data[0], 100 + a.n);
    assert.equal(f.audio.writes[1].data[0], 100 + b.n);
    assert.deepEqual(f.audio.playerLog.filter((x) => x.startsWith("mark")), f.audio.marks.map((id) => `mark:${id}`));
  });

  test("a second readAloud stops the first and aborts its open requests", async () => {
    f.audio.auto = false; // what was written is still queued in the player when the second reading begins
    serveVoice(f.net, { manual: true, ttsChunks: 3 });
    const first = readAloud(msg(FIVE, 0));
    await waitFor(() => f.net.to(TTS).length === 2, "two requests");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "audio");
    const open = f.net.to(TTS).slice();
    const second = readAloud(msg("Another message, read next, as a single sentence.", 1));
    await first;
    assert.ok(open.every((q) => q.aborted), "every request of the first reading is aborted");
    assert.equal(f.audio.stops, 1);
    assert.equal(readingStore.get().key, "read:c1:main:1");
    await waitFor(() => f.net.to(TTS).length === 3, "the second reading's request");
    const q = f.net.to(TTS)[2];
    assert.equal((q.req.json as { text: string }).text, "Another message, read next, as a single sentence.");
    q.release(3);
    q.end();
    await waitFor(() => f.audio.writes.length === 4, "the second reading's audio");
    f.audio.drain();
    await second;
    // nothing of the first one was written after the stop
    const afterStop = f.audio.playerLog.slice(f.audio.playerLog.indexOf("stop") + 1).filter((x) => x === "write").length;
    assert.equal(afterStop, 3);
    assert.equal(readingStore.get().key, null);
    assert.equal(speaker.current(), null);
  });

  test("stopReading stops the sound, clears the queue and aborts what is open", async () => {
    f.audio.auto = false;
    serveVoice(f.net, { manual: true, ttsChunks: 3 });
    const done = readAloud(msg(FIVE));
    await waitFor(() => f.net.to(TTS).length === 2, "two requests");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "audio");
    stopReading();
    await done;
    assert.ok(f.net.to(TTS).every((q) => q.aborted));
    assert.equal(f.audio.stops, 1);
    assert.equal(readingStore.get().key, null);
    await settle(10);
    assert.equal(f.net.to(TTS).length, 2, "no request is made after the stop");
    assert.equal(f.net.inflight, 0);
  });

  test("stopReading with nothing read does nothing", () => {
    stopReading();
    voice.stopReading();
    assert.deepEqual(f.calls, []);
  });

  test("a message with nothing to say makes no request", async () => {
    await readAloud(msg("```js\nconst a = 1;\n```"));
    assert.equal(f.net.requests.length, 0);
    assert.equal(readingStore.get().key, null);
    assert.equal(problem(), null);
  });

  test("code is skipped by default and read when the setting is off", async () => {
    const text = "Run this first.\n\n```sh\nnpm test\n```\n\nThen look at the result.";
    await readAloud(msg(text));
    assert.ok(!ttsTexts().join(" ").includes("npm test"));
    f.net.requests.length = 0;
    setVoiceSettings({ skipCode: false });
    await readAloud(msg(text));
    assert.ok(ttsTexts().join(" ").includes("npm test"));
  });

  test("the speed goes to the service only when it is not 1.0, and the model and language with it", async () => {
    await readAloud(msg("A plain message with one sentence in it."));
    assert.equal((f.net.requests.at(-1)!.req.json as Record<string, unknown>).voice_settings, undefined);
    setVoiceSettings({ speed: 1.2, ttsModel: "eleven_multilingual_v2", language: "de" });
    await readAloud(msg("A plain message with one sentence in it."));
    assert.deepEqual(f.net.requests.at(-1)!.req.json, {
      text: "A plain message with one sentence in it.", model_id: "eleven_multilingual_v2", voice_settings: { speed: 1.2 },
    });
    setVoiceSettings({ ttsModel: "eleven_flash_v2_5" });
    await readAloud(msg("A plain message with one sentence in it."));
    assert.equal((f.net.requests.at(-1)!.req.json as Record<string, unknown>).language_code, "de");
  });

  test("odd chunk sizes reach the player as whole samples, none lost", async () => {
    f.net.on((r) => r.path.startsWith(TTS), { chunks: [pcm(3201), pcm(3199), pcm(1), pcm(7)] });
    await readAloud(msg("A message of one sentence, with odd chunks."));
    assert.ok(f.audio.writes.every((w) => w.bytes % 2 === 0));
    assert.equal(f.audio.writes.reduce((n, w) => n + w.bytes, 0), 3201 + 3199 + 1 + 7 - 0);
  });

  test("a gap between sentences (the player drains) does not end the reading early", async () => {
    serveVoice(f.net, { paceMs: 15, ttsChunks: 2 });
    const h = speaker.begin({ key: "k", owner: "speech", anchor: "a" });
    h.say("The first sentence is here.");
    await waitFor(() => f.audio.writes.length >= 1, "audio");
    await new Promise((r) => setTimeout(r, 60)); // the first plays out; the player is drained
    h.say("The second sentence comes late.");
    h.end();
    assert.equal(await h.done, "played");
    assert.equal(f.net.to(TTS).length, 2);
    assert.equal(f.audio.writes.length, 4);
  });

  test("the sentence being played is told when its mark is reached, and the level is passed on", async () => {
    serveVoice(f.net, { ttsChunks: 1 });
    f.audio.auto = false;
    const said: string[] = [];
    const levels: number[] = [];
    const h = speaker.begin({ key: "k", owner: "speech", anchor: "a", onSentence: (s) => said.push(s), onLevel: (l) => levels.push(l) });
    h.say("Sentence number one is here.");
    h.say("Sentence number two is here.");
    h.end();
    await waitFor(() => f.audio.marks.length === 2, "both marks");
    assert.deepEqual(said, []);
    f.audio.reach(f.audio.marks[0]);
    f.audio.level(0.4);
    assert.deepEqual(said, ["Sentence number one is here."]);
    f.audio.reach(f.audio.marks[1]);
    assert.deepEqual(said, ["Sentence number one is here.", "Sentence number two is here."]);
    assert.deepEqual(levels, [0.4]);
    f.audio.drain();
    assert.equal(await h.done, "played");
  });

  test("a begin stops the utterance before it", async () => {
    serveVoice(f.net, { manual: true, ttsChunks: 1 });
    const a = speaker.begin({ key: "a", owner: "read", anchor: "a" });
    a.say("The first utterance has one sentence.");
    await waitFor(() => f.net.to(TTS).length === 1, "request");
    const b = speaker.begin({ key: "b", owner: "speech", anchor: "b" });
    assert.equal(await a.done, "stopped");
    assert.equal(speaker.current()?.key, "b");
    assert.ok(f.net.to(TTS)[0].aborted);
    a.say("Ignored after the stop, since it is over.");
    b.end();
    assert.equal(await b.done, "played");
    assert.equal(f.net.to(TTS).length, 1);
  });

  test("the voice is chosen at first use: the first voice of the service, kept", async () => {
    setVoiceSettings({ voiceId: null, voiceName: "" });
    await readAloud(msg(FIVE));
    const lookups = f.net.to("/v2/voices");
    assert.equal(lookups.length, 1, "one lookup for the whole reading");
    assert.deepEqual(lookups[0].req.query, { page_size: "1", sort: "name" });
    assert.equal(getSettings().voiceId, "vsv1");
    assert.equal(getSettings().voiceName, "Voice 1");
    assert.ok(f.net.to(TTS).every((q) => q.req.path === "/v1/text-to-speech/vsv1/stream"));
    assert.equal(JSON.parse(kvMap.get(SETTINGS_KEY)!).voiceId, "vsv1");
    await readAloud(msg("Another one, with one sentence in it.", 1));
    assert.equal(f.net.to("/v2/voices").length, 1, "the next reading does not ask again");
  });

  test("the fixtures of the splitter are what is asked of the service", async () => {
    const names = readdirSync(new URL("./fixtures/voice/", import.meta.url)).filter((x) => x.endsWith(".md")).map((x) => x.slice(0, -3));
    assert.ok(names.length >= 8);
    for (const name of names) {
      const md = readFileSync(new URL(`./fixtures/voice/${name}.md`, import.meta.url), "utf8");
      const want = JSON.parse(readFileSync(new URL(`./fixtures/voice/${name}.json`, import.meta.url), "utf8")) as { sentences: string[] };
      f.net.requests.length = 0;
      await readAloud(msg(md));
      assert.deepEqual(ttsTexts(), want.sentences, name);
    }
  });
});

describe("problems", () => {
  const cases: [string, Parameters<FakePorts["net"]["on"]>[1], string][] = [
    ["401 is key_rejected", ERR.rejected, "key_rejected"],
    ["a legacy 401 quota is no_credits", ERR.quotaLegacy, "no_credits"],
    ["402 is no_credits", ERR.credits, "no_credits"],
    ["429 is no_credits", ERR.rate, "no_credits"],
    ["503 is offline", ERR.server, "offline"],
    ["a missing network is offline", { reject: "net" }, "offline"],
    ["a refusal the service words oddly is service", { status: 422, text: "{}" }, "service"],
    ["a problem a port names stays that one", { reject: new VoiceProblemError("key_rejected") }, "key_rejected"],
  ];
  for (const [name, reply, kind] of cases) {
    test(name, async () => {
      f.net.on((r) => r.path.startsWith(TTS), reply);
      await readAloud(msg(FIVE));
      assert.equal(problem()?.kind, kind);
      assert.equal(problem()?.anchor, "read:c1:main:0");
      assert.equal(readingStore.get().key, null);
      assert.equal(f.net.inflight, 0, "everything open is aborted");
      assert.ok(f.net.requests.length <= MAX_IN_FLIGHT);
      assert.ok(!JSON.stringify(problem()).includes(KEY));
    });
  }

  test("a stream that is cut stops the reading with a problem and keeps what was played", async () => {
    f.net.on((r) => r.path.startsWith(TTS), { chunks: 4, cutAfter: 2 });
    await readAloud(msg(FIVE));
    assert.equal(problem()?.kind, "offline");
    assert.equal(f.audio.stops, 1);
    assert.equal(f.net.inflight, 0);
  });

  test("a request that does not answer is 'can't reach' after the wait", async () => {
    waits.answerMs = 30;
    f.net.on((r) => r.path.startsWith(TTS), { hold: true });
    await readAloud(msg("A message of one sentence, that is never answered."));
    assert.equal(problem()?.kind, "offline");
    assert.equal(f.net.inflight, 0);
  });

  test("Try again reads the message again; Not now dismisses", async () => {
    let n = 0;
    f.net.on((r) => r.path.startsWith(TTS), () => (n++ === 0 ? { reject: "net" } : { chunks: 2 }));
    await readAloud(msg("A message of one sentence, read twice."));
    const p = problem()!;
    assert.equal(p.kind, "offline");
    p.retry!();
    await waitFor(() => problem() === null && f.audio.writes.length === 2, "the second reading");
    voice.dismissProblem();
    assert.equal(problem(), null);
  });

  test("a new reading takes the old problem away", async () => {
    problemStore.set({ kind: "offline", anchor: "old" });
    await readAloud(msg("A message of one sentence, read after a problem."));
    assert.equal(problem(), null);
  });

  test("no key shows no_key without a retry, Open Settings is the screen's", async () => {
    f.keystore.key = null;
    await readAloud(msg("Anything at all."));
    assert.equal(problem()?.retry, undefined);
    dismissProblem();
    assert.equal(problem(), null);
  });
});

describe("the key", () => {
  test("hasKey, setKey, removeKey go to the keystore and nowhere else", async () => {
    f.keystore.key = null;
    assert.equal(await hasKey(), false);
    await setKey("  " + KEY + "\n");
    assert.equal(f.keystore.key, KEY, "kept without the spaces around it");
    assert.equal(await voice.hasKey(), true);
    await removeKey();
    assert.equal(f.keystore.key, null);
    assert.equal(await hasKey(), false);
    assert.equal(f.net.requests.length, 0);
    assert.deepEqual(f.calls.filter((c) => !c.startsWith("keystore.")), []);
    assert.ok(!f.calls.join("\n").includes(KEY));
  });

  test("an empty key is not kept", async () => {
    f.keystore.key = null;
    await setKey("   ");
    assert.equal(f.keystore.key, null);
    assert.deepEqual(f.calls, []);
  });

  test("saving a key takes away a popover that blamed the old one", async () => {
    problemStore.set({ kind: "key_rejected", anchor: "x" });
    await setKey(KEY);
    assert.equal(problem(), null);
    problemStore.set({ kind: "offline", anchor: "x" });
    await setKey(KEY);
    assert.equal(problem()?.kind, "offline");
  });

  test("Test key: a working key says how many voices", async () => {
    f.net.on((r) => r.path === "/v2/voices", { json: voicesJson(1, { total: 42 }) });
    assert.deepEqual(await testKey(), { ok: true, voices: 42 });
    const q = f.net.requests[0];
    assert.deepEqual(q.req.query, { page_size: "1", include_total_count: "true" });
    assert.equal(q.req.key, undefined, "the stored key is the port's to read");
    assert.equal(problem(), null, "a result is not a popover");
  });

  test("Test key: a typed key is the one tested, and it is not stored", async () => {
    f.keystore.key = null;
    f.net.on((r) => r.path === "/v2/voices", { json: voicesJson(2) });
    assert.deepEqual(await testKey("  sk_test_typed "), { ok: true, voices: 2 });
    assert.equal(f.net.requests[0].req.key, "sk_test_typed");
    assert.equal(f.keystore.key, null);
    assert.ok(!f.calls.join("\n").includes("sk_test_typed"));
  });

  test("Test key: no key at all is no_key, with no request", async () => {
    f.keystore.key = null;
    assert.deepEqual(await testKey(), { ok: false, problem: "no_key" });
    assert.equal(f.net.requests.length, 0);
  });

  test("Test key: a rejected key, no credits, a missing network, a timeout", async () => {
    f.net.on((r) => r.path === "/v2/voices", ERR.rejected);
    assert.deepEqual(await testKey(), { ok: false, problem: "key_rejected" });
    f.net.on((r) => r.path === "/v2/voices", ERR.credits);
    assert.deepEqual(await testKey(), { ok: false, problem: "no_credits" });
    f.net.on((r) => r.path === "/v2/voices", { reject: "net" });
    assert.deepEqual(await testKey(), { ok: false, problem: "offline" });
    waits.callMs = 30;
    f.net.on((r) => r.path === "/v2/voices", { hold: true });
    assert.deepEqual(await testKey(), { ok: false, problem: "offline" });
    f.net.on((r) => r.path === "/v2/voices", { text: "<html>" });
    assert.deepEqual(await testKey(), { ok: false, problem: "service" });
    assert.equal(f.net.inflight, 0);
  });
});

describe("the voices and the preview", () => {
  test("the short list is four, the full list pages by cursor and search", async () => {
    f.net.on((r) => r.path === "/v2/voices", (r) => ({ json: voicesJson(Number(r.query?.page_size ?? 1), { total: 40, hasMore: true }) }));
    const short = await voice.voices();
    assert.equal(short.voices.length, 4);
    assert.equal(short.total, 40);
    assert.equal(short.cursor, "next");
    assert.deepEqual(short.voices[0], { id: "vsv1", name: "Voice 1", about: "About voice 1", previewUrl: "https://previews.example/v1.mp3" });
    assert.deepEqual(f.net.requests[0].req.query, { page_size: "4", sort: "name", include_total_count: "true" });
    await voices({ all: true, search: "  calm ", cursor: "next" });
    assert.deepEqual(f.net.requests[1].req.query, { page_size: "30", sort: "name", include_total_count: "true", search: "calm", next_page_token: "next" });
  });

  test("with no key it rejects as no_key; a failure is the problem it is", async () => {
    f.keystore.key = null;
    await assert.rejects(voices(), (e) => e instanceof VoiceProblemError && e.kind === "no_key");
    assert.equal(f.net.requests.length, 0);
    f.keystore.key = KEY;
    f.net.on((r) => r.path === "/v2/voices", ERR.rejected);
    await assert.rejects(voices(), (e) => e instanceof VoiceProblemError && e.kind === "key_rejected");
    f.net.on((r) => r.path === "/v2/voices", { reject: "net" });
    await assert.rejects(voices(), (e) => e instanceof VoiceProblemError && e.kind === "offline");
    assert.equal(problem(), null, "the Settings page words it, not the popover");
  });

  test("a preview plays the clip of the voice, costs no speech request", async () => {
    f.net.previewBytes.set("https://previews.example/v2.mp3", pcm(100));
    f.audio.clipMs = 1;
    await voices();
    await playPreview("vsv2");
    assert.deepEqual(f.net.previewsAsked, ["https://previews.example/v2.mp3"]);
    assert.equal(f.audio.clips.length, 1);
    assert.equal(f.audio.clips[0].length, 100);
    assert.equal(f.net.to(TTS).length, 0);
    assert.equal(problem(), null);
  });

  test("a preview of a voice not seen asks the list first", async () => {
    f.net.previewBytes.set("https://previews.example/v1.mp3", pcm(10));
    f.audio.clipMs = 1;
    await playPreview("vsv1");
    assert.equal(f.net.to("/v2/voices").length, 1);
    assert.equal(f.audio.clips.length, 1);
    await playPreview("vsv1");
    assert.equal(f.net.to("/v2/voices").length, 1, "the address is remembered");
    await playPreview("nosuchvoice");
    assert.equal(f.audio.clips.length, 2, "a voice without a clip plays nothing");
  });

  test("a preview stops a reading, and a reading stops the preview", async () => {
    serveVoice(f.net, { manual: true, ttsChunks: 2 });
    f.net.previewBytes.set("https://previews.example/v1.mp3", pcm(10));
    await voices();
    const reading = readAloud(msg(FIVE));
    await waitFor(() => f.net.to(TTS).length === 2, "requests");
    f.net.to(TTS)[0].release(1);
    await waitFor(() => f.audio.writes.length === 1, "audio");
    const preview = playPreview("vsv1");
    await reading;
    assert.ok(f.net.to(TTS).every((q) => q.aborted));
    await waitFor(() => f.audio.clips.length === 1, "the clip");
    // now the reading takes the output again: the clip's signal is aborted and playPreview ends
    const again = readAloud(msg("A new message, read while the clip plays.", 1));
    await preview;
    await waitFor(() => f.net.to(TTS).length === 3, "the new request");
    f.net.to(TTS)[2].release(2);
    f.net.to(TTS)[2].end();
    await again;
  });

  test("a preview that cannot be fetched shows the popover on its control", async () => {
    await voices();
    await playPreview("vsv3"); // no bytes for its url: the fake fails like a missing network
    assert.equal(problem()?.kind, "offline");
    assert.equal(problem()?.anchor, "preview:vsv3");
    assert.equal(f.audio.clips.length, 0);
  });
});

describe("the test seam", () => {
  test("shows the state, the settings and the player's counts; denies the microphone; sets and clears the key", async () => {
    const target: { __aiwbVoice?: VoiceSeam } = {};
    installSeam(target);
    const s = target.__aiwbVoice!;
    await readAloud(msg("A message of one sentence, for the counts."));
    assert.equal(s.player().writes, 4);
    assert.equal(s.player().marks, 1);
    assert.equal(s.player().bytes, 4 * 3200);
    assert.equal(s.player().firstWriteAt, f.ports.now());
    assert.equal(s.state().session.phase, "idle");
    assert.equal(s.state().reading.key, null);
    assert.equal(s.settings().voiceId, "vsv1");
    s.denyMic(true);
    assert.equal(flags.denyMic, true);
    await s.setKey("sk_test_other");
    assert.equal(f.keystore.key, "sk_test_other");
    await s.clearKey();
    assert.equal(f.keystore.key, null);
  });
});

describe("the face", () => {
  test("without a session, listening's methods start nothing (listening itself: voice.session.test.ts)", async () => {
    voice.end();
    voice.mute(true);
    voice.send();
    voice.cancelCountdown();
    voice.interrupt();
    assert.deepEqual(f.calls, []);
  });

  test("the methods of this package are the engine's", async () => {
    assert.deepEqual(await voice.testKey(), { ok: true, voices: 6 });
    const done = deferred();
    voice.readAloud(msg("A message of one sentence, through the face.")).then(done.resolve);
    await done.promise;
    assert.equal(f.audio.writes.length, 4);
  });
});
