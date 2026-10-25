// What the phone's Voice screen says (S3, goal 3.8.5): the key state, the Advanced rows with their shown values and the settings a pick
// changes, and the chosen voice's row.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULTS } from "../src/voice/logic/settings.ts";
import { S3_TID } from "../src/screens/voice/ids.ts";
import { LANGUAGE_AUTO, advancedRows, canShowAll, chosenVoiceRow, deviceRows, keyResultLine, keyState, markedVoice, pickPatch, voiceList } from "../src/screens/voice/voicerows.ts";
import { ADVANCED_PAUSE_VALUE, PROBLEM_WORDS, VS_FIRST_VOICE, VS_PLAYING } from "../src/voice/words.ts";

test("the screen's state follows the keystore, and is unknown until it answers", () => {
  assert.equal(keyState(null), "unknown");
  assert.equal(keyState(false), "none");
  assert.equal(keyState(true), "saved");
});

test("the Advanced rows say the saved values in the dialog's words", () => {
  const rows = advancedRows(DEFAULTS);
  assert.deepEqual(rows.map((r) => [r.which, r.label, r.value]), [
    ["tts", "Speech model", "Flash v2.5"], ["stt", "Transcription", "Scribe v2 Realtime"], ["language", "Language", "Auto-detect"],
    ["speed", "Playback speed", "1×"],
  ]);
  assert.equal(rows[2]!.current, LANGUAGE_AUTO);
  assert.equal(rows[3]!.current, "1");
});

test("the options are the dialog's: three models, one transcriber, auto and 31 languages, four speeds", () => {
  const [tts, stt, language, speed] = advancedRows(DEFAULTS);
  assert.equal(tts!.options.length, 3);
  assert.equal(stt!.options.length, 1);
  assert.equal(language!.options.length, 32);
  assert.deepEqual(speed!.options.map((o) => o.label), ["0.5×", "1×", "1.5×", "2×"]);
});

test("a language and a speed show their own label", () => {
  const rows = advancedRows({ ...DEFAULTS, language: "de", speed: 1.5, ttsModel: "eleven_multilingual_v2" });
  assert.deepEqual(rows.map((r) => r.value), ["Multilingual v2", "Scribe v2 Realtime", "German", "1.5×"]);
});

test("the pause is no picker row: a slider draws it, between Language and Speed, and its testID is the screen's", () => {
  assert.deepEqual(advancedRows(DEFAULTS).map((r) => r.which), ["tts", "stt", "language", "speed"]);
  assert.equal(S3_TID.advPause, "vs-adv-pause");
});

test("the slider's values read in the dialog's words: one decimal and a unit, at the ends and between", () => {
  assert.deepEqual([100, 1200, 4700, 10000].map(ADVANCED_PAUSE_VALUE), ["0.1 s", "1.2 s", "4.7 s", "10.0 s"]);
});

test("a pick maps its string back to the setting", () => {
  assert.deepEqual(pickPatch("tts", "eleven_v4_turbo"), { ttsModel: "eleven_v4_turbo" });
  assert.deepEqual(pickPatch("stt", "scribe_v2_realtime"), { sttModel: "scribe_v2_realtime" });
  assert.deepEqual(pickPatch("language", "fr"), { language: "fr" });
  assert.deepEqual(pickPatch("language", LANGUAGE_AUTO), { language: null });
  assert.deepEqual(pickPatch("speed", "1.5"), { speed: 1.5 });
});

test("the chosen voice row: the name, what is known of it, the sample line while it plays", () => {
  const s = { voiceId: "v1", voiceName: "Rachel" };
  assert.deepEqual(chosenVoiceRow(s, "Calm, young American woman", false), { label: "Rachel", sub: "Calm, young American woman", chosen: true });
  assert.deepEqual(chosenVoiceRow(s, undefined, false), { label: "Rachel", sub: undefined, chosen: true });
  assert.equal(chosenVoiceRow(s, "Calm", true).sub, VS_PLAYING);
});

test("with no voice chosen the row says the account's first voice, with no play and no tick", () => {
  assert.deepEqual(chosenVoiceRow({ voiceId: null, voiceName: "" }, undefined, false), { label: VS_FIRST_VOICE, sub: undefined, chosen: false });
});

