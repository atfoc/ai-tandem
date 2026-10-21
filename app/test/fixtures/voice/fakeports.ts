// Fake ports for the tests of voice's engine (architecture §3.2, §14): a keystore in memory, a net that answers by script, and an audio
// port that records what it is given. The engine under test sees only `VoicePorts`; the test sees the records and the handles to
// move things on (release a chunk, end a sentence, say a socket frame, reach a mark).
//
//   const f = createFakePorts();  setVoicePorts(f.ports);
//   f.net.on((r) => r.path.startsWith("/v1/text-to-speech/"), { chunks: 4 });     // a TTS answer of 4 chunks, paced by time or by the test
//   f.calls                                                                       // every call the engine made, in order
//
// Nothing here knows a key's value except the keystore; `calls` and the records never hold one.
import type { AudioPort, MicHandle, NetRequest, PlayerEvent, SocketEvents, VoiceNet, VoicePorts, VoiceSocket } from "../../../src/voice/ports.ts";
import { VoiceNetError, VoiceProblemError } from "../../../src/voice/ports.ts";

export type Deferred<T = void> = { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void };
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Lets pending promises and the engine's turns run: a few turns of the event loop. */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setImmediate(r));
}

/** Waits until `cond` holds, checking between event-loop turns; fails after `ms` (generous: seconds, not milliseconds). */
export async function waitFor(cond: () => boolean, what = "the condition", ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((r) => setTimeout(r, 2));
  }
}

/** `bytes` bytes of PCM (a ramp, so chunks can be told apart). */
export function pcm(bytes: number, seed = 1): Uint8Array {
  const a = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) a[i] = (seed + i) & 0xff;
  return a;
}

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

// ---------------------------------------------------------------- the keystore

export type FakeKeystore = VoicePorts["keystore"] & {
  /** The stored key (the test sets it to put one there, and reads it to see one was kept). */
  key: string | null;
  /** Calls made, in order: "has" | "get" | "set" | "clear". */
  log: string[];
  /** Makes `has` reject (a store that fails). */
  failHas: boolean;
};

export function createFakeKeystore(log: (s: string) => void, o: { key?: string | null; withGet?: boolean } = {}): FakeKeystore {
  const ks: FakeKeystore = {
    key: o.key ?? null,
    log: [],
    failHas: false,
    async has() { log("keystore.has"); ks.log.push("has"); if (ks.failHas) throw new Error("store failed"); return ks.key !== null; },
    async set(k) { log("keystore.set"); ks.log.push("set"); ks.key = k; },
    async clear() { log("keystore.clear"); ks.log.push("clear"); ks.key = null; },
  };
  // Electron's page has no `get` (VC-3): `withGet: false` is that store.
  if (o.withGet !== false) ks.get = async () => { log("keystore.get"); ks.log.push("get"); return ks.key; };
  return ks;
}

// ---------------------------------------------------------------- the net

/** What a scripted answer does. A `chunks` count is that many chunks of `chunkBytes` each (3200 by default); an array is those chunks. */
export type Reply = {
  status?: number;
  /** A JSON answer: the text `text()` gives. */
  json?: unknown;
  text?: string;
  chunks?: number | Uint8Array[];
  chunkBytes?: number;
  /** Chunks come by themselves, this many ms apart (0: one per turn of the event loop). Ignored with `manual`. */
  paceMs?: number;
  /** The test releases chunks with `request.release(n)` and ends the body with `request.end()`. */
  manual?: boolean;
  /** The answer (the status line) waits for `request.answer()`. */
  hold?: boolean;
  /** The call fails: with the net's own error, or with a problem a port can throw. */
  reject?: "net" | VoiceProblemError;
  /** The body fails after this many chunks (a cut stream). */
  cutAfter?: number;
};
export type Responder = Reply | ((r: NetRequest, n: number) => Reply);

