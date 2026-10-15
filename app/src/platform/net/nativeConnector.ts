// The Connector and Session ports of @aiwb/conn (packages/conn/ports.d.ts) over the native module `aiwb-net`
// (architecture AD-11, AD-30; modules/aiwb-net/README.md is the contract). The module dials and does TLS under
// the trust rule; this file does the rest of the ports: the AbortSignal (an abort cancels the request and
// rejects an AbortError at once), `limitMs` (a timer that cancels), the errors of the module as the Problem and
// NetError of the ports, and the events (`chunk`, `end`, `closed`) as TextStreams and onClose.
//
// The module is given, so that the tests can give the fake (modules/aiwb-net/src/fake.ts); the app gives
// `AiwbNetModule` of modules/aiwb-net/src/AiwbNetModule.ts (C4).

import {
  NetError, Problem, abortError, normalFingerprint,
  type Connector, type Headers, type NetError as NetErrorShape, type SendRequest, type Session, type TextStream, type Trust,
} from "@aiwb/conn";

import { netInfoOf, type AiwbNetModule, type NetErr } from "../../../modules/aiwb-net/src/AiwbNet.ts";

type Item = { text: string } | { end: true; err?: NetErrorShape };

// What the module's error means to a call on a session: a NetError, an AbortError, or (a bug of the module, a
// stub) a reset that carries the text of the failure.
function sessionError(err: unknown): Error {
  const info = netInfoOf(err);
  if (info?.kind === "aborted") return abortError();
  if (info?.kind === "net") return new NetError(info.code, info.detail);
  if (info?.kind === "problem") return new NetError("reset", `${info.outcome}: ${info.detail}`);
  return new NetError("reset", err instanceof Error ? err.message : String(err));
}

// What the module's error means to a call that makes a session (or reads a certificate): a Problem, an
// AbortError, or a tls_error that carries the text of the failure.
function problemError(err: unknown): Error {
  const info: NetErr | null = netInfoOf(err);
  if (info?.kind === "aborted") return abortError();
  if (info?.kind === "problem") return new Problem(info.outcome, info.detail, { fingerprint: info.fingerprint, pinned: info.pinned });
  if (info?.kind === "net") return new Problem("tls_error", info.code);
  return new Problem("tls_error", err instanceof Error ? err.message : String(err));
}

// guarded is p, or at once the AbortError of the signal, or the NetError 'timeout' when limitMs passed (after
// `cancel` told the module in both cases). A result that comes after is handed to `late` (a session that was
// made after all must not stay open).
function guarded<T>(
  p: Promise<T>,
  { signal, cancel, limitMs, late }: { signal?: AbortSignal; cancel: () => void; limitMs?: number; late?: (v: T) => void },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = () => { clearTimeout(timer); if (signal) signal.removeEventListener("abort", onAbort); };
    const stop = (err: Error) => {
      if (settled) return;
      settled = true;
      off();
      try { cancel(); } catch { /* the module is gone */ }
      reject(err);
    };
    const onAbort = () => stop(abortError());
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (limitMs) timer = setTimeout(() => stop(new NetError("timeout")), limitMs);
    p.then(
      (v) => {
        off();
        if (settled) { if (late) late(v); return; }
        settled = true;
        resolve(v);
      },
      (e) => {
        off();
        if (settled) return;
        settled = true;
        reject(e);
      },
    );
  });
}

// The error of a guarded call on a session: the ones guarded made stay, the module's become a NetError.
const aborted = (err: unknown) => (err as Error)?.name === "AbortError";

// The body of a stream as a TextStream: what the module's events say, held until the reader is there and
// delivered in a later turn, as the scripted server's pipe does. cancel() ends it with no end after.
class NativeTextStream implements TextStream {
  private queue: Item[] = [];
  private chunk: ((text: string) => void) | null = null;
  private endCb: ((err?: NetErrorShape) => void) | null = null;
  private finished = false;
  private cancelled = false;
  private scheduled = false;
  private readonly release: () => void;
  private readonly cancelNative: () => void;

