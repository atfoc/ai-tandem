// What the rows of the phone's Voice screen say (S3, goal 3.8.5): the key state of the screen, the Advanced rows with their options and
// shown values (a PickerSheet's values are strings, so a number or null is mapped to one and back), and the chosen voice's label and
// sub-line. Pure: no react-native, so Node tests it.
import { choicesFor, cutName } from "../../voice/logic/devices.ts";
import type { DeviceAbility, SavedDevice } from "../../voice/ports.ts";
import type { VoiceInfo } from "../../voice/index.ts";
import { SPEEDS } from "../../voice/logic/settings.ts";
import type { VoiceSettings } from "../../voice/logic/settings.ts";
import {
  ADVANCED_LANGUAGE, ADVANCED_LANGUAGE_AUTO, ADVANCED_SPEED, ADVANCED_SPEED_VALUE, ADVANCED_STT_SCRIBE,
  ADVANCED_TTS_FLASH, ADVANCED_TTS_MODEL, ADVANCED_TTS_MULTILINGUAL, ADVANCED_TTS_V4_TURBO, DEVICE_SYSTEM, DEVICE_UNNAMED, LANGUAGES, PROBLEM_WORDS,
  VS_DEVICE_SYSTEM_VALUE, VS_FIRST_VOICE, VS_KEY_PROBLEM, VS_KEY_WORKS, VS_PLAYING, VS_STT_MODEL,
} from "../../voice/words.ts";
import type { VoiceProblemKind } from "../../voice/ports.ts";

export type KeyState = "unknown" | "none" | "saved";

/** The screen's state from what the keystore answered: null until it has. */
export const keyState = (hasKey: boolean | null): KeyState => (hasKey === null ? "unknown" : hasKey ? "saved" : "none");

export type AdvancedWhich = "tts" | "stt" | "language" | "speed";
export type AdvancedOption = { value: string; label: string };
export type AdvancedRow = {
  which: AdvancedWhich;
  /** The cell's label and the sheet's title. */
  label: string;
  /** The cell's value: the label of the chosen option. */
  value: string;
  /** The chosen option's value, as the sheet holds it. */
  current: string;
  options: AdvancedOption[];
};

/** The language that stands for "no language" in a sheet: the codes are two or three letters, so it is no code. */
export const LANGUAGE_AUTO = "auto";

const TTS: AdvancedOption[] = [
  { value: "eleven_flash_v2_5", label: ADVANCED_TTS_FLASH }, { value: "eleven_v4_turbo", label: ADVANCED_TTS_V4_TURBO },
  { value: "eleven_multilingual_v2", label: ADVANCED_TTS_MULTILINGUAL },
];
const STT: AdvancedOption[] = [{ value: "scribe_v2_realtime", label: ADVANCED_STT_SCRIBE }];
const LANGUAGE: AdvancedOption[] = [{ value: LANGUAGE_AUTO, label: ADVANCED_LANGUAGE_AUTO }, ...LANGUAGES.map(([code, name]) => ({ value: code, label: name }))];
const SPEED: AdvancedOption[] = SPEEDS.map((x) => ({ value: String(x), label: ADVANCED_SPEED_VALUE(x) }));

const row = (which: AdvancedWhich, label: string, options: AdvancedOption[], current: string, other: string): AdvancedRow =>
  ({ which, label, options, current, value: options.find((o) => o.value === current)?.label ?? other });

/** The four picker rows of Advanced (the pause is a slider, drawn between Language and Speed), in the order of the screen, for the saved settings. */
export function advancedRows(s: Pick<VoiceSettings, "ttsModel" | "sttModel" | "language" | "speed">): AdvancedRow[] {
  const language = s.language ?? LANGUAGE_AUTO;
  return [
    row("tts", ADVANCED_TTS_MODEL, TTS, s.ttsModel, s.ttsModel),
    row("stt", VS_STT_MODEL, STT, s.sttModel, s.sttModel),
    row("language", ADVANCED_LANGUAGE, LANGUAGE, language, language),
    row("speed", ADVANCED_SPEED, SPEED, String(s.speed), ADVANCED_SPEED_VALUE(s.speed)),
  ];
}

