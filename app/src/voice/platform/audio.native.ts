// The audio port on iOS and Android (architecture VC-8): the microphone, the audio session and the PCM player of the app's own module
// `aiwb-audio`. The module is loaded on the first call that needs it, not when the port is made: bootstrap gives the ports and starts
// nothing (goal 3.9), and a person who never uses voice never loads it. `audioOver` takes the module (or the way to load it), so Node
// tests it over the module's fake; `audioNative()` below is the port of the app. The microphone's base64 goes to the listener as the module made
// it, and the player's bytes go to the module as they came: nothing here looks inside the audio. Devices (voice-devices VD-2, VD-18): the
// adapter lists, finds the saved device again with `matchSaved` and passes the module an id; the module answers the device it got, and
// the adapter compares to tell `missed`. A device's name is never written to a log.
import { MIC_BLOCKED, type AiwbAudioModule, type NativeDevice, type Subscription } from "../../../modules/aiwb-audio/src/AiwbAudio.ts";
import { PSEUDO_IDS, matchSaved } from "../logic/devices.ts";
import {
  VoiceProblemError,
  type AudioDevice,
  type AudioPort,
  type DeviceAbility,
  type DeviceKind,
  type DeviceList,
  type MicHandle,
  type Opened,
  type PlayerEvent,
  type RouteEvent,
  type SavedDevice,
} from "../ports.ts";
import { BUILTIN_MIC_NAME, BUILTIN_SPEAKER_NAME } from "../words.ts";

/** The module, or the function that loads it (once, on first use). Null: a build made before the module. */
export type AudioModuleSource = AiwbAudioModule | null | (() => AiwbAudioModule | null);

const NOT_IN_BUILD = "voice: this build has no audio module";

/** What a build without the module lets voice choose: nothing. */
const SYSTEM_ABILITY: DeviceAbility = { input: "system", output: "system", linked: false };

/** The module's device as the port's: the five fields, nothing the module may add. */
const toDevice = (d: NativeDevice | null): AudioDevice | null =>
  d && { id: d.id, name: d.name, kind: d.kind, privacy: d.privacy, builtIn: d.builtIn };

/** A saved device looked for in a fresh listing: `id` is what the module is asked for (null: the default), `found` the device it stands for. */
type Wanted = { id: string | null; found: AudioDevice | null };

/** What a start got, against what was asked (goal 3.3): `missed` when a saved device was asked for and the module did not give that one. */
function openedFor(saved: SavedDevice | null, wanted: Wanted | null, got: NativeDevice | null): Opened {
  if (!saved || !wanted) return { device: toDevice(got), missed: false };
  const missed = wanted.id === null || (got !== null && got.id !== wanted.id);
  return { device: toDevice(got) ?? (missed ? null : wanted.found), missed };
}

