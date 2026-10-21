// The voice service's protocol and the problems (architecture §2): the query, the frames, the events, the voices and the table of
// errors. Loaded by Node: the files under test have no React and no react-native.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { VoiceNetError, VoiceProblemError } from "../src/voice/ports.ts";
import { problemOfException, problemOfStatus, problemOfSttError } from "../src/voice/logic/problems.ts";
import {
  CHUNK_MS, STT_ERROR_TYPES, STT_MODELS, TTS_MODELS, VAD_SILENCE_S, audioFrame, firstVoiceQuery, parseSttEvent, parseVoices, sttQuery,
  testKeyQuery, ttsBody, ttsPath, ttsQuery, voicesQuery,
} from "../src/voice/logic/protocol.ts";
import { DEFAULTS } from "../src/voice/logic/settings.ts";

describe("constants (VC-19)", () => {
  it("name the models of arch 2.5 and the chunk and silence of VC-19", () => {
    assert.deepEqual([...TTS_MODELS], ["eleven_flash_v2_5", "eleven_multilingual_v2"]);
    assert.deepEqual([...STT_MODELS], ["scribe_v2_realtime"]);
    assert.equal(CHUNK_MS, 100);
    assert.equal(VAD_SILENCE_S, 0.6);
  });
});

describe("the STT query and the TTS request", () => {
  it("sttQuery: model, format, vad and silence; the language only when set", () => {
    assert.deepEqual(sttQuery(DEFAULTS), {
      model_id: "scribe_v2_realtime", audio_format: "pcm_16000", commit_strategy: "vad", vad_silence_threshold_secs: "0.6",
    });
    assert.equal(sttQuery({ ...DEFAULTS, language: "sr" }).language_code, "sr");
  });
  it("ttsPath and ttsQuery", () => {
    assert.equal(ttsPath("abc123"), "/v1/text-to-speech/abc123/stream");
    assert.deepEqual(ttsQuery(), { output_format: "pcm_24000" });
  });
  it("ttsBody sends the speed only when it is not 1.0", () => {
    assert.deepEqual(ttsBody("Hello.", DEFAULTS), { text: "Hello.", model_id: "eleven_flash_v2_5" });
    assert.deepEqual(ttsBody("Hello.", { ...DEFAULTS, speed: 1.2 }), {
      text: "Hello.", model_id: "eleven_flash_v2_5", voice_settings: { speed: 1.2 },
    });
    assert.deepEqual(ttsBody("Hello.", { ...DEFAULTS, speed: 0.8 }).voice_settings, { speed: 0.8 });
  });
  it("ttsBody sends the language to the flash model and not to the multilingual one, which ignores it", () => {
    assert.equal(ttsBody("Hi.", { ...DEFAULTS, language: "de" }).language_code, "de");
    assert.equal("language_code" in ttsBody("Hi.", { ...DEFAULTS, language: "de", ttsModel: "eleven_multilingual_v2" }), false);
  });
});

describe("audioFrame", () => {
  it("has the four fields the service requires", () => {
    assert.deepEqual(JSON.parse(audioFrame("AAAA", false)), {
      message_type: "input_audio_chunk", audio_base_64: "AAAA", commit: false, sample_rate: 16000,
    });
  });
  it("commit is an empty chunk with commit true", () => {
    const f = JSON.parse(audioFrame("", true));
    assert.equal(f.commit, true);
    assert.equal(f.audio_base_64, "");
  });
});

