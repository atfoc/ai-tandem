// The audio port on the web build and in the desktop window (architecture VC-10), over Web Audio. The microphone is `getUserMedia` into a
// `ScriptProcessorNode` (not an AudioWorklet: its module would load from a `file://` page under `script-src 'self'`, which Electron does not
// promise), cut into chunks of 16 kHz s16le by `logic/pcm.ts`. The player is one `AudioContext` at 24 kHz that starts each written piece where
// the last one ends, so there is no gap. Nothing is made until the person's tap: the factory builds no context, asks for no microphone.
//
// Devices (voice-devices VD-1 to VD-11): the microphone is opened by `deviceId: { exact }` and the player's one context is pointed at a speaker
// with `setSinkId` (never `sinkId` in the constructor: a bad id would leave a context that stays suspended). A saved device that is not there
// gives the default and `missed`. A capture track that ends is a lost microphone: capture reopens on the default into the same chunker. A
// speaker that goes away moves the sound to the default; when it was private and the sound would come out loud, the context is suspended first
// and waits for `resume()`. Listing is `enumerateDevices` alone (`audio.web.devices.ts`); no device name is ever written to `console.*`.
import {
  VoiceProblemError, type AudioDevice, type AudioPort, type MicHandle, type Opened, type PcmPlayer, type PlayerEvent, type RouteEvent, type SavedDevice,
} from "../ports.ts";
import { MicChunker, PcmDecoder, rms } from "../logic/pcm.ts";
import { matchSaved, shouldPause } from "../logic/devices.ts";
import type { VoiceWindow } from "./bridge.types.ts";
import { deviceOfTrack, listWebDevices, mediaDevices, notThere, webAbility, type SinkContext } from "./audio.web.devices.ts";

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

/** What the player takes from its port: whether the speaker can be chosen, who is told of a lost output, and whether anyone is told at all. */
type PlayerEnv = { canPick: boolean; routes: Set<(e: RouteEvent) => void> };

/** What was last known of the outputs (a listing): to tell, at a `devicechange`, what went away and what the system default was. */
type Known = { outputs: AudioDevice[]; hasDefault: boolean; defaultDevice: AudioDevice | null };

const sameDevice = (a: AudioDevice, b: AudioDevice): boolean => a.id === b.id || (a.name !== "" && a.name === b.name);