/** The audio port over `source`. */
export function audioOver(source: AudioModuleSource): AudioPort {
  let loaded = false;
  let module: AiwbAudioModule | null = null;
  const subscriptions: Subscription[] = [];
  const playerListeners = new Set<(e: PlayerEvent) => void>();
  const interruptedListeners = new Set<() => void>();
  const deviceWatchers = new Set<() => void>();
  const routeListeners = new Set<(e: RouteEvent) => void>();
  /** `deviceAbility()`, asked once: it is a constant of the build and the system. */
  let ability: DeviceAbility | null = null;
  /** Whether the player was ever given a saved output: until then the default needs no call (goal 3.5: nothing changes for a person who never chose). */
  let outputChosen = false;
  /** The microphone that runs now: its chunks go to `onChunk` until it is stopped. */
  let mic: { onChunk(b64: string, level: number): void; muted: boolean } | null = null;

  /** The module, loaded and listened to on the first call; null when the build has none. */
  const load = (): AiwbAudioModule | null => {
    if (loaded) return module;
    loaded = true;
    module = typeof source === "function" ? source() : source;
    if (module) {
      module.setBuiltInNames({ mic: BUILTIN_MIC_NAME, speaker: BUILTIN_SPEAKER_NAME });
      subscriptions.push(
        module.addListener("onMic", (e) => {
          const m = mic;
          if (m && !m.muted) m.onChunk(e.pcm, e.level); // a chunk the native side sent before the mute or the stop reached it is dropped here
        }),
        module.addListener("onPlayer", (e) => {
          for (const f of [...playerListeners]) {
            try { f(e); } catch (err) { console.error("a player listener threw", err); }
          }
        }),
        module.addListener("onInterrupted", () => {
          mic = null; // the module has stopped the microphone and the player
          for (const f of [...interruptedListeners]) {
            try { f(); } catch (err) { console.error("an interruption listener threw", err); }
          }
        }),
        module.addListener("onDevices", () => {
          for (const f of [...deviceWatchers]) {
            try { f(); } catch (err) { console.error("a device watcher threw", err); }
          }
        }),
        module.addListener("onRoute", (e) => {
          const event: RouteEvent =
            e.kind === "input-lost" ? { kind: e.kind, lost: toDevice(e.lost), now: toDevice(e.now) }
            : e.kind === "input-failed" ? { kind: e.kind, lost: toDevice(e.lost) }
            : { kind: e.kind, lost: toDevice(e.lost), now: toDevice(e.now), held: e.held };
          if (e.kind === "input-failed") mic = null; // the module has stopped the microphone
          for (const f of [...routeListeners]) {
            try { f(event); } catch (err) { console.error("a route listener threw", err); }
          }
        }),
      );
    }
    return module;
  };
  const need = (): AiwbAudioModule => {
    const m = load();
    if (!m) throw new Error(NOT_IN_BUILD);
    return m;
  };

  const micPermission = async () => need().micPermission();

  /** What the platform lets voice choose (VD-1): asked of the module once; a build without it chooses nothing. */
  const deviceAbility = (): DeviceAbility => (ability ??= load()?.deviceAbility() ?? SYSTEM_ABILITY);

  /** `saved` among the devices of `kind` now (VD-2). A listing that fails is not a missing device: the module is asked for the saved id itself
   *  and its answer tells whether it was there. */
  const find = async (m: AiwbAudioModule, kind: DeviceKind, saved: SavedDevice): Promise<Wanted> => {
    let listed: Awaited<ReturnType<AiwbAudioModule["listDevices"]>>;
    try {
      listed = await m.listDevices();
    } catch {
      return { id: saved.id, found: null };
    }
    const found = matchSaved(saved, listed.devices.filter((d) => d.kind === kind && !PSEUDO_IDS.includes(d.id)).map((d) => toDevice(d)!));
    return { id: found?.id ?? null, found };
  };

  const list = async (): Promise<DeviceList> => {
    const m = load();
    if (!m || deviceAbility().input === "system" && deviceAbility().output === "system") {
      // Nothing to choose: nothing to list, and the module is not asked (it may not list at all).
      return { inputs: [], outputs: [], hidden: false, defaults: { input: null, output: null } };
    }
    const listed = await m.listDevices();
    const all = listed.devices.filter((d) => !PSEUDO_IDS.includes(d.id)).map((d) => toDevice(d)!);
    const inputs = all.filter((d) => d.kind === "input");
    const outputs = all.filter((d) => d.kind === "output");
    return {
      inputs,
      outputs,
      hidden: false,
      defaults: {
        input: inputs.find((d) => d.id === listed.defaultInput) ?? null,
        output: outputs.find((d) => d.id === listed.defaultOutput) ?? null,
      },
    };
  };

  const startMic: AudioPort["startMic"] = async (o) => {
    const m = need();
    let permission = await m.micPermission();
    if (permission === "undetermined") permission = await m.requestMic();
    if (permission !== "granted") throw new VoiceProblemError("mic_blocked");
    // A saved microphone is looked for in a fresh list (VD-6 b); with none saved, or where the platform picks no input, nothing is listed.
    const saved = o.device !== null && deviceAbility().input === "pick" ? o.device : null;
    const wanted = saved && (await find(m, "input", saved));
    if (mic) { mic = null; await m.stopMic(); } // one microphone at a time: a new start replaces the old one
    const own = { onChunk: o.onChunk, muted: false };
    mic = own;
    let answer: { echoCancel: boolean; device: NativeDevice | null };
    try {
      answer = await m.startMic(o.chunkMs, o.echoCancel, wanted?.id ?? null);
    } catch (err) {
      if (mic === own) mic = null;
      if ((err as { code?: unknown } | null)?.code === MIC_BLOCKED) throw new VoiceProblemError("mic_blocked");
      throw new Error("voice: the microphone did not start"); // the device's text is not passed on
    }
    let stopped = false;
    const handle: MicHandle = {
      echoCancel: answer.echoCancel,
      opened: openedFor(saved, wanted, answer.device),
      mute(on) {
        if (stopped || mic !== own) return;
        own.muted = on;
        m.setMicMuted(on);
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        if (mic !== own) return; // replaced by a newer start, or ended by an interruption
        mic = null;
        await m.stopMic();
      },
    };
    return handle;
  };

  const useOutput: AudioPort["player"]["useOutput"] = async (d) => {
    const m = load();
    if (!m || deviceAbility().output === "system") return { device: null, missed: false }; // the system decides: nothing is asked of it
    if (d === null && !outputChosen) return { device: null, missed: false };                // the default it already has
    const wanted = d && (await find(m, "output", d));
    outputChosen = d !== null;
    let got: NativeDevice | null = null;
    try {
      got = (await m.setOutput(wanted?.id ?? null)).device;
    } catch {
      throw new Error("voice: the output could not be changed"); // the device's text is not passed on
    }
    return openedFor(d, wanted, got);
  };

  const playClip: AudioPort["playClip"] = async (bytes, signal) => {
    const m = need();
    if (signal.aborted) return;
    const stop = () => m.stopClip();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await m.playClip(bytes);
    } catch {
      throw new Error("voice: the clip could not be played");
    } finally {
      signal.removeEventListener("abort", stop);
    }
  };

  return {
    micPermission,
    startMic,
    player: {
      write(pcm) { need().playerWrite(pcm); },
      mark(id) { need().playerMark(id); },
      stop() { if (loaded) module?.playerStop(); }, // never loaded: nothing can be playing
      useOutput,
      hold() { if (loaded) module?.playerHold(); },     // never loaded: nothing can be playing
      resume() { if (loaded) module?.playerResume(); },
      on(f) {
        playerListeners.add(f);
        return () => { playerListeners.delete(f); };
      },
    },
    playClip,
    get canOpenMicSettings() { return load() !== null; },
    async openMicSettings() { await need().openSettings(); },
    onInterrupted(f) {
      interruptedListeners.add(f);
      return () => { interruptedListeners.delete(f); };
    },
    devices: {
      get ability() { return deviceAbility(); },
      list,
      watch(f) {
        load(); // the events of the module flow only once it is loaded
        deviceWatchers.add(f);
        return () => { deviceWatchers.delete(f); };
      },
    },
    onRoute(f) {
      routeListeners.add(f);
      return () => { routeListeners.delete(f); };
    },
  };
}

let port: AudioPort | null = null;

/** The app's audio port on iOS and Android (as `audioWeb()` is on the web): one for the app, over the native module, which it loads on first
 *  use. Making it starts nothing. */
export function audioNative(): AudioPort {
  port ??= audioOver(
    () => (require("../../../modules/aiwb-audio/src/AiwbAudioModule.ts") as typeof import("../../../modules/aiwb-audio/src/AiwbAudioModule.ts")).default,
  );
  return port;
}
