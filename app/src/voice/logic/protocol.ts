// The voice service as the code sees it (architecture §2): its paths, its query keys, the ids of its models, the frames sent to it and
// the events read from it. Every name of the service is in this file, so a change of the service is a change here (and in the stand-in,
// `web/dev/voicestandin.mjs`). Pure: it makes no address (`platform/origin.ts` does) and holds no key.
import { isLocalHost } from "../platform/origin.ts";
import type { VoiceSettings } from "./settings.ts";

export const STT_PATH = "/v1/speech-to-text/realtime";
export const TOKEN_PATH = "/v1/single-use-token/realtime_scribe";
export const VOICES_PATH = "/v2/voices";

export const TTS_MODELS = ["eleven_flash_v2_5", "eleven_v4_turbo", "eleven_multilingual_v2"] as const;
export const STT_MODELS = ["scribe_v2_realtime"] as const;

/** What the microphone sends: 16 kHz mono s16le in chunks of this many milliseconds (1600 samples, 3200 bytes). */
export const CHUNK_MS = 100;
export const STT_SAMPLE_RATE = 16000;
export const STT_AUDIO_FORMAT = "pcm_16000";
/** What the service answers a sentence with: raw s16le mono at this rate. */
export const TTS_SAMPLE_RATE = 24000;
export const TTS_OUTPUT_FORMAT = "pcm_24000";
/** The silence after which the service commits what it heard. */
export const VAD_SILENCE_S = 0.6;
/** How many voices Settings lists before "Show all voices", and the page of the full list. */
export const VOICES_SHORT = 4;
export const VOICES_PAGE = 30;

export type VoiceInfo = { id: string; name: string; about: string; previewUrl: string | null };
export type VoiceList = { voices: VoiceInfo[]; total: number; cursor: string | null };

type Query = Record<string, string>;

/** The query of the STT socket (§2.1): the model, the format, the strategy, the silence, and the language when one is set. */
export function sttQuery(s: Pick<VoiceSettings, "sttModel" | "language">): Query {
  const q: Query = {
    model_id: s.sttModel,
    audio_format: STT_AUDIO_FORMAT,
    commit_strategy: "vad",
    vad_silence_threshold_secs: String(VAD_SILENCE_S),
  };
  if (s.language) q.language_code = s.language;
  return q;
}

export const ttsPath = (voiceId: string): string => `/v1/text-to-speech/${voiceId}/stream`;
export const ttsQuery = (): Query => ({ output_format: TTS_OUTPUT_FORMAT });

/** The body for one sentence (§2.3): only the sentence and the model, the language when set (to every model but the multilingual one,
 *  which ignores it). The speed is not in it: the app changes the speed of the audio itself (small-improvements 4.2). */
export function ttsBody(text: string, s: Pick<VoiceSettings, "ttsModel" | "language">): Record<string, unknown> {
  const body: Record<string, unknown> = { text, model_id: s.ttsModel };
  if (s.language && s.ttsModel !== "eleven_multilingual_v2") body.language_code = s.language;
  return body;
}

/** One frame to the STT socket: `commit` asks the service to commit what it has (sent with an empty `b64` at Send). */
export const audioFrame = (b64: string, commit: boolean): string =>
  JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64, commit, sample_rate: STT_SAMPLE_RATE });

/** The message types of the service that are errors (§2.1). */
export const STT_ERROR_TYPES = [
  "error", "auth_error", "quota_exceeded", "commit_throttled", "unaccepted_terms", "rate_limited", "queue_overflow",
  "resource_exhausted", "session_time_limit_exceeded", "input_error", "invalid_request", "chunk_size_exceeded",
  "insufficient_audio_activity", "transcriber_error",
] as const;

export type SttEvent =
  | { kind: "session_started" }
  | { kind: "partial"; text: string }
  | { kind: "committed"; text: string }
  | { kind: "error"; type: string }
  | { kind: "ignored" };

const IGNORED: SttEvent = { kind: "ignored" };

