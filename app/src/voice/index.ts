// The public face of voice (architecture §3.1): the controller `voice`, the hooks and the types. The screens import from here and from
// nothing below it; the work is done in `engine/`. The three starts never reject: a start that cannot go on shows the popover (the
// problem's store) and leaves the session idle. The void methods never throw.
import { useRef, useSyncExternalStore } from "react";
import type { VoiceProblemKind } from "./ports.ts";
import type { VoiceSettings } from "./logic/settings.ts";
import { hasKey, playPreview, removeKey, setKey, testKey, voices } from "./engine/keycheck.ts";
import { readAloud, stopReading } from "./engine/speaker.ts";
import { cancelCountdown, endSession, interrupt, mute, send, startDictation, startPill, startSpeech } from "./engine/session.ts";
import { marksStore, spokenMark, watchMarks } from "./engine/marks.ts";
import {
  dismissProblem, problemStore, readingStore, sessionStore, settingsOpenStore, settingsStore, updateSettings,
} from "./engine/state.ts";
import "./engine/testseam.ts";

export type { VoiceProblemKind } from "./ports.ts";
export type VoiceProblem = { kind: VoiceProblemKind; /** where the popover hangs: the control that was tapped */ anchor: string; retry?: () => void };

export type SessionOwner =
  | { kind: "dictation"; chat: string; branch: string }
  | { kind: "speech"; chat: string; branch: string }
  | { kind: "pill"; board: string };

export type Phase =
  | "idle" | "starting"          // asking for the mic / opening the socket
  | "listening"                  // words may come; no countdown
  | "countdown"                  // Auto-send: the pause ran, the turn goes when it ends (Cancel stops it)
  | "waiting"                    // Tap to send: words wait for Send (the ↑ badge)
  | "sending" | "thinking"       // the turn is on its way / the agent works and nothing is spoken yet
  | "speaking";                  // the reply is being spoken

export type SessionState = {
  owner: SessionOwner | null;
  phase: Phase;
  committed: string;             // finished words of the turn
  partial: string;               // the live guess
  level: number;                 // 0..1, the mic's while listening, the player's while speaking (the waveform, the orb's ring)
  muted: boolean;
  countdown: { startedAt: number; ms: number } | null;
  spoken: string;                // the sentence being spoken (speech bar, captions)
  target: string | null;         // pill: the chat the turn goes to
};

export type ReadingState = { key: string | null };   // "read:<chat>:<branch>:<index>" of the message being read

/** The stored voice settings (architecture VC-14); `logic/settings.ts` owns the type, its defaults and its clamping. */
export type { VoiceSettings } from "./logic/settings.ts";
export type { VoiceInfo, VoiceList } from "./logic/protocol.ts";
import type { VoiceList } from "./logic/protocol.ts";

export type DictationSink = {
  /** The box's text is base + committed + partial: called on every change; the composer puts it into the box. */
  show(text: { committed: string; partial: string }): void;
  /** Dictation ended; `committed` is final. */
  done(committed: string): void;
};

export const voice: {
  startDictation(o: { chat: string; branch: string; anchor: string; sink: DictationSink }): Promise<void>;
  /** send: the composer's `sendMessage(chat, text)` (VC-21); the engine imports no screen. */
  startSpeech(o: { chat: string; branch: string; anchor: string; send(text: string): Promise<unknown> }): Promise<void>;
  /** target: the chat the turn goes to, made by `newChat({board}, {open: false})` when the board has none (VC-29);
   *  send: `sendMessage(chat, text)` with the selection's tag before the words when the chip is on (VC-28). */
  startPill(o: { board: string; anchor: string; target(): Promise<string | null>; send(chat: string, text: string): Promise<unknown> }): Promise<void>;
  end(): void;                   // End: stops listening and speaking, closes the socket
  mute(on: boolean): void;       // Mute: no audio is sent; the socket stays
  send(): void;                  // Send / the ↑ badge
  cancelCountdown(): void;       // Cancel: keeps the words, no send
  interrupt(): void;             // tap barge-in: stops speaking, back to listening
  readAloud(o: { chat: string; branch: string; index: number; text: string; anchor: string }): Promise<void>;
  stopReading(): void;
  testKey(key?: string): Promise<{ ok: true; voices: number } | { ok: false; problem: VoiceProblemKind }>;
  hasKey(): Promise<boolean>;
  setKey(key: string): Promise<void>;
  removeKey(): Promise<void>;
  voices(o?: { all?: boolean; search?: string; cursor?: string }): Promise<VoiceList>;
  playPreview(voiceId: string): Promise<void>;
  dismissProblem(): void;
} = {
  startDictation,
  startSpeech,
  startPill,
  end: endSession,
  mute,
  send,
  cancelCountdown,
  interrupt,
  readAloud,
  stopReading,
  testKey,
  hasKey,
  setKey,
  removeKey,
  voices,
  playPreview,
  dismissProblem,
};

/** The session, or a part of it. A selector that answers a value equal (`Object.is`) to the last one does not re-render: select the
 *  fields a screen draws (the level changes ten times a second while listening). */
export function useVoiceSession<T>(select: (s: SessionState) => T): T {
  const last = useRef<{ s: SessionState; f: (s: SessionState) => T; v: T } | null>(null);
  const get = (): T => {
    const s = sessionStore.get();
    const l = last.current;
    if (l && l.s === s && l.f === select) return l.v;
    const v = select(s);
    const kept = l && Object.is(l.v, v) ? l.v : v;
    last.current = { s, f: select, v: kept };
    return kept;
  };
  return useSyncExternalStore(sessionStore.subscribe, get, get);
}
/** The settings, or a part of them: `select` may build a new value, the hook re-renders on any change of the settings. */
export function useVoiceSettings<T>(select: (s: VoiceSettings) => T): T {
  return select(useSyncExternalStore(settingsStore.subscribe, settingsStore.get, settingsStore.get));
}
/** Changes some settings: clamped, kept in the kv port, seen at once by every place that shows them (goal 4.6). */
export function setVoiceSettings(patch: Partial<VoiceSettings>): void { updateSettings(patch); }
export function useVoiceProblem(): VoiceProblem | null {
  return useSyncExternalStore(problemStore.subscribe, problemStore.get, problemStore.get);
}
export function useReading(): ReadingState {
  return useSyncExternalStore(readingStore.subscribe, readingStore.get, readingStore.get);
}
/** Whether the user message at `index` of the branch was sent by voice from this device (the mic mark, VC-23). */
export function useSpokenMark(chat: string, branch: string, index: number): boolean {
  const get = () => spokenMark(chat, branch, index);
  return useSyncExternalStore(subscribeMarks, get, get);
}
const subscribeMarks = (f: () => void): (() => void) => {
  watchMarks();
  return marksStore.subscribe(f);
};

/** Settings > Voice (VC-13): the dialog shows itself from this flag. `openVoiceSettings` is what the popover's Open Settings does. */
export function openVoiceSettings(): void { settingsOpenStore.set(true); }
export function closeVoiceSettings(): void { settingsOpenStore.set(false); }
export function useVoiceSettingsOpen(): boolean {
  return useSyncExternalStore(settingsOpenStore.subscribe, settingsOpenStore.get, settingsOpenStore.get);
}
