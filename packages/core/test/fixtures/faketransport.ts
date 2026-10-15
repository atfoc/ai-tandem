// A transport the tests drive: it answers a call by (server, method, path, body), answers an app operation, pushes
// envelopes to the stream the page opened, and keeps every request it saw. The page's tests move to it from the fakes of
// `fetch` and `EventSource`: src/transport is the only place that knows those.
import { useTransport, type AppAnswer, type CallAnswer, type CallRequest, type Envelope, type StreamState, type Transport } from "../../src/transport/index.ts";

/** A call as the page made it: the body parsed when it is JSON, "<n bytes>" with its type when it is bytes. */
export type Seen = { server: string; method: string; path: string; body: unknown; type?: string; keepalive?: boolean; signal?: AbortSignal };
/** An operation of the app as the page made it. */
export type SeenApp = { op: string; args: unknown };

/** An answer with a JSON body. */
export const ok = (json?: unknown, status = 200, sceneRev: number | null = null): CallAnswer =>
  ({ status, text: json === undefined ? "" : JSON.stringify(json), sceneRev });
/** A refusal as a server (or the app) words one: its sentence and, when it names one, its code. */
export const refuse = (status: number, body: Record<string, unknown>): CallAnswer => ({ status, text: JSON.stringify(body), sceneRev: null });
/** An answer with a body that is no JSON, or none. */
export const rawAnswer = (status: number, text: string): CallAnswer => ({ status, text, sceneRev: null });

export type Handler = (c: Seen) => CallAnswer | Promise<CallAnswer> | undefined;
export type AppHandler = (c: SeenApp) => AppAnswer | Promise<AppAnswer> | undefined;

export class FakeTransport implements Transport {
  way: "ipc" | "http" = "ipc";
  calls: Seen[] = [];
  apps: SeenApp[] = [];
  /** Answers a call; a handler that answers nothing leaves it to the default, `{"ok":true}`. */
  handler: Handler = () => undefined;
  appHandler: AppHandler = () => undefined;
  streams: { onEnvelope: (e: Envelope) => void; onState: (s: StreamState) => void; closed: boolean }[] = [];
  pickImages: Transport["pickImages"];

  /** Makes this the page's transport. */
  install(): this { useTransport(this); return this; }

  /** Forgets what was seen; the handlers stay. */
  reset() { this.calls.length = 0; this.apps.length = 0; }

  async call(req: CallRequest): Promise<CallAnswer> {
    const b = req.body;
    const body = b === undefined ? undefined : "json" in b ? JSON.parse(b.json) : `<${b.bytes instanceof Uint8Array ? b.bytes.length : b.bytes.size} bytes>`;
    const c: Seen = { server: req.server, method: req.method, path: req.path, body, ...(b && !("json" in b) ? { type: b.type } : {}),
      ...(req.keepalive ? { keepalive: true } : {}), ...(req.signal ? { signal: req.signal } : {}) };
    this.calls.push(c);
    if (req.signal?.aborted) throw req.signal.reason ?? new DOMException("aborted", "AbortError");
    return (await this.handler(c)) ?? ok({ ok: true });
  }

  async app(op: string, args?: unknown): Promise<AppAnswer> {
    const c: SeenApp = { op, args };
    this.apps.push(c);
    return (await this.appHandler(c)) ?? { status: 200, text: JSON.stringify({ ok: true }) };
  }

  stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void) {
    const s = { onEnvelope, onState, closed: false };
    this.streams.push(s);
    return { close: () => { s.closed = true; } };
  }

  /** The IPC way's address of a picture. */
  pictureURL = (server: string, chat: string, image: string) => `aiwb-picture://p/${encodeURIComponent(server)}/${encodeURIComponent(chat)}/${encodeURIComponent(image)}`;

  /** The address of a picture, asynchronously, as the IPC way gives it. */
  picture = async (server: string, chat: string, image: string) => this.pictureURL(server, chat, image);

  /** The stream the page has open (the newest), or undefined. */
  get open() { return this.streams.filter((s) => !s.closed).at(-1); }
  /** Pushes an envelope to the open stream. */
  emit(e: Envelope) { this.open?.onEnvelope(e); }
  /** Tells the open stream's state. */
  state(s: StreamState) { this.open?.onState(s); }
}

/** A fresh fake, installed as the page's transport. */
export const installFake = (): FakeTransport => new FakeTransport().install();
