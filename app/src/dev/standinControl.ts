// The stand-in of the connector contract, driven from the device (architecture AD-83, package N1). A real Go server cannot be
// scripted, so 13 of the contract's 19 cases cannot run against it. The stand-in of @aiwb/conn's tests can: it lists the
// requests it got, cuts its connections, hangs a path, holds an event stream open and writes to it. It lives on the computer
// (modules/aiwb-net/dev/control.mjs, started by app/e2e/lib/scratch.mjs) and the device reaches it through a small control
// server. The contract reads `requests()` and `connections()` synchronously, so they are a mirror, refreshed after every
// call of the connector that settles and every 30 ms while a stand-in is in use; the calls that act (`write`, `cut`, `hang`...)
// go in order, and the next call of the connector waits for them. Nothing here imports React Native: it runs under Node too.
import type { Connector, Session, TextStream } from "@aiwb/conn";

export type Req = { method: string; path: string; headers: Record<string, string>; body: Uint8Array };

/** URLSession hands a response over with the first byte of its body (a response of headers alone waits), so the stand-in opens
 *  every event stream with this comment, and `mirrored` takes it off the text before the contract sees it: the contract's stream
 *  cases wait for the head of a stream that has not said a word yet. A server that says something at once, as the real one does
 *  (hello), is not affected. A platform that does not need it ignores the comment line too: it is removed on every platform. */
export const PREAMBLE = ": stream\n\n";

export class Control {
  private chain: Promise<unknown> = Promise.resolve();
  private poll: ReturnType<typeof setInterval> | null = null;
  id: string | null = null;
  requests: Req[] = [];
  connections = 0;

  private readonly base: string;

  constructor(base: string) { this.base = base; }

  private async post(op: string, body: unknown): Promise<any> {
    const r = await fetch(`${this.base}/${op}`, { method: "POST", body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`control ${op}: ${text}`);
    return JSON.parse(text);
  }

  /** A control call, in order after what was sent before. */
  send(op: string, body: unknown = {}): Promise<any> {
    const p = this.chain.then(() => this.post(op, body));
    this.chain = p.catch(() => {});
    return p;
  }

  idle(): Promise<unknown> { return this.chain; }

  /** Starts a stand-in server of the contract's kind 'aiwb' and watches it. `native`: the connector is the native module's, which
   *  opens a session with a probe request (iOS; `probe`: the stand-in leaves it out of `requests()`), needs the preamble on an event stream, and
   *  sees a polite close of the connection as a clean end (the stand-in resets the connection when it is cut). */
  async start(native = true, probe = true): Promise<{ id: string; port: number; fingerprint: string; secret: string }> {
    const s = await this.send("start", native ? { preamble: PREAMBLE, cut: "rst", probe } : {});
    this.requests = [];
    this.connections = 0;
    this.watch(s.id);
    return s;
  }

  async stop(id: string) {
    if (this.id === id) this.watch(null);
    await this.send("close", { id });
  }

  /** While a stand-in is in use its requests are read again every 30 ms: a case waits for a request no call settles on. */
  watch(id: string | null) {
    this.id = id;
    if (this.poll) clearInterval(this.poll);
    this.poll = id ? setInterval(() => { void this.refresh().catch(() => {}); }, 30) : null;
  }

  async refresh() {
    if (!this.id) return;
    const s = await this.send("state", { id: this.id });
    this.requests = s.requests.map((r: Req & { body: number[] }) => ({ ...r, body: Uint8Array.from(r.body) }));
    this.connections = s.connections;
  }
}

/** The connector with every async call preceded by what the case told the stand-in and followed by a refresh of the mirror, so
 *  that `requests()` is right when the case reads it after the call settled; and the event streams without the preamble. */
export function mirrored(inner: Connector, ctl: Control): Connector {
  const settle = async <T,>(call: () => Promise<T>): Promise<T> => {
    await ctl.idle();
    try { return await call(); } finally { await ctl.refresh(); }
  };
  const session = (s: Session): Session => ({
    get fingerprint() { return s.fingerprint; },
    isClosed: () => s.isClosed(),
    onClose: (f) => s.onClose(f),
    close: () => s.close(),
    fetch: (r) => settle(() => s.fetch(r)),
    stream: (r) => settle(async () => {
      const a = await s.stream(r);
      return { ...a, body: withoutPreamble(a.body) };
    }),
  } as Session);
  return {
    open: async (o) => session(await settle(() => inner.open(o))),
    readCertificate: (o) => settle(() => inner.readCertificate(o)),
  } as Connector;
}

/** A TextStream whose first text loses the preamble (and is not delivered when nothing else came with it). */
function withoutPreamble(body: TextStream): TextStream {
  let first = true;
  return {
    onChunk: (f) => body.onChunk((text) => {
      if (first) {
        first = false;
        if (text.startsWith(PREAMBLE)) {
          const rest = text.slice(PREAMBLE.length);
          if (rest) f(rest);
          return;
        }
      }
      f(text);
    }),
    onEnd: (f) => body.onEnd(f),
    cancel: () => body.cancel(),
  };
}