test("every testID is unique", () => {
  const ids = Object.values(S3_TID);
  assert.equal(new Set(ids).size, ids.length);
});

test("the device cells say the saved choice by name or System default, and 'System' where the platform decides", () => {
  const both = { input: "pick", output: "pick", linked: false } as const;
  assert.deepEqual(deviceRows({ mic: null, speaker: null }, both), {
    neitherLine: null, mic: { mode: "pick", value: "System default" }, speaker: { mode: "pick", value: "System default" },
  });
  const rows = deviceRows({ mic: { id: "m1", name: "Desk Mic" }, speaker: { id: "s1", name: "" } }, both);
  assert.deepEqual([rows.mic.value, rows.speaker.value], ["Desk Mic", "Saved device"]);
  const out = deviceRows({ mic: { id: "m1", name: "Desk Mic" }, speaker: null }, { input: "pick", output: "system", linked: false });
  assert.equal(out.mic.value, "Desk Mic");
  assert.equal(out.speaker.mode, "system");
  assert.equal(out.speaker.value, "System");
  assert.match((out.speaker as { line: string }).line, /^Follows the system/);
});

test("with neither kind choosable the two rows are one line", () => {
  const rows = deviceRows({ mic: null, speaker: null }, { input: "system", output: "system", linked: false });
  assert.match(rows.neitherLine ?? "", /system's microphone and speaker/);
});

const V = (id: string): { id: string; name: string; about: string; previewUrl: string | null } => ({ id, name: `Voice ${id}`, about: `About ${id}`, previewUrl: null });

test("Choose voice: the chosen voice first on the short list, by its stored name when the page does not list it", () => {
  const page = [V("a"), V("b"), V("c")];
  assert.deepEqual(voiceList(page, "c", "Voice c", false).map((v) => v.id), ["c", "a", "b"]);
  assert.deepEqual(voiceList(page, "a", "Voice a", false).map((v) => v.id), ["a", "b", "c"]);
  const missing = voiceList(page, "z", "Zed", false);
  assert.deepEqual(missing.map((v) => v.id), ["z", "a", "b", "c"]);
  assert.equal(missing[0]!.name, "Zed");
  assert.deepEqual(voiceList(page, "z", "", false).map((v) => v.id), ["a", "b", "c"], "no stored name, nothing to show");
  assert.deepEqual(voiceList(page, null, "", false).map((v) => v.id), ["a", "b", "c"]);
  assert.deepEqual(voiceList(page, "c", "Voice c", true).map((v) => v.id), ["a", "b", "c"], "the full list keeps the service's order");
});

test("Choose voice: the marked voice is the chosen one, else the first of the list", () => {
  const rows = [V("a"), V("b")];
  assert.equal(markedVoice(rows, "b"), "b");
  assert.equal(markedVoice(rows, null), "a");
  assert.equal(markedVoice([], null), null);
});

test("Choose voice: Show all voices is offered on the short list only, when there is more", () => {
  assert.equal(canShowAll(false, 6, 34, null), true);
  assert.equal(canShowAll(false, 6, 6, null), false);
  assert.equal(canShowAll(false, 6, 6, "next"), true);
  assert.equal(canShowAll(true, 6, 34, "next"), false);
});

test("Choose voice's ids are the design's", () => {
  assert.deepEqual([S3_TID.cvScreen, S3_TID.cvSearch, S3_TID.cvRow, S3_TID.cvPlay, S3_TID.cvCount, S3_TID.cvAll, S3_TID.cvMore, S3_TID.cvProblem],
    ["cv-screen", "cv-search", "cv-row", "cv-play", "cv-count", "cv-all", "cv-more", "cv-problem"]);
});

test("Add key's result line: a working key is green with the voice count, a problem is red with its sentence", () => {
  assert.deepEqual(keyResultLine({ ok: true, voices: 34 }), { tone: "ok", text: "✓ Works: 34 voices found." });
  assert.equal(keyResultLine({ ok: true, voices: 1 }).text, "✓ Works: 1 voice found.");
  assert.deepEqual(keyResultLine({ ok: false, problem: "no_key" }), { tone: "danger", text: `! ${PROBLEM_WORDS.no_key.sentence}` });
});
