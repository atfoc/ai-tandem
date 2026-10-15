// The app's side of the bridge: sends requests, matches replies by id, delivers events. No React Native in it: the
// component gives it a `send` (the web view's postMessage) and feeds it what the web view says (onMessage).
import {
  PROTOCOL_VERSION, request, encode, parseFromBoard,
  type Event, type Requests, type RequestType, type Request,
} from "./protocol.ts";

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) { super(`${code}: ${message}`); this.code = code; }
}

type Waiter = { type: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sentAt: number };

export class BoardBridge {
  private send: (raw: string) => void = () => { throw new BridgeError("NOT_ATTACHED", "no web view"); };
  private waiting = new Map<string, Waiter>();
  private listeners = new Set<(e: Event) => void>();
  private n = 0;
  /** What came in, for the checks: messages taken, messages refused (with why), bytes. */
  stats = { taken: 0, refused: 0, refusals: [] as string[], bytesIn: 0, bytesOut: 0, lastRoundTripMs: 0 };

  attach(send: (raw: string) => void) { this.send = send; }

  /** The web view's `onMessage` goes here. Anything that does not parse is refused and counted, never acted on. */
  onMessage(raw: unknown) {
    const p = parseFromBoard(raw);
    if (typeof raw === "string") this.stats.bytesIn += raw.length;
    if (!p.ok) { this.stats.refused++; if (this.stats.refusals.length < 20) this.stats.refusals.push(p.reason); return; }
    this.stats.taken++;
    const m = p.value;
    if (m.kind === "event") { for (const l of [...this.listeners]) l(m); return; }
    const w = this.waiting.get(m.id);
    if (!w) return; // an answer to nothing (late, or already timed out)
    this.waiting.delete(m.id);
    clearTimeout(w.timer);
    this.stats.lastRoundTripMs = Date.now() - w.sentAt;
    if (m.ok) w.resolve(m.result); else w.reject(new BridgeError(m.error.code, m.error.message));
  }

  on(listener: (e: Event) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** The next event that `match` accepts (events already past are not seen). */
  waitFor<E extends Event>(match: (e: Event) => e is E, timeoutMs = 30000): Promise<E> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new BridgeError("TIMEOUT", "no such event in time")); }, timeoutMs);
      const off = this.on((e) => { if (match(e)) { clearTimeout(timer); off(); resolve(e); } });
    });
  }

  call<T extends RequestType>(type: T, params: Requests[T]["params"], timeoutMs = 30000): Promise<Requests[T]["result"]> {
    const id = `${type}-${++this.n}`;
    const raw = encode(request(id, type, params) as Request);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new BridgeError("TIMEOUT", `${type} was not answered in ${timeoutMs} ms`)); }, timeoutMs);
      this.waiting.set(id, { type, resolve, reject, timer, sentAt: Date.now() });
      this.stats.bytesOut += raw.length;
      try { this.send(raw); } catch (e: any) { clearTimeout(timer); this.waiting.delete(id); reject(e); }
    });
  }

  /** Reject everything in flight (the web view went away). */
  reset(why: string) {
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new BridgeError("RESET", why)); this.waiting.delete(id); }
  }
}

export const protocolVersion = PROTOCOL_VERSION;