/** A text frame from the STT socket as an event. Frames voice does not ask for (timestamps, entities, edits, warnings), frames that are
 *  not JSON and types it does not know are `ignored`; a frame with an `error` text and a type it does not know is an `error` of that
 *  type (the problem of an unknown type is "can't reach"). The text of an error is never kept: it could name the key. */
export function parseSttEvent(text: string): SttEvent {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return IGNORED; }
  if (typeof v !== "object" || v === null) return IGNORED;
  const m = v as Record<string, unknown>;
  const type = m.message_type;
  if (typeof type !== "string") return IGNORED;
  switch (type) {
    case "session_started": return { kind: "session_started" };
    case "partial_transcript": return typeof m.text === "string" ? { kind: "partial", text: m.text } : IGNORED;
    case "committed_transcript": return typeof m.text === "string" ? { kind: "committed", text: m.text } : IGNORED;
    case "committed_transcript_with_timestamps":
    case "committed_transcript_entities":
    case "edited_transcript":
    case "warning":
      return IGNORED;
  }
  if ((STT_ERROR_TYPES as readonly string[]).includes(type) || typeof m.error === "string") return { kind: "error", type };
  return IGNORED;
}

/** The query of the voices list (§2.4): the short list or a page of the full one, by name, with the total. */
export function voicesQuery(o: { all?: boolean; search?: string; cursor?: string } = {}): Query {
  const q: Query = { page_size: String(o.all ? VOICES_PAGE : VOICES_SHORT), sort: "name", include_total_count: "true" };
  const search = o.search?.trim();
  if (search) q.search = search;
  if (o.cursor) q.next_page_token = o.cursor;
  return q;
}

/** Test key: one voice is enough to count how many there are. */
export const testKeyQuery = (): Query => ({ page_size: "1", include_total_count: "true" });
/** The first voice by name: the voice used when none is chosen yet (VC-12). */
export const firstVoiceQuery = (): Query => ({ page_size: "1", sort: "name" });

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "a few words" about a voice: its description, else its labels (accent, tone, use) joined: "British, calm, narration". */
function aboutOf(v: Record<string, unknown>): string {
  const description = str(v.description);
  if (description) return description;
  const labels = typeof v.labels === "object" && v.labels !== null && !Array.isArray(v.labels) ? Object.values(v.labels) : [];
  const words = labels.map(str).filter(Boolean);
  return words.length ? capital(words.join(", ")) : "";
}

const PREVIEW_HOST = /^http:\/\/([A-Za-z0-9.-]{1,253})(?::[0-9]{1,5})?(?:[/?#]|$)/;

/** A preview address worth keeping: https, or plain http on a host of this computer or the local network (the stand-in's clips, as
 *  `platform/origin.ts` judges a local host). The net's allowlist still decides what is fetched. */
function keptPreview(url: string): string | null {
  if (url.startsWith("https://")) return url;
  const m = PREVIEW_HOST.exec(url);
  return m && isLocalHost(m[1]) ? url : null;
}

/** A voices answer as a list. An entry without an id is dropped; a preview address is kept only if it is https or on a local host
 *  (VC-5: a clip is fetched from an https address, or the stand-in's). A missing total is the length of the page; a cursor only when the service has more. */
export function parseVoices(json: unknown): VoiceList {
  const o = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const voices: VoiceInfo[] = [];
  for (const raw of Array.isArray(o.voices) ? o.voices : []) {
    if (typeof raw !== "object" || raw === null) continue;
    const v = raw as Record<string, unknown>;
    const id = str(v.voice_id);
    if (!id) continue;
    const preview = str(v.preview_url);
    voices.push({ id, name: str(v.name) || id, about: aboutOf(v), previewUrl: keptPreview(preview) });
  }
  const total = typeof o.total_count === "number" && Number.isFinite(o.total_count) ? o.total_count : voices.length;
  const token = str(o.next_page_token);
  return { voices, total, cursor: o.has_more === true && token ? token : null };
}