  constructor(release: () => void, cancelNative: () => void) {
    this.release = release;
    this.cancelNative = cancelNative;
  }

  // The module's side.
  push(text: string) {
    if (this.finished || this.cancelled) return;
    this.queue.push({ text });
    this.pump();
  }

  finish(error?: "reset") {
    if (this.finished || this.cancelled) return;
    this.finished = true;
    this.release();
    this.queue.push({ end: true, err: error ? new NetError("reset") : undefined });
    this.pump();
  }

  // The reader's side.
  onChunk(f: (text: string) => void) { this.chunk = f; this.pump(); }

  onEnd(f: (err?: NetErrorShape) => void) { this.endCb = f; this.pump(); }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue = [];
    this.release();
    if (!this.finished) this.cancelNative();
  }

  private pump() {
    if (this.scheduled) return;
    this.scheduled = true;
    void Promise.resolve().then(() => { this.scheduled = false; this.drain(); });
  }

  private drain() {
    while (this.queue.length && !this.cancelled) {
      const item = this.queue[0];
      if ("end" in item) {
        if (!this.endCb) return;
        this.queue.shift();
        this.endCb(item.err);
        return;
      }
      if (!this.chunk) return;
      this.queue.shift();
      this.chunk(item.text);
    }
  }
}

// The three events of a module, routed to the request or the session they name. One router per module: the
// ids of requests come from it, so that two connectors on one module never meet.
class Router {
  readonly streams = new Map<string, NativeTextStream>();
  readonly sessions = new Map<string, NativeSession>();
  readonly mod: AiwbNetModule;
  private readonly early: string[] = []; // sessions that closed before openSession told of them
  private readonly base = Math.random().toString(36).slice(2, 8);
  private seq = 0;

  constructor(mod: AiwbNetModule) {
    this.mod = mod;
    mod.addListener("chunk", (e) => this.streams.get(e.request)?.push(e.text));
    mod.addListener("end", (e) => this.streams.get(e.request)?.finish(e.error));
    mod.addListener("closed", (e) => {
      const s = this.sessions.get(e.session);
      if (s) s.ended();
      else { this.early.push(e.session); if (this.early.length > 64) this.early.shift(); }
    });
  }

  id(): string { return `${this.base}-${++this.seq}`; }

  add(s: NativeSession) {
    this.sessions.set(s.id, s);
    if (this.early.includes(s.id)) s.ended();
  }
}

const routers = new WeakMap<AiwbNetModule, Router>();
function routerOf(mod: AiwbNetModule): Router {
  let r = routers.get(mod);
  if (!r) routers.set(mod, (r = new Router(mod)));
  return r;
}

const cancelling = (mod: AiwbNetModule, request: string) => () => mod.cancel(request);

class NativeSession implements Session {
  readonly id: string;
  readonly fingerprint: string;
  private readonly router: Router;
  private closed = false;
  private listeners: Array<() => void> = [];

  constructor(router: Router, id: string, fingerprint: string) {
    this.router = router;
    this.id = id;
    this.fingerprint = fingerprint;
  }

  isClosed() { return this.closed; }

  onClose(f: () => void) {
    if (this.closed) f(); else this.listeners.push(f);
  }

  // ended: the session is over (the module said so, or close() was called): the listeners are told once.
  ended() {
    if (this.closed) return;
    this.closed = true;
    this.router.sessions.delete(this.id);
    for (const f of this.listeners.splice(0)) f();
  }

  close() {
    if (this.closed) return;
    this.ended();
    this.router.mod.closeSession(this.id);
  }

