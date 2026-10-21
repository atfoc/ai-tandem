// The microphone and the STT socket of one listening session (architecture VC-19, VC-9, §2.1, §2.6). `startListener` starts the
// microphone (16 kHz mono chunks of 100 ms), then opens the socket with the model, the format, the commit strategy, the silence and the
// language, and resolves once both are up. Each chunk goes up as an `input_audio_chunk` frame while the session lets audio through: the
// person has not muted, and the session has not closed the gate (it does while a turn is on its way, and while the reply is spoken where
// voice barge-in is not shipped). No chunk is ever sent while muted, while the gate is closed, or after `stop` (goal 4.8); the
// microphone itself is muted too, so a platform that honours it captures nothing.
//
// The service's partial and committed transcripts are told to the session as they come. A socket the service closes (for time, for
// inactivity, after one of its two "open again" errors) is opened again at the next chunk to send; a socket that cannot open is a
// problem, named by what it said (an error frame, the "no key" close) or, when it said nothing, by one call of the voices list (§2.6, the
// last row): the key, the credits, or "can't reach". Any problem ends the listener for the session: the session shows it and ends.
import { audioFrame, CHUNK_MS, parseSttEvent, STT_PATH, sttQuery, testKeyQuery, VOICES_PATH } from "../logic/protocol.ts";
import { problemOfException, problemOfSttError } from "../logic/problems.ts";
import type { VoiceSettings } from "../logic/settings.ts";
import { VoiceProblemError, voicePorts } from "../ports.ts";
import type { MicHandle, Opened, VoiceProblemKind, VoiceSocket } from "../ports.ts";
import { requestJson } from "./speaker.ts";
import { flags, waits } from "./state.ts";

export type ListenerEvents = {
  partial(text: string): void;
  committed(text: string): void;
  /** The microphone's level, 0..1, with every chunk it gives (also while the gate is closed). */
  level(level: number): void;
  /** The listener cannot go on; it has stopped itself. */
  problem(kind: VoiceProblemKind): void;
};

export interface Listener {
  /** What the microphone port opened (VD-8): `missed` when the saved microphone was not there and the system default listens. */
  readonly opened: Opened;
  /** The person's Mute: no chunk goes up, the socket stays. */
  mute(on: boolean): void;
  /** The session's gate: closed while nothing the person says may count (a turn on its way, its reply, a message read aloud).
   *  Chunks captured while it was closed are not sent later. */
  gate(open: boolean): void;
  /** Asks the service to commit what it heard (Send with a guess not committed yet). Nothing when no socket is open. */
  commit(): void;
  /** Stops the microphone and closes the socket. Nothing is told after it. */
  stop(): void;
}

/** Chunks kept while the socket opens (the first words are not lost): 5 s; older ones are dropped. */
const QUEUE_MAX = 50;
/** A socket opened again this many times in a row without a word from the service is "can't reach". */
const REOPEN_MAX = 3;

/** The close a socket that never opened ends with when there is no key (the net ports' contract). */
const NO_KEY_CLOSE = 1008;

/** Why a socket that never opened failed, when it said nothing itself: one call of the voices list tells (§2.6). */
async function classify(): Promise<VoiceProblemKind> {
  try {
    await requestJson({ method: "GET", path: VOICES_PATH, query: testKeyQuery() });
    return "offline";
  } catch (e) {
    return problemOfException(e);
  }
}

type Sock = { s: VoiceSocket; open: boolean; done: boolean; timer?: ReturnType<typeof setTimeout> };

/** Starts listening. `signal` is the session's: when it aborts (the session ended before listening began), what was started is stopped at
 *  once and the answer is null. Throws a `VoiceProblemError` when the microphone or the socket cannot start (the microphone is then
 *  stopped). */