describe("parseSttEvent", () => {
  const ev = (o: object) => parseSttEvent(JSON.stringify(o));
  it("reads the four events", () => {
    assert.deepEqual(ev({ message_type: "session_started", session_id: "s", config: {} }), { kind: "session_started" });
    assert.deepEqual(ev({ message_type: "partial_transcript", text: "hel" }), { kind: "partial", text: "hel" });
    assert.deepEqual(ev({ message_type: "committed_transcript", text: "hello" }), { kind: "committed", text: "hello" });
    assert.deepEqual(ev({ message_type: "auth_error", error: "bad key sk_test_x" }), { kind: "error", type: "auth_error" });
  });
  it("every error type of the service is an error, with no text of its own", () => {
    for (const type of STT_ERROR_TYPES) assert.deepEqual(ev({ message_type: type, error: "secret words" }), { kind: "error", type });
  });
  it("ignores what voice does not ask for, warnings, unknown types and frames that are not events", () => {
    for (const o of [
      { message_type: "committed_transcript_with_timestamps", text: "x", words: [] },
      { message_type: "committed_transcript_entities", text: "x" },
      { message_type: "edited_transcript", text: "x" },
      { message_type: "warning", warning: "w" },
      { message_type: "something_new" },
      { message_type: "partial_transcript" },
      { text: "no type" },
      [], null, 3,
    ]) assert.deepEqual(ev(o as object), { kind: "ignored" });
    assert.deepEqual(parseSttEvent("not json"), { kind: "ignored" });
    assert.deepEqual(parseSttEvent(""), { kind: "ignored" });
  });
  it("an unknown type with an error text is an error of that type", () => {
    assert.deepEqual(ev({ message_type: "new_failure", error: "boom" }), { kind: "error", type: "new_failure" });
  });
});

describe("voices", () => {
  it("voicesQuery: the short list, the full page, the search and the cursor", () => {
    assert.deepEqual(voicesQuery(), { page_size: "4", sort: "name", include_total_count: "true" });
    assert.deepEqual(voicesQuery({ all: true, search: "  warm ", cursor: "tok" }), {
      page_size: "30", sort: "name", include_total_count: "true", search: "warm", next_page_token: "tok",
    });
    assert.equal("search" in voicesQuery({ search: "   " }), false);
  });
  it("Test key and the first voice ask for one voice", () => {
    assert.deepEqual(testKeyQuery(), { page_size: "1", include_total_count: "true" });
    assert.deepEqual(firstVoiceQuery(), { page_size: "1", sort: "name" });
  });
  it("parseVoices reads names, a few words, the preview and the paging", () => {
    const list = parseVoices({
      voices: [
        { voice_id: "a1", name: "Alice", description: "  A warm voice. ", labels: { accent: "british" }, preview_url: "https://x.example/a.mp3" },
        { voice_id: "b2", name: "Bob", description: "", labels: { accent: "american", descriptive: "calm", use_case: "narration" }, preview_url: "http://x.example/b.mp3" },
        { voice_id: "c3", labels: null },
        { name: "No id" },
        "junk",
      ],
      has_more: true, total_count: 42, next_page_token: "next",
    });
    assert.deepEqual(list, {
      voices: [
        { id: "a1", name: "Alice", about: "A warm voice.", previewUrl: "https://x.example/a.mp3" },
        { id: "b2", name: "Bob", about: "American, calm, narration", previewUrl: null },
        { id: "c3", name: "c3", about: "", previewUrl: null },
      ],
      total: 42, cursor: "next",
    });
  });
  it("parseVoices keeps a plain-http preview only on a local host", () => {
    const at = (url: string) => parseVoices({ voices: [{ voice_id: "a", preview_url: url }] }).voices[0].previewUrl;
    for (const url of [
      "http://127.0.0.1:4800/voice/_preview/a.wav", "http://localhost:4800/voice/_preview/a.wav", "http://10.0.2.2/a.wav",
      "http://192.168.1.20:8080/a.wav", "http://172.16.0.5/a.wav", "http://localhost",
    ]) assert.equal(at(url), url, url);
    for (const url of [
      "http://example.com/a.wav", "http://8.8.8.8/a.wav", "http://172.32.0.5/a.wav", "http://localhost.evil.com/a.wav",
      "http://localhost@evil.com/a.wav", "http://127.0.0.1.evil.com/a.wav", "http://127.0.0.1:99999999/a.wav", "ftp://localhost/a.wav", "//localhost/a.wav", "",
    ]) assert.equal(at(url), null, url);
    assert.equal(at("https://x.example/a.mp3"), "https://x.example/a.mp3");
  });
  it("parseVoices: no more means no cursor, a missing total is the page, a wrong answer is an empty list", () => {
    assert.deepEqual(parseVoices({ voices: [{ voice_id: "a" }], has_more: false, next_page_token: "stale" }).cursor, null);
    assert.equal(parseVoices({ voices: [{ voice_id: "a" }] }).total, 1);
    for (const j of [null, 3, "x", [], {}, { voices: "no" }]) assert.deepEqual(parseVoices(j), { voices: [], total: 0, cursor: null });
  });
});

