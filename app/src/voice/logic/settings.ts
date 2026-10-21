// The voice settings (architecture VC-14): the type, the defaults, and the reading and clamping of the stored value. The value is one
// JSON text in the kv port (`aiwb.voice.settings`); `engine/state.ts` reads and writes it through these functions. The key is not in it.
import { STT_MODELS, TTS_MODELS } from "./protocol.ts";

export type VoiceSettings = {
  autoSend: boolean;            // default true
  voiceId: string | null;       // null: the first voice at first use
  voiceName: string;
  ttsModel: "eleven_flash_v2_5" | "eleven_multilingual_v2";   // default flash
  sttModel: "scribe_v2_realtime";
  language: string | null;      // null = auto-detect
  pauseMs: number;              // default 1200, clamp 600..3000
  speed: number;                // default 1.0, one of 0.8..1.2
  skipCode: boolean;            // default true
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
};

export const PAUSE_MIN_MS = 600;
export const PAUSE_MAX_MS = 3000;
/** The speeds Settings offers (0.8× to 1.2×); the service takes 0.7 to 1.2. */
export const SPEEDS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.2];

const VOICE_ID = /^[A-Za-z0-9]{1,64}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const NAME_MAX = 200;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const nearest = (n: number, of: readonly number[]): number => of.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best));

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
