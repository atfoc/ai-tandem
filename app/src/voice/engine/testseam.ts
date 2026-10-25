// The seam of the browser checks (architecture VC-32): in a build made for the checks (version "uicheck", as `__aiwbView`), the page
// has `window.__aiwbVoice`, which shows the engine's state and the player's counts and lets a check deny the microphone or set and clear
// the key without the screens. No other build has it. `installSeam` is what the module runs on load; the tests call it with their own
// target.
import { voicePorts } from "../ports.ts";
import { player } from "./player.ts";
import type { PlayerStats } from "./player.ts";
import { flags, getSettings, noticeStore, problemStore, readingStore, sessionStore, settingsOpenStore, updateSettings } from "./state.ts";
import type { VoiceSettings } from "../logic/settings.ts";

export type VoiceSeam = {
  state(): { session: ReturnType<typeof sessionStore.get>; problem: ReturnType<typeof problemStore.get>; reading: ReturnType<typeof readingStore.get>; settingsOpen: boolean };
  settings(): ReturnType<typeof getSettings>;
  /** Changes some settings as Settings does (`setVoiceSettings`): clamped, kept and told to every subscriber. */
  setSettings(patch: Partial<VoiceSettings>): void;
  /** The notice on show (voice-devices VD-13), with the place that shows it; null when none. (`state()` has `session.paused` and `reading.paused`.) */
  notice(): ReturnType<typeof noticeStore.get>;
  /** What was written to the player, how many marks, the time of the first write and how many stops. */
  player(): PlayerStats;
  denyMic(on: boolean): void;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
};

export const seam: VoiceSeam = {
  state: () => ({ session: sessionStore.get(), problem: problemStore.get(), reading: readingStore.get(), settingsOpen: settingsOpenStore.get() }),
  settings: () => getSettings(),
  setSettings: (patch) => updateSettings(patch),
  notice: () => noticeStore.get(),
  player: () => player.stats(),
  denyMic(on) { flags.denyMic = on; },
  setKey: (key) => voicePorts().keystore.set(key),
  clearKey: () => voicePorts().keystore.clear(),
};

export function installSeam(target: { __aiwbVoice?: VoiceSeam }): void { target.__aiwbVoice = seam; }

if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") installSeam(window as unknown as { __aiwbVoice?: VoiceSeam });
