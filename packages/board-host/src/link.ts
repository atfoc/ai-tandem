// What the board host sends to the server (design 2.4): every message a room gives a session's proxy socket, and every session the
// room closed, go out in `POST /api/tl-host/out` calls. One call is in flight at a time, at least `sendGap` after the start of the
// last one; everything queued meanwhile goes together in the next call. Order is kept per session, and nothing is dropped: a call
// that fails on the way (no answer, a 5xx, the connection module's own refusal) is sent again, with the same messages in front.
// The answer's `gone` lists sessions the server no longer knows; the rooms close them (`onGone`).

/** The shortest time between the starts of two `out` calls (design 2.4). */
export const SEND_GAP_MS = 25;
/** The pause before a failed `out` call is tried again. */
export const RETRY_MS = 1_000;

export type OutBody = {
  out?: { session: string; messages: string[] }[];
  closed?: { session: string; reason: string }[];
};

/** Sends one `out` body. Resolves with the answer's `gone`; rejects with `{ retry: false }` for an answer that sending again cannot
 *  change (a 4xx), with anything else for a failure worth trying again. */
export type PostOut = (body: OutBody) => Promise<string[]>;

export type LinkOptions = {
  post: PostOut;
  onGone?: (sessions: string[]) => void;
  log?: (line: string) => void;
  sendGapMs?: number;
  retryMs?: number;
  now?: () => number;
};

export type Link = {
  /** One message of the room for a session (the proxy socket's `send`). */
  queue(session: string, text: string): void;
  /** The room closed the session (the proxy socket's `close`). Messages queued before go first; nothing after is sent. */
  closed(session: string, reason: string): void;
  /** Sends what is queued now (without waiting for the gap) and resolves when nothing is queued or in flight. */
  flush(): Promise<void>;
  /** Whether anything waits to be sent or is in flight. */
  busy(): boolean;
  /** No call is started after it. */
  stop(): void;
};

export class NoRetry extends Error {
  readonly retry = false;
}

export function createLink(o: LinkOptions): Link {
  const gap = o.sendGapMs ?? SEND_GAP_MS;
  const retryMs = o.retryMs ?? RETRY_MS;
  const now = o.now ?? Date.now;
  const log = o.log ?? (() => {});

  // (a Map keeps the order in which sessions first queued something; each session's own messages stay in order)
  let messages = new Map<string, string[]>();
  let closes = new Map<string, string>();
  const ended = new Set<string>(); // sessions closed by the room: nothing more is queued for them
  let inFlight = false, stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastStart = -Infinity;
  let waiters: (() => void)[] = [];

  const pending = () => messages.size > 0 || closes.size > 0;

  function settle() {
    if (pending() || inFlight) return;
    const w = waiters; waiters = [];
    for (const f of w) f();
  }

  function kick(after?: number) {
    if (stopped || inFlight || timer || !pending()) return;
    const wait = after ?? Math.max(0, lastStart + gap - now());
    timer = setTimeout(() => { timer = null; void send(); }, wait);
  }

  async function send() {
    if (stopped || inFlight || !pending()) { settle(); return; }
    const batchMessages = messages, batchCloses = closes;
    messages = new Map(); closes = new Map();
    const body: OutBody = {};
    if (batchMessages.size) body.out = [...batchMessages].map(([session, m]) => ({ session, messages: m }));
    if (batchCloses.size) body.closed = [...batchCloses].map(([session, reason]) => ({ session, reason }));
    inFlight = true;
    lastStart = now();
    let retry = false;
    try {
      const gone = await o.post(body);
      if (gone.length) o.onGone?.(gone);
    } catch (e: any) {
      if (e?.retry === false) {
        log(`the server refused a batch of sync messages: ${e?.message ?? String(e)}`);
      } else {
        log(`sending sync messages failed, trying again: ${e?.message ?? String(e)}`);
        // (put the batch back in front of what was queued since, session by session)
        for (const [s, m] of messages) batchMessages.set(s, [...(batchMessages.get(s) ?? []), ...m]);
        messages = batchMessages;
        for (const [s, r] of closes) batchCloses.set(s, r);
        closes = batchCloses;
        retry = true;
      }
    } finally {
      inFlight = false;
    }
    if (retry) kick(retryMs);
    else kick(waiters.length ? 0 : undefined); // (a flush does not wait for the gap)
    settle();
  }

  return {
    queue(session, text) {
      if (stopped || ended.has(session)) return;
      const q = messages.get(session);
      if (q) q.push(text); else messages.set(session, [text]);
      kick();
    },
    closed(session, reason) {
      if (stopped || ended.has(session)) return;
      ended.add(session);
      closes.set(session, reason || "closed");
      kick();
    },
    flush() {
      if (!pending() && !inFlight) return Promise.resolve();
      const p = new Promise<void>((r) => waiters.push(r));
      if (!inFlight && !stopped) {
        if (timer) { clearTimeout(timer); timer = null; }
        void send();
      }
      return p;
    },
    busy: () => pending() || inFlight,
    stop() {
      stopped = true;
      if (timer) { clearTimeout(timer); timer = null; }
      const w = waiters; waiters = [];
      for (const f of w) f();
    },
  };
}