describe("problems (arch 2.6)", () => {
  const body = (detail: unknown) => JSON.stringify({ detail });
  it("a status that went through is no problem", () => {
    assert.equal(problemOfStatus(200, ""), null);
    assert.equal(problemOfStatus(204, ""), null);
  });
  it("401 is the key, but the legacy quota_exceeded is credits", () => {
    assert.equal(problemOfStatus(401, body({ status: "invalid_api_key" })), "key_rejected");
    assert.equal(problemOfStatus(401, body({ code: "missing_api_key" })), "key_rejected");
    assert.equal(problemOfStatus(401, ""), "key_rejected");
    assert.equal(problemOfStatus(401, body({ status: "quota_exceeded", message: "m" })), "no_credits");
    assert.equal(problemOfStatus(401, body({ code: "quota_exceeded" })), "no_credits");
  });
  it("403 is the key; 402 and 429 are credits", () => {
    assert.equal(problemOfStatus(403, body({ code: "insufficient_permissions" })), "key_rejected");
    assert.equal(problemOfStatus(402, body({ code: "insufficient_credits" })), "no_credits");
    for (const code of ["rate_limit_exceeded", "concurrent_limit_exceeded", "system_busy"]) assert.equal(problemOfStatus(429, body({ code })), "no_credits");
  });
  it("5xx and a timeout are offline; any other refusal is the service's", () => {
    for (const s of [500, 502, 503, 504, 408]) assert.equal(problemOfStatus(s, ""), "offline");
    for (const s of [400, 404, 422]) assert.equal(problemOfStatus(s, body("text only")), "service");
  });
  it("the code wins over the status, and bodies of other shapes are read as no code", () => {
    assert.equal(problemOfStatus(400, body({ code: "quota_exceeded" })), "no_credits");
    for (const b of ["not json", "null", "[]", body("a string"), body([1]), body({ code: 7 })]) assert.equal(problemOfStatus(401, b), "key_rejected");
  });
  it("STT errors follow the table; two of them are not a problem", () => {
    assert.equal(problemOfSttError("auth_error"), "key_rejected");
    for (const t of ["quota_exceeded", "rate_limited", "commit_throttled", "queue_overflow", "resource_exhausted"]) assert.equal(problemOfSttError(t), "no_credits");
    assert.equal(problemOfSttError("unaccepted_terms"), "service");
    assert.equal(problemOfSttError("session_time_limit_exceeded"), null);
    assert.equal(problemOfSttError("insufficient_audio_activity"), null);
    for (const t of ["error", "input_error", "invalid_request", "chunk_size_exceeded", "transcriber_error", "never_heard_of_it"]) assert.equal(problemOfSttError(t), "offline");
  });
  it("every STT error type has an answer (a problem or null)", () => {
    for (const t of STT_ERROR_TYPES) assert.notEqual(problemOfSttError(t), undefined);
  });
  it("an exception: a port's problem stays, the rest is offline, and its text is never read", () => {
    assert.equal(problemOfException(new VoiceProblemError("mic_blocked")), "mic_blocked");
    assert.equal(problemOfException(new VoiceNetError()), "offline");
    assert.equal(problemOfException(new TypeError("fetch failed https://api.elevenlabs.io/v1 xi-api-key sk_test_secret")), "offline");
    assert.equal(problemOfException("x"), "offline");
    assert.equal(problemOfException(undefined), "offline");
  });
});
