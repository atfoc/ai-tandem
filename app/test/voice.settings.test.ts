// The voice settings (VC-14): defaults, reading of the stored text, clamping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULTS, PAUSE_MAX_MS, PAUSE_MIN_MS, SPEEDS, clampSettings, parseSettings, sameSettings, stringifySettings } from "../src/voice/logic/settings.ts";
import type { VoiceSettings } from "../src/voice/logic/settings.ts";
import type { VoiceSettings as ShownSettings } from "../src/voice/index.ts";

// The same type as the one index.ts writes out until P10 re-exports this one: each is assignable to the other.
const same = (a: VoiceSettings): ShownSettings => a;
const back = (a: ShownSettings): VoiceSettings => a;

describe("defaults", () => {
  it("are the ones of the goal: Auto-send, Flash, Scribe, auto language, 1.2 s, 1.0x, skip code", () => {
    assert.deepEqual(DEFAULTS, {
      autoSend: true, voiceId: null, voiceName: "", ttsModel: "eleven_flash_v2_5", sttModel: "scribe_v2_realtime", language: null,
      pauseMs: 1200, speed: 1, skipCode: true, mic: null, speaker: null,
    });
    assert.deepEqual(same(DEFAULTS), back(DEFAULTS));
  });
  it("hold no key", () => {
    assert.equal(Object.keys(DEFAULTS).some((k) => /key|secret|token/i.test(k)), false);
  });
});

describe("parseSettings", () => {
  it("nothing stored, text that is not JSON and JSON that is not an object are the defaults", () => {
    for (const t of [null, "", "{", "null", "3", "[]", '"x"']) assert.deepEqual(parseSettings(t), DEFAULTS);
  });
  it("returns a copy, not the defaults themselves", () => {
    const s = parseSettings(null);
    assert.notEqual(s, DEFAULTS);
    s.speed = 1.2;
    assert.equal(DEFAULTS.speed, 1);
  });
  it("reads a stored value back", () => {
    const s: VoiceSettings = {
      autoSend: false, voiceId: "Abc123", voiceName: "Alice", ttsModel: "eleven_multilingual_v2", sttModel: "scribe_v2_realtime",
      language: "sr", pauseMs: 2000, speed: 1.1, skipCode: false, mic: null, speaker: null,
    };
    assert.deepEqual(parseSettings(JSON.stringify(s)), s);
    assert.deepEqual(parseSettings(stringifySettings(s)), s);
  });
  it("keeps what is valid and defaults only the field that is not", () => {
    const s = parseSettings(JSON.stringify({ autoSend: false, speed: "fast", ttsModel: "eleven_v9", skipCode: 1, extra: true, apiKey: "sk_x" }));
    assert.deepEqual(s, { ...DEFAULTS, autoSend: false });
    assert.equal("extra" in s || "apiKey" in s, false);
  });
});

