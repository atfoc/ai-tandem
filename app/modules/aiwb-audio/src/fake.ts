// `aiwb-audio` in JS, for the tests of the audio port (and nothing else). It keeps the rules of README.md that the port relies on: no
// chunk while muted or after stopMic, startMic refused without the permission, the player's queue of bytes and marks played in order
// and emptied by playerStop, an interruption that ends the microphone and the player. What the device does by itself (a chunk heard, the
// queue played, a call) is a function of the fake that the test calls: `hear`, `play`, `interrupt`. The devices (voice-devices VD-19 item 2) are
// the same idea: `plug`, `unplug` and `route` are what the person does with a headset, and `devices`, `defaultInput` and `defaultOutput` are
// what the system lists; the module's answers follow from them.
import { MIC_BLOCKED, type AiwbAudioEvents, type AiwbAudioModule, type MicPermission, type NativeDevice } from "./AiwbAudio.ts";

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
  /** The number of listeners of the audio events now (the three of the first contract). */
  listening(): Record<"onMic" | "onPlayer" | "onInterrupted", number>;
  /** The number of listeners of the device events now. */
  listeningDevices(): Record<"onDevices" | "onRoute", number>;

  /** The devices the system lists now, inputs and outputs (`listDevices` leaves the outputs out where `ability.output` is "system"). */
  devices: NativeDevice[];
  /** The ids of what the system uses when no device is chosen (null: none known). */
  defaultInput: string | null;
  defaultOutput: string | null;
  /** What `deviceAbility()` answers. */
  ability: { input: "pick" | "system"; output: "pick" | "system"; linked: boolean };
  /** What `setBuiltInNames` was last given. */
  builtInNames: { mic: string; speaker: string } | null;
  /** The ids `startMic` and `setOutput` were asked for, in order (null: the default). */
  micAsked: (string | null)[];
  outputAsked: (string | null)[];
  /** The device the microphone listens to / the player plays to now (null: none open, or the default is not known). */
  micDevice: NativeDevice | null;
  outputDevice: NativeDevice | null;
  /** The player was held (by `playerHold` or by a held loss) and not resumed. */
  held: boolean;
  /** When on, a lost microphone cannot be reopened on the default: `unplug` answers `input-failed` and the microphone is stopped. */
  failReopen: boolean;
  /** A device is plugged in: listed, and `onDevices` is emitted. */
  plug(d: NativeDevice): void;
  /** A device is removed: unlisted, `onDevices` emitted; the microphone or the player on it moves to the default and `onRoute` says so
   *  (an output that was private and goes to something not private is held, as the module does it). */
  unplug(id: string): void;
  /** The module reports a loss by itself (a route change the test makes up): `onRoute` is emitted as given. */
  route(e: Parameters<AiwbAudioEvents["onRoute"]>[0]): void;
};

const byId = (devices: NativeDevice[], id: string | null, kind: NativeDevice["kind"]): NativeDevice | null =>
  (id === null ? null : devices.find((d) => d.id === id && d.kind === kind)) ?? null;

