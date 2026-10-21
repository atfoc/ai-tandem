// The voice net over a `fetch` and a socket that are given to it (architecture VC-4): the calls a page makes itself, with the key in a
// header on a phone, and with a single-use token on the socket in the web build's page-direct way. `net.native.ts` and `net.web.ts` give
// the real `fetch` and socket (the only files that may touch them: app/test/noplainhttp.test.ts) and the function that makes an
// address (`origin.ts`); the tests give fakes. Nothing here logs, and no error carries the text of the network library, a URL or a key.
import { VoiceNetError, VoiceProblemError } from "../ports.ts";
import type { NetAnswer, NetRequest, SocketEvents, VoiceNet, VoiceSocket } from "../ports.ts";
import { TOKEN_PATH, VOICES_PATH } from "../logic/protocol.ts";

/** The header the service reads the key from. */
export const KEY_HEADER = "xi-api-key";
/** The most a preview clip may be (VC-5). */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
/** The most of a voices answer that is read to learn its preview addresses. */
const VOICES_MAX_BYTES = 1024 * 1024;
/** How many preview addresses are remembered. */
const PREVIEWS_KEPT = 400;

export type ReaderLike = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void> };
export type ResponseLike = { status: number; body: { getReader(): ReaderLike } | null; text(): Promise<string> };
export type FetchInit = { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal };
export type FetchLike = (url: string, init: FetchInit) => Promise<ResponseLike>;
/** The part of a socket (RN's, the browser's) that this reads: handlers set as properties, as both have them. */
export type RawSocket = {
  onopen: (() => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: { code?: number }) => void) | null;
  onerror: (() => void) | null;
  send(text: string): void;
  close(): void;
};

export type DirectDeps = {
  fetch: FetchLike;
  /** Opens a socket at an address, with these headers when there are any (a phone's; a browser's cannot). */
  openSocket(url: string, headers?: Record<string, string>): RawSocket;
  /** The key now, read for one call and kept by no one. */
  keyOf(): Promise<string | null>;
  /** The address of a path of the service (`origin.ts`). */
  address(kind: "http" | "ws", path: string, query: Record<string, string>): string;
  /** "header": the key goes in a header of the socket (a phone). "token": a single-use token is asked first and goes in the query. */
  socketAuth: "header" | "token";
  /** Whether a preview address may be fetched at all by its scheme and place. */
  previewOk(url: string): boolean;
};