export type FakeRequest = {
  req: NetRequest;
  /** The number of the request among all made. */
  n: number;
  at: number;
  /** The signal the engine gave. */
  signal: AbortSignal;
  readonly aborted: boolean;
  /** The body was read to its end. */
  readonly finished: boolean;
  /** The status line has been given. */
  readonly answered: boolean;
  /** How many chunks were handed out. */
  readonly sent: number;
  /** For `hold`: give the status line. */
  answer(): void;
  /** For `manual`: release n more chunks (default 1). */
  release(n?: number): void;
  /** For `manual`: end the body once the released chunks are read. */
  end(): void;
  /** Cut the body with a network error. */
  cut(): void;
};

export type FakeSocket = {
  path: string;
  query: Record<string, string>;
  /** Frames the engine sent. */
  sent: string[];
  closed: boolean;
  /** The engine closed it (not the service). */
  closedByEngine: boolean;
  /** The service opens it. */
  open(): void;
  /** The service says a text frame. */
  receive(text: string): void;
  /** The service closes it. */
  serverClose(code?: number): void;
  /** The connection fails: `error`, then `close` with `code` (1006), as the net ports do. */
  fail(code?: number): void;
};

export type FakeNet = VoiceNet & {
  requests: FakeRequest[];
  sockets: FakeSocket[];
  /** The urls `preview` was asked for. */
  previewsAsked: string[];
  /** The clips `preview` answers with, by url (anything else fails like a missing network). */
  previewBytes: Map<string, Uint8Array>;
  /** How many requests are open now (made, not finished, not aborted), and the most there were at once. */
  readonly inflight: number;
  readonly maxInflight: number;
  /** A script: the requests `match` accepts get `reply`. Later scripts are tried first, so a test can override an earlier one. */
  on(match: (r: NetRequest) => boolean, reply: Responder): void;
  /** Requests whose path starts with `prefix`. */
  to(prefix: string): FakeRequest[];
  /** Every request fails like a missing network. */
  offline: boolean;
};

