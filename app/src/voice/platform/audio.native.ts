// The audio port on iOS and Android (architecture VC-8): the microphone, the audio session and the PCM player of the app's own module
// `aiwb-audio`. The module is loaded on the first call that needs it, not when the port is made: bootstrap gives the ports and starts
// nothing (goal 3.9), and a person who never uses voice never loads it. `audioOver` takes the module (or the way to load it), so Node
// tests it over the module's fake; `audioNative()` below is the port of the app. The microphone's base64 goes to the listener as the module made
// it, and the player's bytes go to the module as they came: nothing here looks inside the audio.
import { MIC_BLOCKED, type AiwbAudioModule, type Subscription } from "../../../modules/aiwb-audio/src/AiwbAudio.ts";
import { VoiceProblemError, type AudioPort, type MicHandle, type PlayerEvent } from "../ports.ts";

/** The module, or the function that loads it (once, on first use). Null: a build made before the module. */
export type AudioModuleSource = AiwbAudioModule | null | (() => AiwbAudioModule | null);

const NOT_IN_BUILD = "voice: this build has no audio module";

/** The audio port over `source`. */
export function audioOver(source: AudioModuleSource): AudioPort {
  let loaded = false;
  let module: AiwbAudioModule | null = null;
  const subscriptions: Subscription[] = [];
  const playerListeners = new Set<(e: PlayerEvent) => void>();
  const interruptedListeners = new Set<() => void>();
  /** The microphone that runs now: its chunks go to `onChunk` until it is stopped. */
  let mic: { onChunk(b64: string, level: number): void; muted: boolean } | null = null;
  /** What the last `startMic` answered: the device cancels the echo of what it plays (VC-9). */
  let echoCancel = false;

  /** The module, loaded and listened to on the first call; null when the build has none. */
  const load = (): AiwbAudioModule | null => {
    if (loaded) return module;
    loaded = true;
    module = typeof source === "function" ? source() : source;
    if (module) {
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

  const startMic: AudioPort["startMic"] = async (o) => {
    const m = need();
    let permission = await m.micPermission();
    if (permission === "undetermined") permission = await m.requestMic();
    if (permission !== "granted") throw new VoiceProblemError("mic_blocked");
    if (mic) { mic = null; await m.stopMic(); } // one microphone at a time: a new start replaces the old one
    const own = { onChunk: o.onChunk, muted: false };
    mic = own;
    let answer: { echoCancel: boolean };
    try {
      answer = await m.startMic(o.chunkMs, o.echoCancel);
    } catch (err) {
      if (mic === own) mic = null;
      if ((err as { code?: unknown } | null)?.code === MIC_BLOCKED) throw new VoiceProblemError("mic_blocked");
      throw new Error("voice: the microphone did not start"); // the device's text is not passed on
    }
    echoCancel = answer.echoCancel;
    let stopped = false;
    const handle: MicHandle = {
      echoCancel: answer.echoCancel,
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
      on(f) {
        playerListeners.add(f);
        return () => { playerListeners.delete(f); };
      },
    },
    playClip,
    get voiceBargeIn() { return echoCancel; },
    get canOpenMicSettings() { return load() !== null; },
    async openMicSettings() { await need().openSettings(); },
    onInterrupted(f) {
      interruptedListeners.add(f);
      return () => { interruptedListeners.delete(f); };
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