/** The error a cancelled call rejects with, as `fetch`'s own is named. */
export function abortError(): Error {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

/** What an answer's text is when only bytes are at hand: UTF-8, or Latin-1 where a runtime has no decoder (only the ASCII of a JSON's
 *  structure and of an address is read from it). */
export function decodeText(bytes: Uint8Array): string {
  if (typeof TextDecoder === "function") return new TextDecoder().decode(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** The preview addresses that came in a voices answer through this net, so that `preview` fetches no other (VC-5). */
export function createPreviews() {
  const seen = new Set<string>();
  return {
    has: (url: string) => seen.has(url),
    /** Remembers the `preview_url`s of a voices answer's text. Anything that is not that answer is ignored. */
    learn(text: string) {
      let v: unknown;
      try { v = JSON.parse(text); } catch { return; }
      const voices = typeof v === "object" && v !== null ? (v as { voices?: unknown }).voices : null;
      for (const voice of Array.isArray(voices) ? voices : []) {
        const url = typeof voice === "object" && voice !== null ? (voice as { preview_url?: unknown }).preview_url : null;
        if (typeof url !== "string" || !url) continue;
        if (seen.size >= PREVIEWS_KEPT) seen.delete(seen.values().next().value as string);
        seen.add(url);
      }
    },
  };
}

/** A fetch response as an answer. The body is read once, as chunks; `text()` takes the whole body when nothing has read it. What a
 *  library throws is replaced by `VoiceNetError` (or the abort error when the caller's signal fired). `learn` sees the whole text of a
 *  voices answer. */
export function answerOf(res: ResponseLike, signal: AbortSignal, learn?: (text: string) => void): NetAnswer {
  let taken = false;
  const failure = (): Error => (signal.aborted ? abortError() : new VoiceNetError());
  async function* chunks(): AsyncGenerator<Uint8Array> {
    if (taken || !res.body) return;
    taken = true;
    const reader = res.body.getReader();
    const stop = () => { reader.cancel().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    try {
      for (;;) {
        let r;
        try { r = await reader.read(); } catch { throw failure(); }
        if (signal.aborted) throw abortError();
        if (r.done) break;
        if (!r.value) continue;
        if (learn && keptBytes + r.value.length <= VOICES_MAX_BYTES) { kept.push(r.value); keptBytes += r.value.length; }
        yield r.value;
      }
      if (learn && kept.length) learn(decodeText(join(kept, keptBytes)));
    } finally {
      signal.removeEventListener("abort", stop);
      stop();
    }
  }
  return {
    status: res.status,
    body: { [Symbol.asyncIterator]: chunks },
    async text() {
      if (taken) return "";
      taken = true;
      let text: string;
      try { text = await res.text(); } catch { throw failure(); }
      if (signal.aborted) throw abortError();
      learn?.(text);
      return text;
    },
  };
}

function join(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

export function createDirectNet(d: DirectDeps): VoiceNet {
  const previews = createPreviews();

  async function keyFor(r: { key?: string }): Promise<string> {
    const key = r.key ?? (await d.keyOf());
    if (!key) throw new VoiceProblemError("no_key");
    return key;
  }

  async function call(init: FetchInit, url: string): Promise<ResponseLike> {
    try { return await d.fetch(url, init); } catch { throw init.signal.aborted ? abortError() : new VoiceNetError(); }
  }

  /** A single-use token for the socket (§2.2). A refusal is told to the socket's owner as the service's own socket would tell it. */
  async function token(key: string, signal: AbortSignal): Promise<string | { refused: string }> {
    const res = await call({ method: "POST", headers: { [KEY_HEADER]: key }, signal }, d.address("http", TOKEN_PATH, {}));
    if (res.status === 401) return { refused: "auth_error" };
    if (res.status === 402) return { refused: "quota_exceeded" };
    if (res.status === 429) return { refused: "rate_limited" };
    if (res.status !== 200) throw new VoiceNetError();
    try {
      const t = (JSON.parse(await res.text()) as { token?: unknown }).token;
      if (typeof t === "string" && t) return t;
    } catch { /* not a token */ }
    throw new VoiceNetError();
  }

  return {
    async request(r: NetRequest, signal: AbortSignal): Promise<NetAnswer> {
      if (signal.aborted) throw abortError();
      const key = await keyFor(r);
      if (signal.aborted) throw abortError();
      const headers: Record<string, string> = { [KEY_HEADER]: key };
      if (r.json !== undefined) headers["content-type"] = "application/json";
      const res = await call(
        { method: r.method, headers, body: r.json === undefined ? undefined : JSON.stringify(r.json), signal },
        d.address("http", r.path, r.query ?? {}),
      );
      return answerOf(res, signal, r.path === VOICES_PATH && res.status === 200 ? previews.learn : undefined);
    },

    socket(path: string, query: Record<string, string>, on: SocketEvents): VoiceSocket {
      const aborter = new AbortController();
      let raw: RawSocket | null = null;
      let open = false;
      let closed = false; // after close() the port says nothing more
      const end = (code: number) => { if (!closed) { closed = true; on.close(code); } };
      const fail = (code: number) => { if (!closed) { on.error(); end(code); } };
      void (async () => {
        try {
          const key = await d.keyOf();
          if (closed) return;
          if (!key) return fail(1008);
          let url: string;
          let headers: Record<string, string> | undefined;
          if (d.socketAuth === "header") {
            url = d.address("ws", path, query);
            headers = { [KEY_HEADER]: key };
          } else {
            const t = await token(key, aborter.signal);
            if (closed) return;
            if (typeof t !== "string") {
              on.message(JSON.stringify({ message_type: t.refused }));
              return end(1008);
            }
            url = d.address("ws", path, { ...query, token: t });
          }
          const s = d.openSocket(url, headers);
          raw = s;
          s.onopen = () => { if (closed) return; open = true; on.open(); };
          s.onmessage = (e) => { if (!closed && typeof e.data === "string") on.message(e.data); };
          s.onerror = () => { if (!closed) on.error(); };
          s.onclose = (e) => end(typeof e.code === "number" ? e.code : 1006);
        } catch {
          fail(1006);
        }
      })();
      return {
        send(text) { if (open && !closed) raw?.send(text); },
        close() {
          if (closed) return;
          closed = true;
          aborter.abort();
          try { raw?.close(); } catch { /* already closed */ }
        },
      };
    },

    async preview(url: string, signal: AbortSignal): Promise<Uint8Array> {
      if (signal.aborted) throw abortError();
      if (!d.previewOk(url) || !previews.has(url)) throw new VoiceNetError();
      const res = await call({ method: "GET", headers: {}, signal }, url);
      if (res.status !== 200) throw new VoiceNetError();
      const bytes: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of answerOf(res, signal).body) {
        size += chunk.length;
        if (size > PREVIEW_MAX_BYTES) throw new VoiceNetError();
        bytes.push(chunk);
      }
      return join(bytes, size);
    },
  };
}
