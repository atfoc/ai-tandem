// The JS face of the native transport: the Connector (open a session under a pin, read a certificate) and the Session (request, stream,
// close) as the shared connection code would call them. Failures are Problem (an outcome of desktop/conn/outcomes.js) or NetError
// (timeout, reset, too_long, closed, aborted), the same two classes the Node ports throw.
import Native from './AiwbNetModule';
import type { CallOptions, FailureCode, Head, NetFailureJson, StreamEndEvent } from './AiwbNet.types';

export * from './AiwbNet.types';
export { Native };

/** The outcomes a native failure code is: the same names as desktop/conn/outcomes.js. */
const OUTCOME_CODES = new Set<string>(['fingerprint', 'cert_changed', 'tls_error', 'not_https', 'refused', 'name_not_found', 'no_route']);

export class Problem extends Error {
  outcome: string;
  detail: string;
  fingerprint: string;
  pinned: string;
  constructor(outcome: string, detail = '', extra: { fingerprint?: string; pinned?: string } = {}) {
    super(outcome);
    this.name = 'Problem';
    this.outcome = outcome;
    this.detail = detail;
    this.fingerprint = extra.fingerprint ?? '';
    this.pinned = extra.pinned ?? '';
  }
}

export class NetError extends Error {
  code: string;
  constructor(code: string, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'NetError';
    this.code = code;
  }
}

/** Turns what a native call rejected with into a Problem or a NetError. */
export function mapError(err: unknown): Problem | NetError {
  const message = err instanceof Error ? err.message : String(err);
  let f: NetFailureJson | null = null;
  // The message is "...AiwbNetError: {json} (at AiwbNet/AiwbNetModule.swift:31)": the JSON is what is between the first { and the last }.
  const at = message.indexOf('{');
  const end = message.lastIndexOf('}');
  if (at >= 0 && end > at) {
    try { f = JSON.parse(message.slice(at, end + 1)) as NetFailureJson; } catch { f = null; }
  }
  if (!f) return new NetError('reset', message);
  if (OUTCOME_CODES.has(f.code)) return new Problem(f.code, f.detail, { fingerprint: f.fingerprint, pinned: f.pinned });
  if (f.code === 'aborted') {
    const e = new Error('This operation was aborted');
    e.name = 'AbortError';
    return e as unknown as NetError;
  }
  return new NetError(f.code as FailureCode, f.detail);
}

let counter = 0;
const nextId = () => `r${++counter}`;

// One listener for all streams: the module's two events, routed by request id.
type StreamHandlers = { onChunk: (text: string) => void; onEnd: (e: StreamEndEvent) => void };
const streams = new Map<string, StreamHandlers>();
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  Native.addListener('onStreamChunk', (e) => streams.get(e.requestId)?.onChunk(e.text));
  Native.addListener('onStreamEnd', (e) => {
    const h = streams.get(e.requestId);
    streams.delete(e.requestId);
    h?.onEnd(e);
  });
}

export type Answer = { status: number; headers: Record<string, string>; body: Uint8Array; text: () => string; protocol: string; reused: boolean };

function decodeBase64(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export class Stream {
  status: number;
  headers: Record<string, string>;
  /** set at the end: how the stream ended (null for the server's clean end) */
  ended: Promise<{ error: Problem | NetError | null; protocol: string; reused: boolean; bytes: number }>;
  constructor(public session: Session, public requestId: string, head: Head, ended: Stream['ended']) {
    this.status = head.status;
    this.headers = head.headers;
    this.ended = ended;
  }
  /** Ends the stream; the `ended` promise settles with an AbortError. */
  cancel() { this.session.cancel(this.requestId); }
}

export class Session {
  closed = false;
  constructor(public id: string, public host: string, public port: number) {}

  /** A request and its whole answer. The signal cancels it. maxBytes: a longer body rejects with NetError too_long. */
  async fetch(opts: CallOptions & { signal?: AbortSignal }): Promise<Answer> {
    const requestId = nextId();
    const { signal, ...options } = opts;
    if (signal?.aborted) throw abortError();
    const onAbort = () => Native.cancel(this.id, requestId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const a = await Native.request(this.id, requestId, options);
      const body = decodeBase64(a.body);
      return { status: a.status, headers: a.headers, body, text: () => new TextDecoder().decode(body), protocol: a.protocol, reused: a.reused };
    } catch (err) {
      throw mapError(err);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Opens a stream: resolves with the headers; text chunks go to onChunk; the end settles `ended`. */
  async stream(opts: CallOptions & { signal?: AbortSignal }, onChunk: (text: string) => void): Promise<Stream> {
    listen();
    const requestId = nextId();
    const { signal, ...options } = opts;
    if (signal?.aborted) throw abortError();
    let finish!: Stream['ended'] extends Promise<infer T> ? (v: T) => void : never;
    const ended: Stream['ended'] = new Promise((resolve) => { finish = resolve as typeof finish; });
    streams.set(requestId, {
      onChunk,
      onEnd: (e) => finish({ error: e.error ? mapError(new Error(e.error)) : null, protocol: e.protocol ?? '', reused: !!e.reused, bytes: e.bytes ?? 0 }),
    });
    const onAbort = () => Native.cancel(this.id, requestId);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const head = await Native.stream(this.id, requestId, options);
      return new Stream(this, requestId, head, ended);
    } catch (err) {
      streams.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      throw mapError(err);
    }
  }

  cancel(requestId: string) { Native.cancel(this.id, requestId); }

  close() {
    if (this.closed) return;
    this.closed = true;
    Native.closeSession(this.id);
  }
}

export function abortError() {
  const e = new Error('This operation was aborted');
  e.name = 'AbortError';
  return e;
}

/** The Connector: a session to host:port that accepts the certificate whose leaf has the pin, and no other. Without a pin it throws
 *  Problem 'fingerprint' and nothing is dialed. The connection is made by the first request; its handshake judges the pin. */
export async function openSession(host: string, port: number, pin: string): Promise<Session> {
  try {
    return new Session(await Native.openSession(host, port, pin), host, port);
  } catch (err) {
    throw mapError(err);
  }
}

/** The leaf certificate's fingerprint, read without trusting it (the add-server flow); nothing is written to the server. */
export async function readCertificate(host: string, port: number, timeoutMs = 3000): Promise<string> {
  try {
    return await Native.readCertificate(host, port, timeoutMs);
  } catch (err) {
    throw mapError(err);
  }
}

export const normalFingerprint = (s: string) => Native.normalFingerprint(s);