describe("clampSettings", () => {
  it("brings the pause into 0.6 to 3.0 s", () => {
    assert.equal(clampSettings({ pauseMs: 100 }).pauseMs, PAUSE_MIN_MS);
    assert.equal(clampSettings({ pauseMs: 99999 }).pauseMs, PAUSE_MAX_MS);
    assert.equal(clampSettings({ pauseMs: 1500.4 }).pauseMs, 1500);
    assert.equal(clampSettings({ pauseMs: NaN }).pauseMs, 1200);
    assert.equal(clampSettings({ pauseMs: Infinity }).pauseMs, 1200);
  });
  it("snaps the speed to one of 0.8 to 1.2", () => {
    assert.deepEqual([...SPEEDS], [0.8, 0.9, 1, 1.1, 1.2]);
    assert.equal(clampSettings({ speed: 0.1 }).speed, 0.8);
    assert.equal(clampSettings({ speed: 5 }).speed, 1.2);
    assert.equal(clampSettings({ speed: 1.04 }).speed, 1);
    assert.equal(clampSettings({ speed: 1.06 }).speed, 1.1);
    assert.equal(clampSettings({ speed: NaN }).speed, 1);
  });
  it("accepts only the models the app offers", () => {
    assert.equal(clampSettings({ ttsModel: "eleven_turbo_v2_5" }).ttsModel, "eleven_flash_v2_5");
    assert.equal(clampSettings({ ttsModel: "eleven_multilingual_v2" }).ttsModel, "eleven_multilingual_v2");
    assert.equal(clampSettings({ ttsModel: "eleven_v4_turbo" }).ttsModel, "eleven_v4_turbo");
    for (const m of ["eleven_v3", "eleven_v4", "eleven_turbo_v2", 4]) assert.equal(clampSettings({ ttsModel: m }).ttsModel, "eleven_flash_v2_5");
    assert.equal(clampSettings({ sttModel: "scribe_v1" }).sttModel, "scribe_v2_realtime");
  });
  it("takes a language as a lower-case code or auto-detect", () => {
    assert.equal(clampSettings({ language: " DE " }).language, "de");
    assert.equal(clampSettings({ language: "deu" }).language, "deu");
    for (const l of ["", "english", "d", "d3", null, 4]) assert.equal(clampSettings({ language: l }).language, null);
  });
  it("takes a voice id the desktop's main would take, and no other", () => {
    assert.equal(clampSettings({ voiceId: "21m00Tcm4TlvDq8ikWAM" }).voiceId, "21m00Tcm4TlvDq8ikWAM");
    for (const v of ["", "a/b", "a b", "x".repeat(65), "../x", 5, null]) assert.equal(clampSettings({ voiceId: v }).voiceId, null);
  });
  it("bounds the voice name", () => {
    assert.equal(clampSettings({ voiceName: "x".repeat(500) }).voiceName.length, 200);
    assert.equal(clampSettings({ voiceName: 3 }).voiceName, "");
  });
  it("clamping twice is clamping once; nothing and null are the defaults", () => {
    const once = clampSettings({ pauseMs: 50, speed: 3, language: "EN" });
    assert.deepEqual(clampSettings(once), once);
    assert.deepEqual(clampSettings({}), DEFAULTS);
    assert.deepEqual(clampSettings(null), DEFAULTS);
    assert.deepEqual(clampSettings(undefined), DEFAULTS);
  });
});

describe("the saved microphone and speaker (voice-devices VD-3)", () => {
  it("are System default (null) when nothing is stored, and a stored value without the fields reads as null: no migration", () => {
    assert.equal(DEFAULTS.mic, null);
    assert.equal(DEFAULTS.speaker, null);
    const old = parseSettings(JSON.stringify({ autoSend: false, speed: 1.1 }));
    assert.equal(old.mic, null);
    assert.equal(old.speaker, null);
    assert.equal(old.autoSend, false);
  });
  it("keep a device as {id, name}, trimmed, and read it back", () => {
    const s = clampSettings({ mic: { id: " a1 ", name: "  Desk Mic " }, speaker: { id: "o:2", name: "" } });
    assert.deepEqual(s.mic, { id: "a1", name: "Desk Mic" });
    assert.deepEqual(s.speaker, { id: "o:2", name: "" });
    assert.deepEqual(parseSettings(stringifySettings(s)), s);
  });
  it("drop what is not {id: 1..512, name: 0..200 characters}: that field is null and nothing else changes", () => {
    for (const bad of [
      "x", 3, [], {}, { id: "a" }, { name: "n" }, { id: "", name: "n" }, { id: "   ", name: "n" }, { id: 4, name: "n" }, { id: "a", name: 4 },
      { id: "x".repeat(513), name: "n" }, { id: "a", name: "n".repeat(201) },
    ]) {
      const s = clampSettings({ autoSend: false, mic: bad, speaker: bad });
      assert.equal(s.mic, null, JSON.stringify(bad));
      assert.equal(s.speaker, null, JSON.stringify(bad));
      assert.equal(s.autoSend, false);
    }
    assert.deepEqual(clampSettings({ mic: { id: "x".repeat(512), name: "n".repeat(200) } }).mic, { id: "x".repeat(512), name: "n".repeat(200) });
  });
  it("hold nothing but the id and the name of a device", () => {
    const s = clampSettings({ mic: { id: "a", name: "n", privacy: "private", builtIn: true } });
    assert.deepEqual(s.mic, { id: "a", name: "n" });
  });
  it("sameSettings compares a device by its id and name, not by identity", () => {
    const a = clampSettings({ mic: { id: "a", name: "n" } });
    const b = clampSettings({ mic: { id: "a", name: "n" } });
    assert.notEqual(a.mic, b.mic);
    assert.equal(sameSettings(a, b), true);
    assert.equal(sameSettings(a, { ...b, mic: { id: "a", name: "other" } }), false);
    assert.equal(sameSettings(a, { ...b, mic: null }), false);
    assert.equal(sameSettings(DEFAULTS, { ...DEFAULTS }), true);
    assert.equal(sameSettings(a, { ...b, speed: 1.2 }), false);
  });
});
