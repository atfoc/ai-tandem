// The voice settings (VC-14): defaults, reading of the stored text, clamping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULTS, PAUSE_MAX_MS, PAUSE_MIN_MS, SPEEDS, clampSettings, parseSettings, stringifySettings } from "../src/voice/logic/settings.ts";
import type { VoiceSettings } from "../src/voice/logic/settings.ts";
import type { VoiceSettings as ShownSettings } from "../src/voice/index.ts";

// The same type as the one index.ts writes out until P10 re-exports this one: each is assignable to the other.
const same = (a: VoiceSettings): ShownSettings => a;
const back = (a: ShownSettings): VoiceSettings => a;

describe("defaults", () => {
  it("are the ones of the goal: Auto-send, Flash, Scribe, auto language, 1.2 s, 1.0x, skip code", () => {
    assert.deepEqual(DEFAULTS, {
      autoSend: true, voiceId: null, voiceName: "", ttsModel: "eleven_flash_v2_5", sttModel: "scribe_v2_realtime", language: null,
      pauseMs: 1200, speed: 1, skipCode: true,
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
      language: "sr", pauseMs: 2000, speed: 1.1, skipCode: false,
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
