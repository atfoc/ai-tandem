// The audio port on the web build and in the desktop window (architecture VC-10), over Web Audio. The microphone is `getUserMedia` into a
// `ScriptProcessorNode` (not an AudioWorklet: its module would load from a `file://` page under `script-src 'self'`, which Electron does not
// promise), cut into chunks of 16 kHz s16le by `logic/pcm.ts`. The player is one `AudioContext` at 24 kHz that starts each written piece where
// the last one ends, so there is no gap. Nothing is made until the person's tap: the factory builds no context, asks for no microphone.
import { VoiceProblemError, type AudioPort, type MicHandle, type PcmPlayer, type PlayerEvent } from "../ports.ts";
import { MicChunker, PcmDecoder, rms } from "../logic/pcm.ts";
import type { VoiceWindow } from "./bridge.types.ts";

const PLAYER_RATE = 24000;
const LEAD = 0.03;           // seconds between a write on an idle player and the first sound: time to hand the buffer to the audio thread
const TICK_MS = 40;          // how often the player looks at its marks, its level and whether it is drained
const SCRIPT_BLOCK = 4096;

type Ctor = typeof AudioContext;

const contextClass = (): Ctor => {
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const c = g.AudioContext ?? g.webkitAudioContext;
  if (!c) throw new VoiceProblemError("mic_blocked");
  return c;
};

/** The desktop app's voice face, where the page runs in it (VC-5). */
const desktop = () => (globalThis as unknown as VoiceWindow).aiwbVoice;

const refused = (e: unknown): boolean => {
  const name = (e as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "SecurityError";
};

type Mark = { id: number; at: number };

function createPlayer(): PcmPlayer & { playClip(bytes: Uint8Array, signal: AbortSignal): Promise<void> } {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let cursor = 0;                                   // where, on the context's clock, the next written piece starts at the earliest
  let active = false;                               // something was written and the queue has not run out yet
  let timer: ReturnType<typeof setInterval> | null = null;
  const sources = new Set<AudioBufferSourceNode>();
  let marks: Mark[] = [];                           // marks that have their time
  let waiting: number[] = [];                       // marks that take the start of the next write
  const decoder = new PcmDecoder();
  const listeners = new Set<(e: PlayerEvent) => void>();
  let stopClip: (() => void) | null = null;

  const emit = (e: PlayerEvent): void => { for (const f of [...listeners]) f(e); };

  // The context is made at the first sound, which follows a tap, so the browser lets it play.
  const context = (): AudioContext => {
    if (!ctx) {
      const C = contextClass();
      ctx = new C({ sampleRate: PLAYER_RATE });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };

  const stopTimer = (): void => { if (timer !== null) { clearInterval(timer); timer = null; } };

  const level = (): number => {
    if (!analyser) return 0;
    const block = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(block);
    return rms(block);
  };

  const tick = (): void => {
    if (!ctx) return;
    const now = ctx.currentTime;
    while (marks.length > 0 && marks[0]!.at <= now) emit({ kind: "mark", id: marks.shift()!.id });
    if (cursor <= now) {
      // The queue ran out. A mark made at its end, with nothing written after it, is reached now.
      for (const id of waiting.splice(0)) emit({ kind: "mark", id });
      active = false;
      stopTimer();
      emit({ kind: "level", level: 0 });
      emit({ kind: "drained" });
      return;
    }
    emit({ kind: "level", level: level() });
  };

  return {
    write(pcm) {
      const floats = decoder.push(pcm);
      if (floats.length === 0) return;
      const c = context();
      const buffer = c.createBuffer(1, floats.length, PLAYER_RATE);
      buffer.copyToChannel(floats as Float32Array<ArrayBuffer>, 0);
      const source = c.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser!);
      const start = Math.max(c.currentTime + LEAD, cursor);
      source.start(start);
      cursor = start + buffer.duration;
      for (const id of waiting.splice(0)) marks.push({ id, at: start });
      sources.add(source);
      source.onended = () => { sources.delete(source); };
      active = true;
      if (timer === null) timer = setInterval(tick, TICK_MS);
    },
    mark(id) { waiting.push(id); },
    stop() {
      for (const s of sources) {
        s.onended = null;
        try { s.stop(); } catch { /* it had not started */ }
        s.disconnect();
      }
      sources.clear();
      marks = [];
      waiting = [];
      cursor = 0;
      decoder.reset();
      stopTimer();
      if (active) emit({ kind: "level", level: 0 });
      active = false;
      stopClip?.();
    },
    on(f) {
      listeners.add(f);
      return () => { listeners.delete(f); };
    },
    async playClip(bytes, signal) {
      if (signal.aborted) return;
      stopClip?.();
      const c = context();
      // `decodeAudioData` takes the buffer it is given, so it gets a copy.
      const decoded = await c.decodeAudioData(bytes.slice().buffer);
      if (signal.aborted) return;
      stopClip?.();
      const source = c.createBufferSource();
      source.buffer = decoded;
      source.connect(c.destination);
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          signal.removeEventListener("abort", finish);
          source.onended = null;
          try { source.stop(); } catch { /* it had ended */ }
          source.disconnect();
          if (stopClip === finish) stopClip = null;
          resolve();
        };
        stopClip = finish;
        source.onended = finish;
        signal.addEventListener("abort", finish);
        source.start();
      });
    },
  };
}