export async function startListener(o: {
  settings: Pick<VoiceSettings, "sttModel" | "language" | "mic">;
  echoCancel: boolean;
  on: ListenerEvents;
  signal: AbortSignal;
}): Promise<Listener | null> {
  const ports = voicePorts();
  if (o.signal.aborted) return null;
  if (flags.denyMic) throw new VoiceProblemError("mic_blocked");

  let stopped = false;
  let muted = false;
  let gateOpen = true;
  /** What the microphone port was last told. */
  let micMuted = false;
  let sock: Sock | null = null;
  let queue: string[] = [];
  let reopens = 0;
  let mic: MicHandle | null = null;
  let micOpened: Opened = { device: null, missed: false };
  let failed = false;
  /** The opening in progress: resolves when the socket opens, rejects with the problem when it cannot. */
  let opening: { resolve(): void; reject(e: VoiceProblemError): void } | null = null;

  const query = sttQuery(o.settings);

  const fail = (kind: VoiceProblemKind) => {
    if (stopped || failed) return;
    failed = true;
    if (opening) { const w = opening; opening = null; w.reject(new VoiceProblemError(kind)); }
    else { stop(); o.on.problem(kind); }
  };

  /** Sends what waited for the socket, in order. */
  const flush = (k: Sock) => {
    for (const b64 of queue.splice(0)) k.s.send(audioFrame(b64, false));
  };

  function openSocket(): Sock {
    let saidProblem = false;
    const k: Sock = { s: null as unknown as VoiceSocket, open: false, done: false };
    const gone = () => {
      k.done = true;
      clearTimeout(k.timer);
      if (sock === k) sock = null;
    };
    k.s = ports.net.socket(STT_PATH, query, {
      open() {
        if (k.done || stopped) return;
        k.open = true;
        clearTimeout(k.timer);
        if (opening) { const w = opening; opening = null; w.resolve(); }
        if (!muted && gateOpen) flush(k); else queue = [];
      },
      message(text) {
        if (k.done || stopped) return;
        const e = parseSttEvent(text);
        if (e.kind === "partial" || e.kind === "committed") {
          reopens = 0;
          if (e.kind === "partial") o.on.partial(e.text); else o.on.committed(e.text);
        } else if (e.kind === "session_started") {
          reopens = 0;
        } else if (e.kind === "error") {
          const kind = problemOfSttError(e.type);
          if (kind) { saidProblem = true; gone(); k.s.close(); fail(kind); return; }
          // The session's time ran out, or it heard too little: this socket is done, the next chunk opens another.
          gone();
          k.s.close();
        }
      },
      close(code) {
        if (k.done || stopped) return;
        const wasOpen = k.open;
        gone();
        if (saidProblem) return;
        if (wasOpen) return; // closed by the service: the next chunk opens another
        if (code === NO_KEY_CLOSE) { fail("no_key"); return; }
        void classify().then((kind) => fail(kind));
      },
      error() {
        // A close always follows (the net ports' contract); it decides.
      },
    });
    k.timer = setTimeout(() => {
      if (k.done || k.open || stopped) return;
      gone();
      k.s.close();
      fail("offline");
    }, waits.callMs);
    sock = k;
    return k;
  }

  /** A chunk of the microphone: sent, kept until the socket opens, or dropped when nothing may go up. */
  const onChunk = (b64: string, level: number) => {
    if (stopped) return;
    o.on.level(level);
    if (muted || !gateOpen || failed) return;
    let k = sock;
    if (!k) {
      if (reopens >= REOPEN_MAX) { fail("offline"); return; }
      reopens++;
      k = openSocket();
    }
    if (k.open) { k.s.send(audioFrame(b64, false)); return; }
    queue.push(b64);
    if (queue.length > QUEUE_MAX) queue.shift();
  };

  const tellMic = () => {
    const want = muted || !gateOpen;
    if (!mic || want === micMuted) return;
    micMuted = want;
    try { mic.mute(want); } catch { /* the gate holds the chunks back all the same */ }
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    queue = [];
    if (opening) { const w = opening; opening = null; w.reject(new VoiceProblemError("offline")); }
    const k = sock;
    sock = null;
    if (k && !k.done) { k.done = true; clearTimeout(k.timer); k.s.close(); }
    const m = mic;
    mic = null;
    if (m) void m.stop().catch(() => {});
  }

  const listener: Listener = {
    get opened(): Opened { return micOpened; },
    mute(on) {
      if (stopped) return;
      muted = on;
      if (on) queue = [];
      tellMic();
    },
    gate(open) {
      if (stopped) return;
      gateOpen = open;
      if (!open) queue = [];
      tellMic();
    },
    commit() {
      if (stopped) return;
      if (sock?.open) sock.s.send(audioFrame("", true));
    },
    stop,
  };

  // The microphone first (the system's question is asked here), then the socket.
  let handle: MicHandle;
  try {
    handle = await ports.audio.startMic({ chunkMs: CHUNK_MS, echoCancel: o.echoCancel, device: o.settings.mic, onChunk });
  } catch (e) {
    stopped = true;
    if (o.signal.aborted) return null;
    // A microphone that failed without naming a problem (no microphone at all, P6's `NotFoundError`): the person can't be heard, which
    // is what "blocked" tells them, with the way to the system's settings.
    throw e instanceof VoiceProblemError ? e : new VoiceProblemError("mic_blocked");
  }
  mic = handle;
  micOpened = handle.opened;
  if (o.signal.aborted) { stop(); return null; }
  o.signal.addEventListener("abort", stop, { once: true });

  const opened = new Promise<void>((resolve, reject) => { opening = { resolve, reject }; });
  openSocket();
  try {
    await opened;
  } catch (e) {
    stop();
    if (o.signal.aborted) return null;
    throw e;
  }
  if (o.signal.aborted) { stop(); return null; }
  return listener;
}