export function createFakeNet(log: (s: string) => void, now: () => number): FakeNet {
  const scripts: { match: (r: NetRequest) => boolean; reply: Responder }[] = [];
  let open = 0;
  let max = 0;
  const net: FakeNet = {
    requests: [],
    sockets: [],
    previewsAsked: [],
    previewBytes: new Map(),
    offline: false,
    get inflight() { return open; },
    get maxInflight() { return max; },
    on(match, reply) { scripts.unshift({ match, reply }); },
    to(prefix) { return net.requests.filter((q) => q.req.path.startsWith(prefix)); },

    async request(r, signal) {
      log(`net.request ${r.method} ${r.path}`);
      const n = net.requests.length;
      const script = scripts.find((s) => s.match(r));
      const reply: Reply = script ? (typeof script.reply === "function" ? script.reply(r, n) : script.reply) : { status: 404, text: "{}" };

      const answered = deferred();
      answered.promise.catch(() => {});
      let sent = 0;
      let aborted = false;
      let finished = false;
      let gaveStatus = false;
      let released = 0;
      let ended = false;
      let cutNow = false;
      let counted = true;
      const wake: (() => void)[] = [];
      const poke = () => { for (const w of wake.splice(0)) w(); };
      /** The request leaves the open ones (once). */
      const leave = () => { if (counted) { counted = false; open--; } };
      const rec: FakeRequest = {
        req: r, n, at: now(), signal,
        get aborted() { return aborted; },
        get finished() { return finished; },
        get answered() { return gaveStatus; },
        get sent() { return sent; },
        answer() { answered.resolve(); },
        release(k = 1) { released += k; poke(); },
        end() { ended = true; poke(); },
        cut() { cutNow = true; poke(); },
      };
      net.requests.push(rec);
      open++;
      max = Math.max(max, open);
      const onAbort = () => { aborted = true; leave(); poke(); answered.reject(abortError()); };
      if (signal.aborted) { onAbort(); throw abortError(); }
      signal.addEventListener("abort", onAbort, { once: true });

      if (net.offline || reply.reject === "net") { finished = true; leave(); throw new VoiceNetError(); }
      if (reply.reject) { finished = true; leave(); throw reply.reject; }
      if (reply.hold) await answered.promise;
      if (aborted) throw abortError();
      gaveStatus = true;

      const status = reply.status ?? 200;
      const text = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : "");
      const list: Uint8Array[] = Array.isArray(reply.chunks)
        ? reply.chunks
        : Array.from({ length: reply.chunks ?? 0 }, (_, i) => pcm(reply.chunkBytes ?? 3200, i + 1));
      const finish = () => { finished = true; leave(); signal.removeEventListener("abort", onAbort); };
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          let i = 0;
          return {
            async next(): Promise<IteratorResult<Uint8Array>> {
              for (;;) {
                if (aborted) throw abortError();
                if (cutNow || (reply.cutAfter !== undefined && i >= reply.cutAfter)) { finish(); throw new VoiceNetError(); }
                if (reply.manual) {
                  if (i < released) {
                    sent++;
                    const value = list[i] ?? pcm(reply.chunkBytes ?? 3200, i + 1);
                    i++;
                    return { done: false, value };
                  }
                  if (ended) { finish(); return { done: true, value: undefined }; }
                  await new Promise<void>((w) => wake.push(w));
                  continue;
                }
                if (i >= list.length) { finish(); return { done: true, value: undefined }; }
                if (reply.paceMs) await new Promise<void>((w) => setTimeout(w, reply.paceMs));
                else await new Promise<void>((w) => setImmediate(w));
                if (aborted) throw abortError();
                sent++;
                return { done: false, value: list[i++] };
              }
            },
            async return(): Promise<IteratorResult<Uint8Array>> { return { done: true, value: undefined }; },
          };
        },
      };
      // reading the answer as text consumes the body: the request is over
      return { status, body, text: async () => { finish(); return text; } };
    },

    socket(path, query, on: SocketEvents): VoiceSocket {
      log(`net.socket ${path}`);
      const sock: FakeSocket = {
        path, query, sent: [], closed: false, closedByEngine: false,
        open() { on.open(); },
        receive(text) { if (!sock.closed) on.message(text); },
        serverClose(code = 1000) { if (!sock.closed) { sock.closed = true; on.close(code); } },
        fail(code = 1006) { if (!sock.closed) { on.error(); sock.closed = true; on.close(code); } },
      };
      net.sockets.push(sock);
      return {
        send(text) { log("net.socket.send"); sock.sent.push(text); },
        close() { log("net.socket.close"); if (!sock.closed) { sock.closed = true; sock.closedByEngine = true; } },
      };
    },

    async preview(url, signal) {
      log("net.preview");
      net.previewsAsked.push(url);
      if (signal.aborted) throw abortError();
      const bytes = net.previewBytes.get(url);
      if (!bytes) throw new VoiceNetError();
      return bytes;
    },
  };
  return net;
}

// ---------------------------------------------------------------- the audio

export type FakeMic = {
  opts: { chunkMs: number; echoCancel: boolean };
  muted: boolean;
  stopped: boolean;
  /** The `mute` calls made, in order. */
  muteLog: boolean[];
  /** The microphone says a chunk (nothing once it is stopped). */
  chunk(b64: string, level?: number): void;
};