  async fetch(r: SendRequest & { limitMs?: number; maxBytes?: number }) {
    const { mod } = this.router;
    if (r.signal && r.signal.aborted) throw abortError();
    if (this.closed) throw new NetError("closed");
    const request = this.router.id();
    const call = new Promise<Awaited<ReturnType<AiwbNetModule["fetch"]>>>((resolve) => resolve(mod.fetch({
      session: this.id, request, method: r.method, path: r.path, headers: r.headers, body: r.body,
      headersMs: r.headersMs ?? 0, maxBytes: r.maxBytes ?? 0,
    })));
    try {
      const a = await guarded(call, { signal: r.signal, cancel: cancelling(mod, request), limitMs: r.limitMs });
      return { status: a.status, headers: a.headers as Headers, body: a.body instanceof Uint8Array ? a.body : new Uint8Array(a.body) };
    } catch (err) {
      throw aborted(err) || err instanceof NetError ? err : sessionError(err);
    }
  }

  async stream(r: SendRequest) {
    const { mod } = this.router;
    if (r.signal && r.signal.aborted) throw abortError();
    if (this.closed) throw new NetError("closed");
    if (r.body != null) throw new TypeError("a stream is a request with no body");
    const request = this.router.id();
    let detach = () => {};
    const body = new NativeTextStream(() => { this.router.streams.delete(request); detach(); }, () => mod.cancel(request));
    this.router.streams.set(request, body); // the events of the stream may come before the promise does
    const call = new Promise<Awaited<ReturnType<AiwbNetModule["stream"]>>>((resolve) => resolve(mod.stream({
      session: this.id, request, method: r.method, path: r.path, headers: r.headers, headersMs: r.headersMs ?? 0,
    })));
    let head;
    try {
      head = await guarded(call, { signal: r.signal, cancel: cancelling(mod, request) });
    } catch (err) {
      this.router.streams.delete(request);
      throw aborted(err) ? err : sessionError(err);
    }
    // After the headers an abort cancels the body (no end after it), as the Node session does.
    const { signal } = r;
    if (signal) {
      const onAbort = () => body.cancel();
      detach = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return { status: head.status, headers: head.headers as Headers, body };
  }
}

/** The Connector over a module. */
export function nativeConnector(mod: AiwbNetModule): Connector {
  const router = routerOf(mod);
  return {
    async open({ host, port, trust, dialMs, handshakeMs, signal }) {
      if (signal && signal.aborted) throw abortError();
      const t: Trust = trust;
      if (t.selfSigned && !t.pin) throw new Problem("fingerprint"); // nothing is dialed
      const request = router.id();
      // The module compares the pin as text with the fingerprint it computed: a pin in another form of the
      // same fingerprint is put in the normal form here; a pin that is no fingerprint is sent as it is and fits no certificate.
      const pin = t.selfSigned ? (normalFingerprint(t.pin) ?? String(t.pin)) : "";
      let opened;
      try {
        opened = await guarded(
          new Promise<Awaited<ReturnType<AiwbNetModule["openSession"]>>>((resolve) => resolve(mod.openSession({
            request, host, port: Number(port), selfSigned: !!t.selfSigned, pin, dialMs, handshakeMs,
          }))),
          { signal, cancel: cancelling(mod, request), late: (v) => { try { mod.closeSession(v.session); } catch { /* gone */ } } },
        );
      } catch (err) {
        throw aborted(err) ? err : problemError(err);
      }
      const session = new NativeSession(router, opened.session, opened.fingerprint);
      router.add(session);
      return session;
    },

    async readCertificate({ host, port, dialMs, handshakeMs, signal }) {
      if (signal && signal.aborted) throw abortError();
      const request = router.id();
      try {
        const r = await guarded(
          new Promise<Awaited<ReturnType<AiwbNetModule["readCertificate"]>>>((resolve) => resolve(mod.readCertificate({
            request, host, port: Number(port), dialMs, handshakeMs,
          }))),
          { signal, cancel: cancelling(mod, request) },
        );
        return r.fingerprint;
      } catch (err) {
        throw aborted(err) ? err : problemError(err);
      }
    },
  };
}
