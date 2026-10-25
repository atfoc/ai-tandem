// The voice settings (architecture VC-14): the type, the defaults, and the reading and clamping of the stored value. The value is one
// JSON text in the kv port (`aiwb.voice.settings`); `engine/state.ts` reads and writes it through these functions. The key is not in it.
import type { SavedDevice } from "../ports.ts";
import { STT_MODELS, TTS_MODELS } from "./protocol.ts";

export type VoiceSettings = {
  autoSend: boolean;            // default true
  voiceId: string | null;       // null: the first voice at first use
  voiceName: string;
  ttsModel: (typeof TTS_MODELS)[number];   // default flash
  sttModel: (typeof STT_MODELS)[number];
  language: string | null;      // null = auto-detect
  pauseMs: number;              // default 1200, clamp 100..10000
  speed: number;                // default 1, one of 0.5, 1, 1.5, 2
  skipCode: boolean;            // default true
  mic: SavedDevice | null;      // default null = System default (voice-devices VD-3); only the person's pick in Settings changes it
  speaker: SavedDevice | null;  // default null = System default
};

export const SETTINGS_KEY = "aiwb.voice.settings";

export const DEFAULTS: VoiceSettings = {
  autoSend: true,
  voiceId: null,
  voiceName: "",
  ttsModel: "eleven_flash_v2_5",
  sttModel: "scribe_v2_realtime",
  language: null,
  pauseMs: 1200,
  speed: 1,
  skipCode: true,
  mic: null,
  speaker: null,
};

export const PAUSE_MIN_MS = 100;
export const PAUSE_MAX_MS = 10000;
/** The slider's step; a saved value is clamped and rounded to whole ms, not snapped to it, so a value saved before reads unchanged. */
export const PAUSE_STEP_MS = 100;
/** The speeds Settings offers. The app stretches the audio itself (small-improvements 4.2): the service is asked at its own speed. */
export const SPEEDS: readonly number[] = [0.5, 1, 1.5, 2];

const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const NAME_MAX = 200;
const DEVICE_ID_MAX = 512;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The one of `of` nearest to `n`; of two equally near, the one nearer to 1 (0.75 is 1, 1.75 is 1.5). */
const nearest = (n: number, of: readonly number[]): number =>
  of.reduce((best, x) => {
    const dx = Math.abs(x - n), db = Math.abs(best - n);
    return dx < db || (dx === db && Math.abs(x - 1) < Math.abs(best - 1)) ? x : best;
  });

/** A saved device from anything: `{id: 1..512 characters, name: 0..200}` (both trimmed), else null. */
function clampDevice(v: unknown): SavedDevice | null {
  if (!isObject(v) || typeof v.id !== "string" || typeof v.name !== "string") return null;
  const id = v.id.trim();
  if (id.length < 1 || id.length > DEVICE_ID_MAX) return null;
  const name = v.name.trim();
  if (name.length > NAME_MAX) return null;
  return { id, name };
}

/** Whether two settings are equal: the fields by identity, a saved device by its id and name (a clamped value is a new object each time). */
export function sameSettings(a: VoiceSettings, b: VoiceSettings): boolean {
  const same = (x: SavedDevice | null, y: SavedDevice | null): boolean => x === y || (x !== null && y !== null && x.id === y.id && x.name === y.name);
  return (Object.keys(a) as (keyof VoiceSettings)[]).every((k) => (k === "mic" || k === "speaker" ? same(a[k], b[k]) : a[k] === b[k]));
}

/** A settings value from anything: each field that is not valid is its default, and a number is brought into its range. */
export function clampSettings(s: Partial<Record<keyof VoiceSettings, unknown>> | null | undefined): VoiceSettings {
  const v = s ?? {};
  const ttsModel = TTS_MODELS.find((m) => m === v.ttsModel) ?? DEFAULTS.ttsModel;
  const sttModel = STT_MODELS.find((m) => m === v.sttModel) ?? DEFAULTS.sttModel;
  const pause = typeof v.pauseMs === "number" && Number.isFinite(v.pauseMs) ? v.pauseMs : DEFAULTS.pauseMs;
  const speed = typeof v.speed === "number" && Number.isFinite(v.speed) ? nearest(v.speed, SPEEDS) : DEFAULTS.speed;
  const language = typeof v.language === "string" ? v.language.trim().toLowerCase() : "";
  return {
    autoSend: typeof v.autoSend === "boolean" ? v.autoSend : DEFAULTS.autoSend,
    voiceId: typeof v.voiceId === "string" && VOICE_ID.test(v.voiceId) ? v.voiceId : null,
    voiceName: typeof v.voiceName === "string" ? v.voiceName.slice(0, NAME_MAX) : DEFAULTS.voiceName,
    ttsModel,
    sttModel,
    language: LANGUAGE.test(language) ? language : null,
    pauseMs: Math.min(PAUSE_MAX_MS, Math.max(PAUSE_MIN_MS, Math.round(pause))),
    speed,
    skipCode: typeof v.skipCode === "boolean" ? v.skipCode : DEFAULTS.skipCode,
    mic: clampDevice(v.mic),
    speaker: clampDevice(v.speaker),
  };
}

/** The stored text as settings. Text that does not parse is the defaults; nothing else is migrated. */
export function parseSettings(text: string | null): VoiceSettings {
  if (text === null) return { ...DEFAULTS };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ...DEFAULTS }; }
  return isObject(v) ? clampSettings(v) : { ...DEFAULTS };
}

export const stringifySettings = (s: VoiceSettings): string => JSON.stringify(clampSettings(s));