function createPlayer(env: PlayerEnv) {
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
  // The output (VD-10). `held`: the engine's hold, or the port's after a private loss; the context stays suspended until resume() or stop().
  // `probes`: devicechanges being looked at: the context stands still meanwhile, so a sound that the system moved to the loudspeaker is not
  // played while the port finds out whether it was private.
  let held = false;
  let probes = 0;
  let sinkId = "";                                  // "" is the system default
  let sinkDevice: AudioDevice | null = null;        // the device behind sinkId, for the notice
  let known: Known | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f);
    chain = run.catch(() => {});
    return run;
  };

  const emit = (e: PlayerEvent): void => { for (const f of [...listeners]) f(e); };

  const sync = (): void => {
    if (!ctx) return;
    if (held || probes > 0) ctx.suspend().catch(() => {});
    else if (ctx.state === "suspended") ctx.resume().catch(() => {});
  };

  // The context is made at the first sound, which follows a tap, so the browser lets it play.
  const context = (): AudioContext => {
    if (!ctx) {
      const C = contextClass();
      ctx = new C({ sampleRate: PLAYER_RATE });
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(ctx.destination);
    }
    sync();
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
    if (held) return;                               // the clock stands still; nothing is reached and no level is told
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

  const setSink = async (id: string): Promise<boolean> => {
    try {
      await (ctx as SinkContext).setSinkId(id);
      sinkId = id;
      return true;
    } catch {
      return false;
    }
  };

  const snapshot = (list: Awaited<ReturnType<typeof listWebDevices>>, hadDefault: boolean): Known => ({
    outputs: list.outputs, hasDefault: hadDefault, defaultDevice: list.defaults.output,
  });

  /** Lists the outputs and keeps what the listing says as what is known (the base of the next devicechange). */
  const learn = async (): Promise<Awaited<ReturnType<typeof listWebDevices>>> => {
    const list = await listWebDevices();
    if (!list.hidden) known = snapshot(list, list.defaults.output !== null);
    return list;
  };

  const applyOutput = async (d: SavedDevice | null): Promise<Opened> => {
    if (!env.canPick) return { device: null, missed: false };
    if (d === null) {
      if (ctx && sinkId !== "") await setSink("");
      sinkDevice = null;
      if (env.routes.size > 0) await learn();       // a session is running: what it is on now is the base of a loss
      return { device: null, missed: false };
    }
    const list = await learn();
    const found = list.hidden ? null : matchSaved(d, list.outputs);
    context();
    let rejected = false;
    if (found) {
      if (sinkId === found.id || await setSink(found.id)) {
        sinkDevice = found;
        return { device: found, missed: false };
      }
      rejected = true;
    }
    if (sinkId !== "" || rejected) await setSink("");   // a sink that was refused leaves no promise about the old one: the default is set outright
    sinkDevice = null;
    return { device: null, missed: true };
  };

  /** A devicechange while a session is on: what went away, and what to do with the sound (VD-10, VD-11). */
  const checkOutput = async (): Promise<void> => {
    const list = await listWebDevices();
    if (list.hidden || env.routes.size === 0) return;   // no context yet is no reason to stay silent: the engine pauses on the event, and a context made later is made held
    const before = known;
    known = snapshot(list, list.defaults.output !== null);
    let lost: AudioDevice | null = null;
    let gone = false;
    const listed = (d: AudioDevice): boolean => list.outputs.some((o) => sameDevice(o, d));
    if (sinkId !== "") {
      const mine = sinkDevice ?? before?.outputs.find((o) => o.id === sinkId) ?? null;
      if (!list.outputs.some((o) => o.id === sinkId)) { gone = true; lost = mine; }
    } else if (before) {
      if (before.defaultDevice) {
        // The device the default stood for went away, or the system now has another one as its default (the old one may still be plugged in).
        const moved = list.defaults.output !== null && !sameDevice(list.defaults.output, before.defaultDevice);
        if (!listed(before.defaultDevice) || moved) { gone = true; lost = before.defaultDevice; }
      } else if (!before.hasDefault) {
        // The system does not say which output is its default: an output that went away may have been the one in use.
        const missing = before.outputs.find((o) => !listed(o));
        if (missing) { gone = true; lost = missing; }
      }
    }
    if (!gone) return;
    const now = list.defaults.output;
    const hold = shouldPause(lost, now);
    if (hold) held = true;                           // the context is already standing still (the probe); it stays so
    if (ctx && sinkId !== "") await setSink("");
    sinkDevice = null;
    for (const f of [...env.routes]) f({ kind: "output-lost", lost, now, held: hold });
  };

  return {
    write(pcm: Uint8Array) {
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
    mark(id: number) { waiting.push(id); },
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
      if (held) { held = false; sync(); }           // a hold ends with the sound it held
    },
    on(f: (e: PlayerEvent) => void) {
      listeners.add(f);
      return () => { listeners.delete(f); };
    },
    useOutput(d: SavedDevice | null): Promise<Opened> { return serial(() => applyOutput(d)); },
    hold() {
      held = true;
      sync();
      if (active) emit({ kind: "level", level: 0 });
    },
    resume() {
      held = false;
      sync();
    },
    async playClip(bytes: Uint8Array, signal: AbortSignal) {
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
    /** The system's devices changed while someone listens for a lost output: stand still at once, look, and either go on or tell. */
    deviceChanged(): void {
      if (!env.canPick) return;
      probes += 1;
      sync();
      void serial(checkOutput).catch(() => {}).finally(() => { probes -= 1; sync(); });
    },
    /** The first session started listening for lost outputs: learn the outputs now, so a later devicechange can be compared even when no speaker
     *  is ever chosen (the engine makes no `useOutput` call for a person on System default). */
    began(): void {
      if (!env.canPick) return;
      void serial(async () => {
        const list = await listWebDevices();
        if (!list.hidden && env.routes.size > 0) known = snapshot(list, list.defaults.output !== null);
      }).catch(() => {});
    },
    /** The last session stopped listening for lost outputs: what was known is stale. The next one learns it again, at its `useOutput`. */
    ended(): void { known = null; },
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

const AUDIO_BASE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };

const stopStream = (s: MediaStream | null | undefined): void => { for (const t of s?.getTracks() ?? []) t.stop(); };

export function audioWeb(): AudioPort {
  const ability = webAbility();
  const interrupted = new Set<() => void>();
  const interrupt = (): void => { for (const f of [...interrupted]) f(); };
  const routes = new Set<(e: RouteEvent) => void>();
  const watchers = new Set<() => void>();
  const player = createPlayer({ canPick: ability.output === "pick", routes });

  // One `devicechange` listener, there only while the Settings pickers or a session want to know (VD-6: no listing for a person who never
  // opens the choices, and no listener either).
  let attached: MediaDevices | null = null;
  const onDeviceChange = (): void => {
    for (const f of [...watchers]) f();
    if (routes.size > 0) player.deviceChanged();
  };
  const attach = (): void => {
    const want = watchers.size > 0 || routes.size > 0;
    const md = mediaDevices();
    if (want && !attached && md?.addEventListener) {
      md.addEventListener("devicechange", onDeviceChange);
      attached = md;
    } else if (!want && attached) {
      attached.removeEventListener("devicechange", onDeviceChange);
      attached = null;
    }
  };
  const tell = (e: RouteEvent): void => { for (const f of [...routes]) f(e); };

  /** Opens capture, on the saved microphone when there is one and it is there (VD-2): the list is read, `matchSaved` finds it, and it is opened by
   *  its id. A list that is hidden (the browser before the permission) cannot name anything: the default is opened first, which asks the
   *  permission, and the list is read again. */
  async function openInput(md: MediaDevices, saved: SavedDevice | null): Promise<{ stream: MediaStream; opened: Opened }> {
    const open = (id: string | null): Promise<MediaStream> =>
      md.getUserMedia({ audio: id === null ? AUDIO_BASE : { ...AUDIO_BASE, deviceId: { exact: id } } });
    if (!saved || ability.input !== "pick") return { stream: await open(null), opened: { device: null, missed: false } };
    let list = await listWebDevices();
    let stream: MediaStream | null = null;
    if (list.hidden) {
      stream = await open(null);
      list = await listWebDevices();
    }
    const found = list.hidden ? null : matchSaved(saved, list.inputs);
    if (found) {
      if (stream && stream.getAudioTracks()[0]?.getSettings?.().deviceId === found.id) return { stream, opened: { device: found, missed: false } };
      try {
        const next = await open(found.id);
        stopStream(stream);
        return { stream: next, opened: { device: found, missed: false } };
      } catch (e) {
        if (!notThere(e)) { stopStream(stream); throw e; }
      }
    }
    return { stream: stream ?? await open(null), opened: { device: null, missed: true } };
  }

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
      const md = mediaDevices();
      if (!md?.getUserMedia) throw new VoiceProblemError("mic_blocked");   // a page that is not secure has none
      let stream: MediaStream;
      let opened: Opened;
      try {
        ({ stream, opened } = await openInput(md, o.device));
      } catch (e) {
        throw refused(e) ? new VoiceProblemError("mic_blocked") : e;
      }
      let track = stream.getAudioTracks()[0];
      let ctx: AudioContext | null = null;
      try {
        const C = contextClass();
        ctx = new C();
        let source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(SCRIPT_BLOCK, 1, 1);
        const chunker = new MicChunker(ctx.sampleRate, o.chunkMs);
        let muted = false;
        let stopped = false;
        let reopening = false;
        processor.onaudioprocess = (ev) => {
          if (muted || stopped) return;
          for (const c of chunker.push(ev.inputBuffer.getChannelData(0))) o.onChunk(c.b64, c.level);
        };
        source.connect(processor);
        processor.connect(ctx.destination);        // a script processor runs only while it is connected; it writes no output, so it is silent
        if (ctx.state === "suspended") await ctx.resume();
        const live = ctx;
        let inUse: AudioDevice | null = opened.device;
        const stopAll = async (): Promise<void> => {
          if (stopped) return;
          stopped = true;
          processor.onaudioprocess = null;
          track?.removeEventListener("ended", lostTrack);
          source.disconnect();
          processor.disconnect();
          stopStream(stream);
          await live.close().catch(() => {});
        };
        // The track ended: the microphone went away (VD-9). Capture goes on from the system default, into the same chunker and the same
        // `onChunk`; the socket and the words are the engine's and are not touched. Only what was said in the moment of the change is lost.
        async function lostTrack(): Promise<void> {
          if (stopped || reopening) return;
          reopening = true;
          const lost = inUse ?? deviceOfTrack(track);
          let next: MediaStream;
          try {
            next = await md!.getUserMedia({ audio: AUDIO_BASE });
          } catch {
            reopening = false;
            if (stopped) return;
            if (routes.size === 0) { interrupt(); return; }     // nobody is told of a route: it ends as a taken microphone always did
            await stopAll();
            tell({ kind: "input-failed", lost });
            return;
          }
          if (stopped) { stopStream(next); reopening = false; return; }
          const old = stream;
          const oldSource = source;
          track?.removeEventListener("ended", lostTrack);
          stream = next;
          track = next.getAudioTracks()[0];
          source = live.createMediaStreamSource(next);
          chunker.reset();
          source.connect(processor);
          oldSource.disconnect();
          stopStream(old);
          track?.addEventListener("ended", lostTrack);
          inUse = null;
          reopening = false;
          const list = await listWebDevices();
          if (!stopped) tell({ kind: "input-lost", lost, now: list.defaults.input });
        }
        const taken = (): void => { if (!stopped) interrupt(); };
        track?.addEventListener("ended", lostTrack);
        live.addEventListener("statechange", () => { if ((live.state as string) === "interrupted") taken(); });
        const handle: MicHandle = {
          echoCancel: track?.getSettings().echoCancellation === true,
          opened,
          mute(on) {
            muted = on;
            if (on) chunker.reset();
          },
          stop: stopAll,
        };
        if (watchers.size > 0) for (const f of [...watchers]) f();   // a permission may have been given: the lists may show more now
        return handle;
      } catch (e) {
        stopStream(stream);
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
    devices: {
      ability,
      list: listWebDevices,
      watch(f) {
        watchers.add(f);
        attach();
        return () => { watchers.delete(f); attach(); };
      },
    },
    onRoute(f) {
      routes.add(f);
      attach();
      if (routes.size === 1) player.began();
      return () => {
        routes.delete(f);
        attach();
        if (routes.size === 0) player.ended();
      };
    },
  };
}