export type FakeAudio = AudioPort & {
  /** What the player was given, in order. */
  writes: { at: number; bytes: number; data: Uint8Array }[];
  marks: number[];
  stops: number;
  /** Everything the player was asked, in order: "write" | "mark:<id>" | "stop". */
  playerLog: string[];
  clips: Uint8Array[];
  mics: FakeMic[];
  permission: "granted" | "denied" | "undetermined";
  micSettingsOpened: number;
  /** `playClip` ends by itself after this many ms (default: when its signal aborts, or `endClip()`). */
  clipMs: number | null;
  endClip(): void;
  /** Player events, from the test: playback reached a mark / the queue is drained / this level. */
  reach(id: number): void;
  drain(): void;
  level(l: number): void;
  /** `auto`: the player "plays" what it is given at once: in the next turn of the event loop it reports the marks reached and `drained`. */
  auto: boolean;
  /** The system takes the audio (a call): the listeners of `onInterrupted` are told. */
  interrupt(): void;
  voiceBargeIn: boolean;
  canOpenMicSettings: boolean;
};

export function createFakeAudio(log: (s: string) => void, now: () => number): FakeAudio {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const interrupted = new Set<() => void>();
  const emit = (e: PlayerEvent) => { for (const f of [...listeners]) f(e); };
  let unreached: number[] = [];
  let scheduled = false;
  let clipEnd: Deferred | null = null;

  const a: FakeAudio = {
    writes: [], marks: [], stops: 0, playerLog: [], clips: [], mics: [],
    permission: "granted", micSettingsOpened: 0, clipMs: null, auto: true, voiceBargeIn: false, canOpenMicSettings: true,
    endClip() { clipEnd?.resolve(); },
    reach(id) { unreached = unreached.filter((x) => x !== id); emit({ kind: "mark", id }); },
    drain() { emit({ kind: "drained" }); },
    level(l) { emit({ kind: "level", level: l }); },
    interrupt() { for (const f of [...interrupted]) f(); },

    async micPermission() { log("audio.micPermission"); return a.permission; },
    async startMic(o) {
      log("audio.startMic");
      if (a.permission === "denied") throw new VoiceProblemError("mic_blocked");
      a.permission = "granted";
      const mic: FakeMic = {
        opts: { chunkMs: o.chunkMs, echoCancel: o.echoCancel }, muted: false, stopped: false, muteLog: [],
        chunk(b64, level = 0.3) { if (!mic.stopped) o.onChunk(b64, level); },
      };
      a.mics.push(mic);
      const handle: MicHandle = {
        echoCancel: o.echoCancel,
        mute(on) { log("audio.mic.mute"); mic.muteLog.push(on); mic.muted = on; },
        async stop() { log("audio.mic.stop"); mic.stopped = true; },
      };
      return handle;
    },
    player: {
      write(data) {
        log("audio.player.write");
        a.writes.push({ at: now(), bytes: data.length, data });
        a.playerLog.push("write");
        schedule();
      },
      mark(id) {
        log("audio.player.mark");
        a.marks.push(id);
        a.playerLog.push(`mark:${id}`);
        unreached.push(id);
        schedule();
      },
      stop() {
        log("audio.player.stop");
        a.stops++;
        a.playerLog.push("stop");
        unreached = [];
      },
      on(f) {
        log("audio.player.on");
        listeners.add(f);
        return () => { listeners.delete(f); };
      },
    },
    async playClip(bytes, signal) {
      log("audio.playClip");
      a.clips.push(bytes);
      const ending = deferred();
      clipEnd = ending;
      const timer = a.clipMs !== null ? setTimeout(() => ending.resolve(), a.clipMs) : undefined;
      const onAbort = () => ending.resolve();
      if (signal.aborted) ending.resolve();
      else signal.addEventListener("abort", onAbort, { once: true });
      await ending.promise;
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    },
    async openMicSettings() { log("audio.openMicSettings"); a.micSettingsOpened++; },
    onInterrupted(f) { interrupted.add(f); return () => { interrupted.delete(f); }; },
  };

  /** auto: the next turn reports the marks reached, then drained (so a gap between two writes in different turns is a drain, as a real underrun). */
  function schedule(): void {
    if (!a.auto || scheduled) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (!a.auto) return;
      const ids = unreached;
      unreached = [];
      for (const id of ids) emit({ kind: "mark", id });
      emit({ kind: "drained" });
    });
  }
  return a;
}

