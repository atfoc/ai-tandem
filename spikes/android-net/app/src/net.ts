// The JS side of the Connector and the Session: a thin layer over the native module, with the shapes of
// desktop/conn (Problem, NetError codes, the SSE reader of sse.js, stateOf of outcomes.js).

import AiwbNet from '../modules/aiwb-net/src/AiwbNetModule';
import type { RawResponse, StreamHead } from '../modules/aiwb-net/src/AiwbNet.types';

export const CLIENT_LEVEL = 6;

/** desktop/conn/outcomes.js Problem: why no connection was made. */
export class Problem extends Error {
  outcome: string;
  detail: string;
  fingerprint: string;
  pinned: string;
  constructor(outcome: string, detail = '', fingerprint = '', pinned = '') {
    super(outcome);
    this.name = 'Problem';
    this.outcome = outcome;
    this.detail = detail;
    this.fingerprint = fingerprint;
    this.pinned = pinned;
  }
}

/** The error of a native call, as a Problem (code = outcome / NetError code, message holds a JSON with the rest). */
export function toProblem(err: any): Problem {
  const code: string = (err && err.code) || 'reset';
  let info: any = {};
  const m = /\{.*\}/s.exec(String((err && err.message) || ''));
  if (m) { try { info = JSON.parse(m[0]); } catch { /* the text stays in detail */ } }
  return new Problem(code, info.detail ?? String((err && err.message) || ''), info.fingerprint ?? '', info.pinned ?? '');
}

/** desktop/conn/outcomes.js stateOf. */
export function stateOf(outcome: string): string {
  switch (outcome) {
    case 'connected': return 'connected';
    case 'self_signed': case 'cert_name': case 'cert_expired': case 'cert_untrusted': return 'certificate_not_accepted';
    case 'secret_refused': return 'secret_not_accepted';
    case 'fingerprint': return 'fingerprint_not_accepted';
    case 'cert_changed': return 'certificate_changed';
    case 'bad_host': return 'name_not_known';
    case 'not_aiwb': return 'not_aiwb';
    case 'too_old': return 'too_old';
    default: return 'unreachable';
  }
}

let seq = 0;
const nextId = () => `r${++seq}`;

/** Connector, second half: the fingerprint of the leaf a server presents, trusting nothing, sending nothing. */
export async function readCertificate(host: string, port: number, dialMs = 3000, handshakeMs = 3000): Promise<string> {
  try { return await AiwbNet.readCertificate(host, port, dialMs, handshakeMs); } catch (e) { throw toProblem(e); }
}

export type Target = { host: string; port: number; pin: string; secret?: string; clientId?: string };

export type FetchOptions = {
  method?: string; path: string; headers?: Record<string, string>; body?: string;
  limitMs?: number; headersMs?: number; maxBytes?: number; signal?: AbortSignal; base64?: boolean;
};

const handlers = new Map<string, (e: any) => void>();
AiwbNet.addListener('onStream', (e) => handlers.get(e.id)?.(e));

export class Session {
  constructor(readonly id: string, readonly fingerprint: string, readonly alpn: string, readonly target: Target) {}

  /** Connector, first half: opens a session that accepts the leaf with this fingerprint and nothing else. */
  static async open(target: Target, dialMs = 3000, handshakeMs = 3000, preflight = true): Promise<Session> {
    try {
      const o = await AiwbNet.openSession(target.host, target.port, target.pin, dialMs, handshakeMs, preflight);
      return new Session(o.id, o.fingerprint, o.alpn, target);
    } catch (e) { throw toProblem(e); }
  }

  identify(extra: Record<string, string> = {}): Record<string, string> {
    const t = this.target;
    return {
      'x-aiwb-secret': t.secret ?? '', 'x-aiwb-client': t.clientId ?? '', 'x-aiwb-level': String(CLIENT_LEVEL), ...extra,
    };
  }

  async fetch(o: FetchOptions): Promise<RawResponse & { json(): any }> {
    const id = nextId();
    if (o.signal?.aborted) throw new Problem('aborted');
    const onAbort = () => AiwbNet.cancel(id);
    o.signal?.addEventListener('abort', onAbort);
    try {
      const r = await AiwbNet.request({
        session: this.id, id, method: o.method, path: o.path, headers: o.headers, body: o.body,
        limitMs: o.limitMs, headersMs: o.headersMs, maxBytes: o.maxBytes, responseEncoding: o.base64 ? 'base64' : 'utf8',
      });
      return { ...r, json: () => JSON.parse(r.body) };
    } catch (e) { throw toProblem(e); } finally { o.signal?.removeEventListener('abort', onAbort); }
  }

  /** Opens GET path as a stream: `head` is the response head, the body arrives as text chunks until `ended` resolves. */
  async stream(o: { path: string; headers?: Record<string, string>; headersMs?: number; onChunk: (text: string) => void }):
    Promise<{ head: StreamHead; ended: Promise<string>; cancel(): void }> {
    const id = nextId();
    let done!: (error: string) => void;
    const ended = new Promise<string>((res) => { done = res; });
    handlers.set(id, (e) => {
      if (e.kind === 'chunk') o.onChunk(e.text);
      else { handlers.delete(id); done(e.error); }
    });
    try {
      const head = await AiwbNet.startStream({ session: this.id, id, path: o.path, headers: o.headers, headersMs: o.headersMs });
      return { head, ended, cancel: () => AiwbNet.cancel(id) };
    } catch (e) { handlers.delete(id); throw toProblem(e); }
  }

  close() { AiwbNet.closeSession(this.id); }
}

/** desktop/conn/sse.js EventReader on text chunks: the data of each completed event; comments and other fields are passed over. */
export class EventReader {
  private buf = '';
  private data: string[] = [];
  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    let pos = 0;
    for (;;) {
      const nl = this.buf.indexOf('\n', pos);
      if (nl < 0) break;
      let line = this.buf.slice(pos, nl);
      pos = nl + 1;
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) { out.push(this.data.join('\n')); this.data = []; }
      } else if (line.startsWith('data:')) {
        let v = line.slice(5);
        if (v.startsWith(' ')) v = v.slice(1);
        this.data.push(v);
      }
    }
    this.buf = this.buf.slice(pos);
    return out;
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const log = (line: string) => { AiwbNet.log(line); };
export const memory = () => AiwbNet.memory();
export const sessionStats = (s: Session) => AiwbNet.sessionStats(s.id);
export const echoBytes = (b: Uint8Array) => AiwbNet.echoBytes(b);