export function createFakeAiwbAudio(): FakeAiwbAudio {
  const listeners: { [E in keyof AiwbAudioEvents]: Set<AiwbAudioEvents[E]> } = { onMic: new Set(), onPlayer: new Set(), onInterrupted: new Set(), onDevices: new Set(), onRoute: new Set() };
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
    startMic: async (chunkMs, echoCancel, inputId) => {
      fake.calls.push("startMic");
      fake.micAsked.push(inputId);
      if (fake.permission !== "granted") throw Object.assign(new Error("the microphone is not allowed"), { code: MIC_BLOCKED });
      fake.mic = { chunkMs, echoCancel: echoCancel && fake.echoAvailable, muted: false };
      // A device that is not listed any more, or none: the default. A kind the platform cannot pick: always the default.
      const asked = fake.ability.input === "pick" ? byId(fake.devices, inputId, "input") : null;
      fake.micDevice = asked ?? byId(fake.devices, fake.defaultInput, "input");
      return { echoCancel: fake.mic.echoCancel, device: fake.micDevice };
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
    playerStop: () => { fake.calls.push("playerStop"); fake.queued = []; carry = null; fake.held = false; },
    playClip: (bytes) => {
      fake.calls.push("playClip");
      stopClip();
      fake.clip = bytes;
      return new Promise<void>((resolve) => { clipDone = resolve; });
    },
    stopClip: () => { fake.calls.push("stopClip"); stopClip(); },
    openSettings: async () => { fake.calls.push("openSettings"); },
    listDevices: async () => {
      fake.calls.push("listDevices");
      const devices = fake.devices.filter((d) => d.kind === "input" || fake.ability.output === "pick");
      return { devices: devices.map((d) => ({ ...d })), defaultInput: fake.defaultInput, defaultOutput: fake.defaultOutput };
    },
    deviceAbility: () => { fake.calls.push("deviceAbility"); return { ...fake.ability }; },
    setBuiltInNames: (names) => { fake.calls.push("setBuiltInNames"); fake.builtInNames = { ...names }; },
    setOutput: async (outputId) => {
      fake.calls.push("setOutput");
      fake.outputAsked.push(outputId);
      const asked = fake.ability.output === "pick" ? byId(fake.devices, outputId, "output") : null;
      fake.outputDevice = asked ?? byId(fake.devices, fake.defaultOutput, "output");
      return { device: fake.outputDevice };
    },
    playerHold: () => { fake.calls.push("playerHold"); fake.held = true; },
    playerResume: () => { fake.calls.push("playerResume"); fake.held = false; },
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
      if (fake.held) return;   // a held player plays nothing until playerResume (or playerStop)
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
      fake.held = false;
      stopClip();
      emit("onInterrupted", { reason });
    },
    listening: () => ({ onMic: listeners.onMic.size, onPlayer: listeners.onPlayer.size, onInterrupted: listeners.onInterrupted.size }),
    listeningDevices: () => ({ onDevices: listeners.onDevices.size, onRoute: listeners.onRoute.size }),
    devices: [],
    defaultInput: null,
    defaultOutput: null,
    ability: { input: "pick", output: "pick", linked: false },
    builtInNames: null,
    micAsked: [],
    outputAsked: [],
    micDevice: null,
    outputDevice: null,
    held: false,
    failReopen: false,
    plug: (d) => {
      fake.devices.push({ ...d });
      emit("onDevices", {});
    },
    unplug: (id) => {
      const gone = fake.devices.find((d) => d.id === id);
      if (!gone) return;
      fake.devices = fake.devices.filter((d) => d.id !== id);
      if (fake.defaultInput === id) fake.defaultInput = fake.devices.find((d) => d.kind === "input")?.id ?? null;
      if (fake.defaultOutput === id) fake.defaultOutput = fake.devices.find((d) => d.kind === "output")?.id ?? null;
      emit("onDevices", {});
      if (gone.kind === "input" && fake.mic && fake.micDevice?.id === id) {
        if (fake.failReopen) {
          fake.mic = null;
          fake.micDevice = null;
          emit("onRoute", { kind: "input-failed", lost: gone, now: null, held: false });
        } else {
          fake.micDevice = byId(fake.devices, fake.defaultInput, "input");
          emit("onRoute", { kind: "input-lost", lost: gone, now: fake.micDevice, held: false });
        }
      }
      if (gone.kind === "output" && fake.outputDevice?.id === id) {
        const now = byId(fake.devices, fake.defaultOutput, "output");
        fake.outputDevice = now;
        const held = gone.privacy !== "public" && now?.privacy !== "private";   // as the modules decide it (architecture VD-11)
        if (held) fake.held = true;
        emit("onRoute", { kind: "output-lost", lost: gone, now, held });
      }
    },
    route: (e) => emit("onRoute", e),
  };
  return fake;
}