// ---------------------------------------------------------------- all of it

export type FakePorts = {
  ports: VoicePorts;
  keystore: FakeKeystore;
  net: FakeNet;
  audio: FakeAudio;
  /** Every call the engine made on a port, in order: "keystore.has", "net.request POST /v1/…", "audio.player.write", … */
  calls: string[];
  /** The addresses `openLink` was given. */
  links: string[];
  /** Moves the clock the ports report (`ports.now()`) by `ms`, and runs the timers of `timers` that fall due, in order. */
  advance(ms: number): void;
  /** Timers on that clock, for an engine that takes its timer from outside (the session's `sessionDeps`). */
  timers: { setTimer(f: () => void, ms: number): unknown; clearTimer(h: unknown): void; readonly pending: number };
};

export function createFakePorts(o: { key?: string | null; withGet?: boolean } = {}): FakePorts {
  const calls: string[] = [];
  const links: string[] = [];
  let t = 1_000_000;
  const now = () => t;
  const log = (s: string) => { calls.push(s); };
  const keystore = createFakeKeystore(log, o);
  const net = createFakeNet(log, now);
  const audio = createFakeAudio(log, now);
  const ports: VoicePorts = { keystore, net, audio, now, openLink: (u) => { log("openLink"); links.push(u); } };
  const due: { id: number; at: number; f: () => void }[] = [];
  let nextTimer = 1;
  const timers = {
    setTimer(f: () => void, ms: number): unknown { const id = nextTimer++; due.push({ id, at: t + Math.max(0, ms), f }); return id; },
    clearTimer(h: unknown) { const i = due.findIndex((x) => x.id === h); if (i >= 0) due.splice(i, 1); },
    get pending() { return due.length; },
  };
  function advance(ms: number): void {
    const until = t + ms;
    for (;;) {
      due.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next || next.at > until) break;
      due.shift();
      t = Math.max(t, next.at);
      next.f();
    }
    t = until;
  }
  return { ports, keystore, net, audio, calls, links, advance, timers };
}

// ---------------------------------------------------------------- scripts for the service's usual answers

/** The voices list as the service's JSON (`/v2/voices`). */
export function voicesJson(n = 6, o: { total?: number; hasMore?: boolean } = {}): unknown {
  return {
    voices: Array.from({ length: n }, (_, i) => ({
      voice_id: `vsv${i + 1}`, name: `Voice ${i + 1}`, description: `About voice ${i + 1}`, labels: {},
      preview_url: `https://previews.example/v${i + 1}.mp3`,
    })),
    has_more: o.hasMore ?? false,
    total_count: o.total ?? n,
    next_page_token: o.hasMore ? "next" : null,
  };
}

/** The usual scripts: the voices path answers a list, a TTS request answers `ttsChunks` chunks. */
export function serveVoice(net: FakeNet, o: { ttsChunks?: number; chunkBytes?: number; paceMs?: number; manual?: boolean; voices?: number } = {}): void {
  net.on((r) => r.path === "/v2/voices", () => ({ json: voicesJson(o.voices ?? 6), status: 200 }));
  net.on((r) => r.path.startsWith("/v1/text-to-speech/"), {
    chunks: o.ttsChunks ?? 4, chunkBytes: o.chunkBytes, paceMs: o.paceMs, manual: o.manual,
  });
}

/** The service's error answers (§2.6). */
export const ERR = {
  rejected: { status: 401, json: { detail: { code: "invalid_api_key", status: "invalid_api_key", message: "no" } } } as Reply,
  quotaLegacy: { status: 401, json: { detail: { status: "quota_exceeded", message: "no" } } } as Reply,
  credits: { status: 402, json: { detail: { code: "insufficient_credits" } } } as Reply,
  rate: { status: 429, json: { detail: { code: "rate_limit_exceeded" } } } as Reply,
  server: { status: 503, text: "" } as Reply,
};
