// The device side of the web audio port (voice-devices architecture VD-1, VD-2, VD-4, VD-6): what `enumerateDevices` says as a `DeviceList`,
// what the platform lets voice choose, and the device behind a capture track. It asks for no permission and opens nothing: listing is
// `enumerateDevices` alone. A device's name is never written to `console.*` here or anywhere in the port (goal 4.7).
import { fromMediaDevices, privacyOfName } from "../logic/devices.ts";
import type { AudioDevice, DeviceAbility, DeviceKind, DeviceList } from "../ports.ts";

/** What the player needs of an `AudioContext` that can choose its output (Chromium 110+; Safari and Firefox lack it). */
export type SinkContext = AudioContext & { setSinkId(id: string): Promise<void> };

export const mediaDevices = (): MediaDevices | undefined => (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;

type ContextClass = { prototype: { setSinkId?: unknown } };
const contextClass = (): ContextClass | undefined => {
  const g = globalThis as unknown as { AudioContext?: ContextClass; webkitAudioContext?: ContextClass };
  return g.AudioContext ?? g.webkitAudioContext;
};

/** What this page lets voice choose, fixed for the life of the port (platforms.md §1, §2): the microphone where the browser can list and open
 *  by id, the speaker where `AudioContext.prototype.setSinkId` exists. */
export function webAbility(): DeviceAbility {
  const md = mediaDevices();
  const canList = typeof md?.enumerateDevices === "function";
  return {
    input: canList && typeof md?.getUserMedia === "function" ? "pick" : "system",
    output: canList && typeof contextClass()?.prototype?.setSinkId === "function" ? "pick" : "system",
    linked: false,
  };
}

const KIND: Record<DeviceKind, string> = { input: "audioinput", output: "audiooutput" };
/** Chromium on macOS and Windows names the default entry "Default - <device>". */
const DEFAULT_PREFIX = /^default\s*[-–—:]\s*/i;

const EMPTY: DeviceList = { inputs: [], outputs: [], hidden: false, defaults: { input: null, output: null } };

/** What the "default" entry of one kind stands for: the real device of its group, or the one its label names, or (a label that does say a
 *  device but no listed one has it) a device made from the label. Nothing when the entry or its label does not say. */
function defaultOf(entries: readonly MediaDeviceInfo[], devices: readonly AudioDevice[], kind: DeviceKind): AudioDevice | null {
  const entry = entries.find((e) => e.kind === KIND[kind] && e.deviceId === "default");
  if (!entry) return null;
  const group = entry.groupId;
  if (group) {
    const twin = entries.find((e) => e.kind === KIND[kind] && e.groupId === group && e.deviceId !== "default" && e.deviceId !== "communications" && e.deviceId !== "");
    const device = twin ? devices.find((d) => d.id === twin.deviceId) : undefined;
    if (device) return device;
  }
  const name = entry.label.replace(DEFAULT_PREFIX, "").trim();
  if (name === "" || name.toLowerCase() === "default") return null;
  return devices.find((d) => d.name === name) ?? { id: "default", name, kind, privacy: privacyOfName(name), builtIn: false };
}

/** The devices now (VD-1). `hidden` when the browser withholds ids or names until the microphone is allowed: it lists one blank entry per kind
 *  then, and only System default can be offered. */
export async function listWebDevices(): Promise<DeviceList> {
  const md = mediaDevices();
  if (typeof md?.enumerateDevices !== "function") return { ...EMPTY, defaults: { input: null, output: null } };
  let entries: MediaDeviceInfo[];
  try { entries = await md.enumerateDevices(); } catch { return { ...EMPTY, defaults: { input: null, output: null } }; }
  const audio = entries.filter((e) => e.kind === "audioinput" || e.kind === "audiooutput");
  if (audio.some((e) => e.deviceId === "" || e.label === "")) {
    return { inputs: [], outputs: [], hidden: true, defaults: { input: null, output: null } };
  }
  const inputs = fromMediaDevices(audio, "input");
  const outputs = fromMediaDevices(audio, "output");
  return { inputs, outputs, hidden: false, defaults: { input: defaultOf(audio, inputs, "input"), output: defaultOf(audio, outputs, "output") } };
}

/** The device a capture track is on, as far as the track says: its id and its label. Null when it names nothing (a device that was never named
 *  is not announced by name). The default's "Default - " is dropped. */
export function deviceOfTrack(track: MediaStreamTrack | undefined): AudioDevice | null {
  const name = (track?.label ?? "").replace(DEFAULT_PREFIX, "").trim();
  if (name === "") return null;
  const id = track?.getSettings?.().deviceId ?? "";
  return { id, name, kind: "input", privacy: privacyOfName(name), builtIn: false };
}

const errorName = (e: unknown): string => {
  const n = (e as { name?: unknown } | null)?.name;
  return typeof n === "string" ? n : "";
};

/** Whether opening a device by id failed because the id is not a device now (as against: the person said no). */
export const notThere = (e: unknown): boolean => {
  const n = errorName(e);
  return n !== "NotAllowedError" && n !== "SecurityError";
};