async function permission(): Promise<"granted" | "denied" | "undetermined"> {
  const d = desktop();
  try {
    if (d) {
      const s = await d.mic.status();
      return s === "granted" ? "granted" : s === "undetermined" ? "undetermined" : "denied";
    }
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted" ? "granted" : status.state === "denied" ? "denied" : "undetermined";
  } catch {
    return "undetermined";     // a browser without the permissions query for the microphone (Safari)
  }
}

export function audioWeb(): AudioPort {
  const player = createPlayer();
  const interrupted = new Set<() => void>();
  const interrupt = (): void => { for (const f of [...interrupted]) f(); };

  return {
    micPermission: permission,
    async startMic(o) {
      const d = desktop();
      if (d) {
        // The macOS prompt belongs to the app, not to the page: ask it first, so `getUserMedia` finds the answer.
        let granted = false;
        try { granted = await d.mic.ask(); } catch { granted = false; }
        if (!granted) throw new VoiceProblemError("mic_blocked");
      }
      const devices = (globalThis as { navigator?: Navigator }).navigator?.mediaDevices;
      if (!devices?.getUserMedia) throw new VoiceProblemError("mic_blocked");   // a page that is not secure has none
      let stream: MediaStream;
      try {
        stream = await devices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
      } catch (e) {
        throw refused(e) ? new VoiceProblemError("mic_blocked") : e;
      }
      const track = stream.getAudioTracks()[0];
      let ctx: AudioContext | null = null;
      try {
        const C = contextClass();
        ctx = new C();
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(SCRIPT_BLOCK, 1, 1);
        const chunker = new MicChunker(ctx.sampleRate, o.chunkMs);
        let muted = false;
        let stopped = false;
        processor.onaudioprocess = (ev) => {
          if (muted || stopped) return;
          for (const c of chunker.push(ev.inputBuffer.getChannelData(0))) o.onChunk(c.b64, c.level);
        };
        source.connect(processor);
        processor.connect(ctx.destination);        // a script processor runs only while it is connected; it writes no output, so it is silent
        if (ctx.state === "suspended") await ctx.resume();
        const live = ctx;
        const taken = (): void => { if (!stopped) interrupt(); };
        track?.addEventListener("ended", taken);
        live.addEventListener("statechange", () => { if ((live.state as string) === "interrupted") taken(); });
        const handle: MicHandle = {
          echoCancel: track?.getSettings().echoCancellation === true,
          mute(on) {
            muted = on;
            if (on) chunker.reset();
          },
          async stop() {
            if (stopped) return;
            stopped = true;
            processor.onaudioprocess = null;
            source.disconnect();
            processor.disconnect();
            for (const t of stream.getTracks()) t.stop();
            await live.close().catch(() => {});
          },
        };
        return handle;
      } catch (e) {
        for (const t of stream.getTracks()) t.stop();
        await ctx?.close().catch(() => {});
        throw e;
      }
    },
    player,
    playClip: (bytes, signal) => player.playClip(bytes, signal),
    get canOpenMicSettings() { return desktop() !== undefined; },
    async openMicSettings() { await desktop()?.mic.openSettings(); },
    onInterrupted(f) {
      interrupted.add(f);
      return () => { interrupted.delete(f); };
    },
  };
}
