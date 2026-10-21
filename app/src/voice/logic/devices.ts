// The pure rules of voice devices (voice-devices architecture VD-4, VD-11, VD-13, VD-17): finding a saved device again, reading "private"
// from a name, deciding when a lost output pauses, the words of the notices and what the Settings pickers show. No audio, no platform, no
// state: it imports types and the words only, so `node --test` runs it alone (goal 4.11).
import type { AudioDevice, DeviceAbility, DeviceKind, DeviceList, Privacy, SavedDevice } from "../ports.ts";
import * as words from "../words.ts";

/** The platform's pseudo-entries (the web lists them as devices, Windows both): never shown, "System default" stands for them. */
export const PSEUDO_IDS: readonly string[] = ["default", "communications"];

/** A saved device among `devices` (of one kind): by id; else by name (trimmed, case kept), the first in the system's order; else none (VD-4). */
export function matchSaved(saved: SavedDevice, devices: readonly AudioDevice[]): AudioDevice | null {
  const byId = devices.find((d) => d.id === saved.id);
  if (byId) return byId;
  const name = saved.name.trim();
  if (name === "") return null;   // a nameless device is not "the same name" as another nameless one
  return devices.find((d) => d.name.trim() === name) ?? null;
}

const PRIVATE_NAME = /\b(?:headphones?|headset|earphones?|earbuds?|buds\d*|airpods|hands-?free|hearing)\b/i;
const PUBLIC_NAME = /\b(?:speakers?|displays?|hdmi|displayport|tv|monitors?)\b/i;

/** What a device name says of who hears it (VD-11, platforms where no API says it). Private words win over public ones. */
export function privacyOfName(name: string): Privacy {
  if (PRIVATE_NAME.test(name)) return "private";
  if (PUBLIC_NAME.test(name)) return "public";
  return "unknown";
}

/** Whether a lost output pauses (VD-11): the lost one was private or not known (null: unknown), and what the sound moves to is not known to be
 *  private. Moving from one pair of headphones to another does not pause; a loudspeaker that goes away does not either. */
export function shouldPause(lost: AudioDevice | null, now: AudioDevice | null): boolean {
  const lostHeard = lost === null || lost.privacy !== "public";
  const nowPrivate = now !== null && now.privacy === "private";
  return lostHeard && !nowPrivate;
}