/** The setting a pick in a sheet changes, the value mapped back to what the setting holds. */
export function pickPatch(which: AdvancedWhich, value: string): Partial<VoiceSettings> {
  switch (which) {
    case "tts": return { ttsModel: value as VoiceSettings["ttsModel"] };
    case "stt": return { sttModel: value as VoiceSettings["sttModel"] };
    case "language": return { language: value === LANGUAGE_AUTO ? null : value };
    case "speed": return { speed: Number(value) };
  }
}

export type ChosenVoice = {
  /** The name, or the line for an account's first voice (nothing chosen yet). */
  label: string;
  /** Under the name: "Playing sample…" while it plays, else what the session knows of the voice. */
  sub: string | undefined;
  /** A play button and a ✓ belong to a voice that is chosen. */
  chosen: boolean;
};

/** The chosen-voice row: `about` is the description the session already knows (the voice cache), never fetched for this row. */
export function chosenVoiceRow(s: Pick<VoiceSettings, "voiceId" | "voiceName">, about: string | undefined, playing: boolean): ChosenVoice {
  if (s.voiceId === null) return { label: VS_FIRST_VOICE, sub: undefined, chosen: false };
  return { label: s.voiceName || s.voiceId, sub: playing ? VS_PLAYING : about || undefined, chosen: true };
}

export type DeviceKind = "mic" | "speaker";
/** A Microphone or Speaker cell: `pick` shows the saved choice's name (or System default) without listing anything; `system` is a kind the
 *  platform decides, with the line its sheet says. */
export type DeviceCell = { mode: "pick"; value: string } | { mode: "system"; value: string; line: string };
export type DeviceRows = { neitherLine: string | null; mic: DeviceCell; speaker: DeviceCell };

/** The values of the two device cells from the saved choices and what the platform lets voice choose (`ability`): no listing is needed, so the
 *  rows ask no device of the system. With neither kind choosable, `neitherLine` is the one plain cell's line. */
export function deviceRows(saved: { mic: SavedDevice | null; speaker: SavedDevice | null }, ability: DeviceAbility): DeviceRows {
  const c = choicesFor(null, saved, ability);
  const cell = (kind: DeviceKind): DeviceCell => {
    const choice = c[kind];
    if (choice.show === "system") return { mode: "system", value: VS_DEVICE_SYSTEM_VALUE, line: choice.line };
    const d = saved[kind];
    return { mode: "pick", value: d ? cutName(d.name.trim() === "" ? DEVICE_UNNAMED : d.name) : DEVICE_SYSTEM };
  };
  return { neitherLine: c.neitherLine, mic: cell("mic"), speaker: cell("speaker") };
}
/** The rows of Choose voice for a page the service listed. The short list puts the chosen voice first; a chosen voice the page does not list is
 *  still shown, first, by the name kept with it. The full list (or a search) stays in the service's order. */
export function voiceList(voices: readonly VoiceInfo[], chosen: string | null, chosenName: string, all: boolean): VoiceInfo[] {
  if (all) return [...voices];
  const at = chosen ? voices.findIndex((v) => v.id === chosen) : -1;
  if (at > 0) return [voices[at]!, ...voices.slice(0, at), ...voices.slice(at + 1)];
  if (at === 0 || !chosen || !chosenName) return [...voices];
  return [{ id: chosen, name: chosenName, about: "", previewUrl: null }, ...voices];
}

/** The voice that is marked: the chosen one, or with none chosen the first of the list (the one that will speak). */
export const markedVoice = (rows: readonly VoiceInfo[], chosen: string | null): string | null => chosen ?? rows[0]?.id ?? null;

/** Whether "Show all voices" is offered: on the short list, when the service has more than the rows shown. */
export const canShowAll = (all: boolean, shown: number, total: number, cursor: string | null): boolean => !all && (total > shown || cursor !== null);

export type KeyResultLine = { tone: "ok" | "danger" | "muted"; text: string };

/** The result line of Add key for an answer of `voice.testKey`: green "✓ Works: N voices found." or red "! <the problem's sentence>". */
export const keyResultLine = (r: { ok: true; voices: number } | { ok: false; problem: VoiceProblemKind }): KeyResultLine =>
  r.ok ? { tone: "ok", text: VS_KEY_WORKS(r.voices) } : { tone: "danger", text: VS_KEY_PROBLEM(PROBLEM_WORDS[r.problem].sentence) };
