// `aiwb-audio` in JS, for the tests of the audio port (and nothing else). It keeps the rules of README.md that the port relies on: no
// chunk while muted or after stopMic, startMic refused without the permission, the player's queue of bytes and marks played in order
// and emptied by playerStop, an interruption that ends the microphone and the player. What the device does by itself (a chunk heard, the
// queue played, a call) is a function of the fake that the test calls: `hear`, `play`, `interrupt`.
import { MIC_BLOCKED, type AiwbAudioEvents, type AiwbAudioModule, type MicPermission } from "./AiwbAudio.ts";

type Queued = { kind: "pcm"; bytes: Uint8Array } | { kind: "mark"; id: number };

export type FakeAiwbAudio = {
  module: AiwbAudioModule;
  /** The permission now; `requestMic` turns "undetermined" into `answer`. */
  permission: MicPermission;
  /** What the person answers when asked. */
  answer: "granted" | "denied";
  /** Whether the device has echo cancellation to give (`startMic`'s answer is `echoCancel && echoAvailable`). */
  echoAvailable: boolean;
  /** The microphone while it runs. */
  mic: { chunkMs: number; echoCancel: boolean; muted: boolean } | null;
  /** The player's queue, not played yet. */
  queued: Queued[];
  /** The PCM bytes the player was given, every whole sample, in order (an odd byte waits for the next write). */
  written: number[];
  /** The clip playing, if any. */
  clip: Uint8Array | null;
  /** The names of the functions called, in order. */
  calls: string[];
  /** The microphone heard `pcm` (base64): a chunk is emitted unless the microphone is off or muted. */
  hear(pcm: string, level: number): void;
  /** The device played the queue to its end: each mark is emitted when it is reached, a level for each piece, then `drained`. */
  play(): void;
  /** The clip played to its end. */
  endClip(): void;
  /** The system took the audio. */
  interrupt(reason: "call" | "route" | "other"): void;
  /** The number of listeners of each event now. */
  listening(): Record<keyof AiwbAudioEvents, number>;
};

export function createFakeAiwbAudio(): FakeAiwbAudio {
  const listeners: { [E in keyof AiwbAudioEvents]: Set<AiwbAudioEvents[E]> } = { onMic: new Set(), onPlayer: new Set(), onInterrupted: new Set() };
  const emit = <E extends keyof AiwbAudioEvents>(name: E, e: Parameters<AiwbAudioEvents[E]>[0]) => {
    for (const l of [...listeners[name]]) (l as (e: unknown) => void)(e);
  };
  let carry: number | null = null;
  let clipDone: (() => void) | null = null;
  const stopClip = () => { fake.clip = null; const d = clipDone; clipDone = null; d?.(); };

  const module: AiwbAudioModule = {
    micPermission: async () => { fake.calls.push("micPermission"); return fake.permission; },
    requestMic: async () => {
      fake.calls.push("requestMic");
      if (fake.permission === "undetermined") fake.permission = fake.answer;
      return fake.permission;
    },
    startMic: async (chunkMs, echoCancel) => {
      fake.calls.push("startMic");
      if (fake.permission !== "granted") throw Object.assign(new Error("the microphone is not allowed"), { code: MIC_BLOCKED });
      fake.mic = { chunkMs, echoCancel: echoCancel && fake.echoAvailable, muted: false };
      return { echoCancel: fake.mic.echoCancel };
    },
    setMicMuted: (muted) => { fake.calls.push(`setMicMuted:${muted}`); if (fake.mic) fake.mic.muted = muted; },
    stopMic: async () => { fake.calls.push("stopMic"); fake.mic = null; },
    playerWrite: (pcm) => {
      fake.calls.push("playerWrite");
      fake.queued.push({ kind: "pcm", bytes: pcm });
      const all = carry === null ? [...pcm] : [carry, ...pcm];
      carry = all.length % 2 ? all.pop()! : null;
      fake.written.push(...all);
    },
    playerMark: (id) => { fake.calls.push(`playerMark:${id}`); fake.queued.push({ kind: "mark", id }); },
    playerStop: () => { fake.calls.push("playerStop"); fake.queued = []; carry = null; },
    playClip: (bytes) => {
      fake.calls.push("playClip");
      stopClip();
      fake.clip = bytes;
      return new Promise<void>((resolve) => { clipDone = resolve; });
    },
    stopClip: () => { fake.calls.push("stopClip"); stopClip(); },
    openSettings: async () => { fake.calls.push("openSettings"); },
    addListener: (name, listener) => {
      (listeners[name] as Set<typeof listener>).add(listener);
      return { remove: () => { (listeners[name] as Set<typeof listener>).delete(listener); } };
    },
  };

  const fake: FakeAiwbAudio = {
    module,
    permission: "undetermined",
    answer: "granted",
    echoAvailable: true,
    mic: null,
    queued: [],
    written: [],
    clip: null,
    calls: [],
    hear: (pcm, level) => { if (fake.mic && !fake.mic.muted) emit("onMic", { pcm, level }); },
    play: () => {
      const q = fake.queued;
      fake.queued = [];
      if (q.length === 0) return;
      for (const item of q) {
        if (item.kind === "mark") emit("onPlayer", { kind: "mark", id: item.id });
        else emit("onPlayer", { kind: "level", level: 0.5 });
      }
      emit("onPlayer", { kind: "drained" });
    },
    endClip: stopClip,
    interrupt: (reason) => {
      fake.mic = null;
      fake.queued = [];
      carry = null;
      stopClip();
      emit("onInterrupted", { reason });
    },
    listening: () => ({ onMic: listeners.onMic.size, onPlayer: listeners.onPlayer.size, onInterrupted: listeners.onInterrupted.size }),
  };
  return fake;
}