/** A name for a notice or a picker: cut to `max` characters (the ellipsis included), never in the middle of a character. */
export function cutName(name: string, max = 40): string {
  const chars = Array.from(name);
  return chars.length <= max ? name : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** The notice on show (VD-13): one sentence, who shows it, and when it was made (it replaces an older one). */
export type VoiceNotice = {
  text: string;
  /** Who shows it: the composer of this chat (dictation, speech mode, Read aloud of a message of the chat), the board's pill, or the devices card
   *  of Settings > Voice (a preview, Test speaker or Test microphone that fell back to the system default). */
  where: { kind: "chat"; chat: string } | { kind: "board"; board: string } | { kind: "settings" };
  at: number;                 // ports.now(), to replace an older one
};

export type NoticeKind = "start-mic" | "start-speaker" | "start-both" | "lost-mic" | "lost-speaker" | "paused";

/** The sentence of a notice (VD-13's table). `mic` and `speaker` are the saved devices that were missing at a start, `device` the one that was
 *  lost; a name that is missing or empty gives the sentence without a name. Names are cut at 40 characters. */
export function noticeText(kind: NoticeKind, names: { mic?: string | null; speaker?: string | null; device?: string | null }): string {
  const name = (n: string | null | undefined): string | null => {
    const t = (n ?? "").trim();
    return t === "" ? null : cutName(t);
  };
  const mic = name(names.mic);
  const speaker = name(names.speaker);
  const device = name(names.device);
  switch (kind) {
    case "start-mic": return mic ? words.NOTICE_START_MIC(mic) : words.NOTICE_START_MIC_UNNAMED;
    case "start-speaker": return speaker ? words.NOTICE_START_SPEAKER(speaker) : words.NOTICE_START_SPEAKER_UNNAMED;
    case "start-both": return mic && speaker ? words.NOTICE_START_BOTH(mic, speaker) : words.NOTICE_START_BOTH_UNNAMED;
    case "lost-mic": return device ? words.NOTICE_LOST_MIC(device) : words.NOTICE_LOST_MIC_UNNAMED;
    case "lost-speaker": return device ? words.NOTICE_LOST_SPEAKER(device) : words.NOTICE_LOST_SPEAKER_UNNAMED;
    case "paused": return device ? words.NOTICE_PAUSED(device) : words.NOTICE_PAUSED_UNNAMED;
  }
}

// ---- what Settings shows (VD-17)

export type DeviceOption = { key: string; label: string; device: SavedDevice | null; missing: boolean };
export type DeviceChoice =
  | { show: "pick"; options: DeviceOption[]; selected: string; hiddenNote: boolean }   // options[0] is System default
  | { show: "system"; line: string };                                                 // "Follows the system: …"
export type DeviceChoices = { mic: DeviceChoice; speaker: DeviceChoice; linkedNote: boolean; neitherLine: string | null; loading: boolean };

const SYSTEM_KEY = "system";
/** Device names longer than this are cut where they are shown, never where they are matched (VD-5). */
const LABEL_MAX = 60;

function choiceFor(
  ability: "pick" | "system",
  devices: readonly AudioDevice[] | null,   // null: not listed yet
  systemDefault: AudioDevice | null,
  hidden: boolean,
  saved: SavedDevice | null,
  follows: string,
): DeviceChoice {
  if (ability === "system") return { show: "system", line: follows };
  const first: DeviceOption = {
    key: SYSTEM_KEY,
    label: systemDefault && systemDefault.name.trim() !== "" ? words.DEVICE_SYSTEM_NAMED(cutName(systemDefault.name, LABEL_MAX)) : words.DEVICE_SYSTEM,
    device: null,
    missing: false,
  };
  // Not listed yet, or the system hides the names: System default alone (goal 4.8).
  if (devices === null || hidden) return { show: "pick", options: [first], selected: SYSTEM_KEY, hiddenNote: hidden };
  const options: DeviceOption[] = [first];
  for (const d of devices) options.push({ key: `d:${d.id}`, label: cutName(d.name, LABEL_MAX), device: { id: d.id, name: d.name }, missing: false });
  let selected = SYSTEM_KEY;
  if (saved) {
    const found = matchSaved(saved, devices);
    if (found) selected = `d:${found.id}`;
    else {
      const key = `missing:${saved.id}`;
      options.push({ key, label: words.DEVICE_MISSING(cutName(saved.name.trim() === "" ? words.DEVICE_UNNAMED : saved.name, LABEL_MAX)), device: saved, missing: true });
      selected = key;
    }
  }
  return { show: "pick", options, selected, hiddenNote: false };
}

/** What the two pickers show. `list` null: not listed yet (`loading`, System default only). Where the platform lets voice choose a kind, a
 *  picker: System default first (with the system's own device where it is known), then every device of the kind, then the saved one if it
 *  is not listed ("(not connected)", selected). Where it does not, the line that says the system decides. With neither, one line. */
export function choicesFor(
  list: DeviceList | null,
  settings: { mic: SavedDevice | null; speaker: SavedDevice | null },
  ability: DeviceAbility,
): DeviceChoices {
  const hidden = list?.hidden ?? false;
  const mic = choiceFor(ability.input, list?.inputs ?? null, list?.defaults.input ?? null, hidden, settings.mic, words.MIC_FOLLOWS);
  const speaker = choiceFor(ability.output, list?.outputs ?? null, list?.defaults.output ?? null, hidden, settings.speaker, words.SPEAKER_FOLLOWS);
  const neither = ability.input === "system" && ability.output === "system";
  return {
    mic,
    speaker,
    linkedNote: ability.linked && ability.output === "pick",
    neitherLine: neither ? words.DEVICES_NEITHER : null,
    loading: list === null && !neither,
  };
}

const MEDIA_KIND: Record<DeviceKind, string> = { input: "audioinput", output: "audiooutput" };

/** The web port's helper: the entries of `enumerateDevices()` of one kind as devices. The pseudo-entries ("default", "communications") and
 *  the blank entries the browser lists before the microphone is allowed are left out; privacy is read from the name; nothing is built in. */
export function fromMediaDevices(entries: readonly { kind: string; deviceId: string; label: string }[], kind: DeviceKind): AudioDevice[] {
  const out: AudioDevice[] = [];
  for (const e of entries) {
    if (e.kind !== MEDIA_KIND[kind] || e.deviceId === "" || PSEUDO_IDS.includes(e.deviceId)) continue;
    out.push({ id: e.deviceId, name: e.label, kind, privacy: privacyOfName(e.label), builtIn: false });
  }
  return out;
}
