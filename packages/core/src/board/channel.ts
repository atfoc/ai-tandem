// The app's end of the board bridge (AD-50, AD-52): one board view (Excalidraw behind `@aiwb/board-view`'s endpoint, in
// the page on the web build, in a web view on a phone) as a channel the board side talks to. The platform hands in how a
// message goes out (`post`) and calls `receive` with what comes in; this file checks every message that comes in, drops
// what fails (logged), matches each reply to its request, checks the reply's value against the request, and holds what
// is sent until the view said `ready` (a request sent to a view that is not up yet would be lost).
import type { EngineOp, EngineValues, FromBoard, ToBoard } from "@aiwb/board-bridge/messages.ts";
import { parseFromBoard, validateEngineValue, validateFromBoard } from "@aiwb/board-bridge/validate.ts";
import { RpcError } from "./scene.ts";

/** A message of the app to the view that is not a request. */
export type ToView = Exclude<ToBoard, { t: "req" }>;
/** A message of the view to the app that is not a reply. */
export type FromView = Exclude<FromBoard, { t: "res" }>;
type Op = EngineOp["op"];

export type BoardChannel = {
  /** Sends a message to the view (held until the view is ready). */
  send(m: ToView): void;
  /** Asks the view for work; resolves with the checked value, rejects with an RpcError (the view's code and message, or
   *  `VIEW_FAILED` when the view did not answer in time, went away, or answered what is not valid: a reply that fails the
   *  validator rejects its request at once, with the validator's path in the message). */
  request<O extends Op>(op: Extract<EngineOp, { op: O }>): Promise<EngineValues[O]>;
  /** Every message of the view that is not a reply, checked; answers the function that stops listening. */
  on(listener: (m: FromView) => void): () => void;
  /** Whether the view said `ready` since it was made or last reset. */
  ready(): boolean;
};

export type ChannelOptions = {
  /** How long a request may wait for its reply (ms). */
  timeout?: number;
  /** The view is up already (an in-page view that said `ready` before the channel was made). */
  ready?: boolean;
  /** Where a dropped message is logged. */
  warn?: (text: string) => void;
};

/** How long a request waits for its reply by default: a view that has not drawn a board after this long did not start
 *  (`@aiwb/board-view` START_LIMIT). */
export const REQUEST_TIMEOUT = 20_000;

export type Channel = {
  channel: BoardChannel;
  /** A message of the view: the text of a web view's `postMessage`, or the object an in-page view hands over. */
  receive(raw: unknown): void;
  /** The view went away (a web view whose process ended, or that is loaded again): every request waiting is refused, and
   *  what is sent from now on waits for the next `ready`. */
  reset(reason?: string): void;
};

/** The request id a message that failed validation claims to answer: it is a `res` with a whole-number `id`. The text of a
 *  web view's message is parsed for it (a value that is not JSON-safe cannot be in text, but any other fault can). */
function replyId(raw: unknown): number | null {
  let m = raw;
  if (typeof raw === "string") { try { m = JSON.parse(raw); } catch { return null; } }
  if (typeof m !== "object" || m === null) return null;
  const { t, id } = m as { t?: unknown; id?: unknown };
  return t === "res" && Number.isSafeInteger(id) && (id as number) >= 0 ? (id as number) : null;
}

export function createChannel(post: (m: ToBoard) => void, options: ChannelOptions = {}): Channel {
  const timeout = options.timeout ?? REQUEST_TIMEOUT;
  const warn = options.warn ?? ((t: string) => console.warn(t));
  const listeners = new Set<(m: FromView) => void>();
  const pending = new Map<number, { op: Op; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let isReady = !!options.ready;
  let held: ToBoard[] = [];
  let seq = 0;

  const out = (m: ToBoard) => { if (isReady) post(m); else held.push(m); };

  function settle(id: number) {
    const p = pending.get(id);
    if (p) { clearTimeout(p.timer); pending.delete(id); }
    return p;
  }

  const channel: BoardChannel = {
    send: (m) => out(m),
    request(op) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (settle(id)) reject(new RpcError("VIEW_FAILED", `the board view did not answer ${op.op} in ${Math.round(timeout / 1000)} s`));
        }, timeout);
        pending.set(id, { op: op.op, resolve, reject, timer });
        out({ t: "req", id, op });
      });
    },
    on(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ready: () => isReady,
  };

  function receive(raw: unknown) {
    const r = typeof raw === "string" ? parseFromBoard(raw) : validateFromBoard(raw);
    if (!r.ok) {
      warn(`board view: dropped a message: ${r.error}`);
      // a reply to a request that is waiting is not dropped silently: its request fails now, not after the timeout
      const id = replyId(raw), p = id === null ? undefined : settle(id);
      if (p) p.reject(new RpcError("VIEW_FAILED", `the board view's answer to ${p.op} is not valid (${r.error})`));
      return;
    }
    const m = r.value;
    if (m.t === "res") {
      const p = settle(m.id);
      if (!p) return; // (answered too late, or after a reset)
      if (!m.ok) { p.reject(new RpcError(m.code, m.message)); return; }
      const v = validateEngineValue(p.op, m.value);
      if (v.ok) p.resolve(v.value);
      else { warn(`board view: dropped the answer of ${p.op}: ${v.error}`); p.reject(new RpcError("VIEW_FAILED", `the board view answered ${p.op} with what is not its value (${v.error})`)); }
      return;
    }
    if (m.t === "ready" && !isReady) {
      isReady = true;
      const queue = held; held = [];
      for (const q of queue) post(q);
    }
    for (const l of [...listeners]) l(m);
  }

  function reset(reason = "the board view went away") {
    isReady = false;
    held = held.filter((m) => m.t !== "req");
    for (const id of [...pending.keys()]) settle(id)!.reject(new RpcError("VIEW_FAILED", reason));
  }

  return { channel, receive, reset };
}
