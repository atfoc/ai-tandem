// The stores of voice (architecture §3.1, VC-14): the session, the problem on show, the message being read, the Settings dialog's
// open flag and the stored settings. Each is a small store with `subscribe`, read by the hooks of `../index.ts` and by the engine
// alike, so a change made anywhere shows at once everywhere (goal 4.6). Nothing here reaches the network, the key or the microphone;
// the settings are read from the kv port when first asked for, not at start-up.
import { safeGet, safeSet } from "@aiwb/core/state/store.ts";
import { clampSettings, parseSettings, SETTINGS_KEY, sameSettings, stringifySettings } from "../logic/settings.ts";
import type { VoiceSettings } from "../logic/settings.ts";
import type { VoiceNotice } from "../logic/devices.ts";
import { voicePorts } from "../ports.ts";
import type { ReadingState, SessionState, VoiceProblem } from "../index.ts";

export type Store<T> = { get(): T; set(next: T): void; subscribe(f: () => void): () => void };

/** A store: `init` makes the first value when it is first read. A `set` of the same value (by identity) tells nobody. */
export function createStore<T>(init: () => T): Store<T> {
  let value: T;
  let made = false;
  const listeners = new Set<() => void>();
  return {
    get() {
      if (!made) { value = init(); made = true; }
      return value;
    },
    set(next) {
      if (made && Object.is(value, next)) return;
      value = next;
      made = true;
      for (const f of [...listeners]) f();
    },
    subscribe(f) {
      listeners.add(f);
      return () => { listeners.delete(f); };
    },
  };
}

export const IDLE_SESSION: SessionState = {
  owner: null, phase: "idle", committed: "", partial: "", level: 0, muted: false, countdown: null, spoken: "", target: null, paused: null,
};
export const NOT_READING: ReadingState = { key: null, paused: false };

export const sessionStore = createStore<SessionState>(() => IDLE_SESSION);
export const problemStore = createStore<VoiceProblem | null>(() => null);
export const readingStore = createStore<ReadingState>(() => NOT_READING);
export const settingsOpenStore = createStore<boolean>(() => false);
/** The one notice on show (voice-devices VD-13): a device was missing at a start, or was lost during a session. */
export const noticeStore = createStore<VoiceNotice | null>(() => null);

/** The timer of the notice (the tests give their own, driven by their clock, as `sessionDeps` is). */
export const noticeDeps = {
  setTimer: (f: () => void, ms: number): unknown => setTimeout(f, ms),
  clearTimer: (h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const NOTICE_DEPS_AT_START = { ...noticeDeps };
let noticeTimer: unknown = null;
/** Whoever made the notice on show (a route of `devices.ts`): when it ends, its notice goes with it. */
let noticeOwner: unknown = null;

function dropNoticeTimer(): void {
  if (noticeTimer === null) return;
  noticeDeps.clearTimer(noticeTimer);
  noticeTimer = null;
}

/** Shows a notice (VD-13) in place of the one on show. It stays `waits.noticeMs`, or until `endNotice(owner)`; `sticky` stays until then only
 *  (the pause's own sentence). The text is never logged. */
export function showNotice(text: string, where: VoiceNotice["where"], owner: unknown, o: { sticky?: boolean } = {}): void {
  dropNoticeTimer();
  noticeOwner = owner;
  noticeStore.set({ text, where, at: voicePorts().now() });
  if (o.sticky) return;
  noticeTimer = noticeDeps.setTimer(() => {
    noticeTimer = null;
    noticeOwner = null;
    noticeStore.set(null);
  }, waits.noticeMs);
}

/** Takes the notice away when `owner` made it: its session or utterance ended, or the pause it spoke of did. */
export function endNotice(owner: unknown): void {
  if (noticeOwner !== owner) return;
  dropNoticeTimer();
  noticeOwner = null;
  noticeStore.set(null);
}

const readSettings = (): VoiceSettings => parseSettings(safeGet(SETTINGS_KEY));
/** The stored settings: one value for Settings, the speech bar and the pill (goal 4.6). */
export const settingsStore = createStore<VoiceSettings>(readSettings);

export const getSettings = (): VoiceSettings => settingsStore.get();

/** Changes some settings: the result is clamped, kept in the kv port and told to every subscriber. A patch that changes nothing tells nobody. */
export function updateSettings(patch: Partial<VoiceSettings>): void {
  const cur = settingsStore.get();
  const next = clampSettings({ ...cur, ...patch });
  if (sameSettings(next, cur)) return;
  safeSet(SETTINGS_KEY, stringifySettings(next)); // a storage that refuses: the settings hold for this run
  settingsStore.set(next);
}

/** Shows a problem (the popover of VC-30). The key is never in it: a problem names a kind, the control that was tapped and a retry. */
export function showProblem(p: VoiceProblem): void { problemStore.set(p); }
export function dismissProblem(): void { problemStore.set(null); }

/** The waits of the engine, lowered by the tests (a field to change, as the repository's rule asks); the production values stay. */
export const waits = {
  /** A voice-service call (Test key, the voices) that has not answered by then is "can't reach". */
  callMs: 15_000,
  /** A TTS request whose answer (not its body) has not come by then is "can't reach". */
  answerMs: 15_000,
  /** How long a notice stays on show (voice-devices VD-13), unless its session or utterance ends first. */
  noticeMs: 6000,
};
const WAITS_AT_START = { ...waits };

/** What the checks set through `window.__aiwbVoice` (VC-32); the listener (P11) reads `denyMic` before it asks the microphone. */
export const flags = { denyMic: false };

const resets: (() => void)[] = [];
/** A module with state of its own (the player, the speaker, a cache) registers how to put it back, for `resetEngine`. */
export function onReset(f: () => void): void { resets.push(f); }

/** Puts the engine back as a fresh start: for the tests (each makes its own ports and starts from here). Not used by the app. */
export function resetEngine(): void {
  for (const f of resets) f();
  sessionStore.set(IDLE_SESSION);
  problemStore.set(null);
  readingStore.set(NOT_READING);
  settingsOpenStore.set(false);
  dropNoticeTimer();
  noticeOwner = null;
  noticeStore.set(null);
  Object.assign(noticeDeps, NOTICE_DEPS_AT_START);
  settingsStore.set(readSettings());
  Object.assign(waits, WAITS_AT_START);
  flags.denyMic = false;
}
