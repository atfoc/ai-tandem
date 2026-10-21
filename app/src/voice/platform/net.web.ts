// The voice net of the web build (architecture VC-4), in the two ways it has:
//  - the desktop window (`window.aiwbVoice`): the main process makes every call and holds the key; the page sends a request and reads
//    the answer's body as events. No key, header or token passes here, and no `fetch` or socket of the page is used.
//  - a browser page served over HTTP (the test host, the mock): the page calls the stand-in under its own origin's `/voice`, with the key
//    from the memory keystore in a header; a browser's socket cannot set a header, so the socket takes a single-use token (§2.2).
// A page that is neither (a file with no bridge) has no way to the service: every call fails as "not reached".
import { VoiceNetError, VoiceProblemError } from "../ports.ts";
import type { Keystore, NetAnswer, NetRequest, SocketEvents, VoiceNet, VoiceSocket } from "../ports.ts";
import type { AiwbVoiceBridge, VoiceBridgeEvent, VoiceWindow } from "./bridge.types.ts";
import { abortError, createDirectNet, decodeText, type FetchLike, type RawSocket } from "./net.core.ts";
import { pageVoiceBase, pageVoiceURL } from "./origin.ts";

export type WebWindow = VoiceWindow & { location?: { origin?: string } };

/** The word main's failure carries (desktop/preload.js), as an error of the port. */
function bridgeError(e: unknown, signal?: AbortSignal): Error {
  const word = e instanceof Error ? /voice_[a-z_]+/.exec(e.message)?.[0] : undefined;
  if (word === "voice_no_key") return new VoiceProblemError("no_key");
  if (word === "voice_cancelled" || signal?.aborted) return abortError();
  return new VoiceNetError();
}

const bytesOf = (b: unknown): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b as ArrayBuffer));

/** The net over the desktop's bridge. One listener on the bridge while any call is open, and none otherwise. */
export function bridgeNet(bridge: AiwbVoiceBridge): VoiceNet {
  const handlers = new Map<number, (e: VoiceBridgeEvent) => void>();
  let off: (() => void) | null = null;
  let nextId = 0;

  const listen = (id: number, h: (e: VoiceBridgeEvent) => void) => {
    if (!off) off = bridge.on((e) => handlers.get(e.id)?.(e));
    handlers.set(id, h);
  };
  const unlisten = (id: number) => {
    handlers.delete(id);
    if (!handlers.size && off) { off(); off = null; }
  };

  return {
    async request(r: NetRequest, signal: AbortSignal): Promise<NetAnswer> {
      if (signal.aborted) throw abortError();
      const id = ++nextId;
      // Events may come before the call settles, so the queue exists first.
      const queue: VoiceBridgeEvent[] = [];
      let wake: (() => void) | null = null;
      let over = false;
      const push = (e: VoiceBridgeEvent) => {
        queue.push(e);
        if (e.kind === "end" || e.kind === "error") { over = true; unlisten(id); }
        wake?.();
      };
      listen(id, push);
      const cancel = () => { bridge.cancel(id); };
      signal.addEventListener("abort", cancel, { once: true });
      let status: number;
      try {
        ({ status } = await bridge.request({ id, method: r.method, path: r.path, query: r.query, json: r.json, key: r.key }));
      } catch (e) {
        signal.removeEventListener("abort", cancel);
        unlisten(id);
        throw bridgeError(e, signal);
      }
      let taken = false;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        if (taken) return;
        taken = true;
        try {
          for (;;) {
            while (!queue.length) {
              if (over) return;
              await new Promise<void>((resolve) => { wake = resolve; });
              wake = null;
            }
            const e = queue.shift() as VoiceBridgeEvent;
            if (e.kind === "data") { yield bytesOf(e.bytes); continue; }
            if (e.kind === "end") return;
            if (e.kind === "error") throw signal.aborted ? abortError() : new VoiceNetError();
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          if (!over) cancel();
          unlisten(id);
        }
      }
      return {
        status,
        body: { [Symbol.asyncIterator]: chunks },
        async text() {
          if (taken) return "";
          const parts: Uint8Array[] = [];
          let size = 0;
          for await (const c of { [Symbol.asyncIterator]: chunks }) { parts.push(c); size += c.length; }
          const all = new Uint8Array(size);
          let at = 0;
          for (const p of parts) { all.set(p, at); at += p.length; }
          return decodeText(all);
        },
      };
    },

    socket(path: string, query: Record<string, string>, on: SocketEvents): VoiceSocket {
      const id = ++nextId;
      let open = false;
      let closed = false; // after close() the port says nothing more
      const end = (code: number) => { if (closed) return; closed = true; unlisten(id); on.close(code); };
      listen(id, (e) => {
        if (closed) return;
        if (e.kind === "open") { open = true; on.open(); }
        else if (e.kind === "message") on.message(e.text);
        else if (e.kind === "error") on.error();
        else if (e.kind === "close") end(e.code);
      });
      bridge.socket.open({ id, path, query }).catch((e) => {
        if (closed) return;
        on.error();
        end(bridgeError(e) instanceof VoiceProblemError ? 1008 : 1006);
      });
      return {
        send(text) { if (open && !closed) bridge.socket.send(id, text); },
        close() {
          if (closed) return;
          closed = true;
          unlisten(id);
          bridge.socket.close(id);
        },
      };
    },

    async preview(url: string, signal: AbortSignal): Promise<Uint8Array> {
      if (signal.aborted) throw abortError();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortError()); signal.addEventListener("abort", onAbort, { once: true }); });
      try {
        return bytesOf(await Promise.race([bridge.preview(url).catch((e) => { throw bridgeError(e, signal); }), aborted]));
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** A net with no way out. */
const unreachable: VoiceNet = {
  request: () => Promise.reject(new VoiceNetError()),
  socket(_path, _query, on) {
    queueMicrotask(() => { on.error(); on.close(1006); });
    return { send() {}, close() {} };
  },
  preview: () => Promise.reject(new VoiceNetError()),
};

/** The net of a window: the bridge's when it has one; else the page-direct net over the memory keystore when the page is served from
 *  this computer or the local network; else none. */
export function webNet(win: WebWindow, keystore: Keystore): VoiceNet {
  if (win.aiwbVoice) return bridgeNet(win.aiwbVoice);
  const origin = win.location?.origin;
  const base = pageVoiceBase(origin);
  if (!base) return unreachable;
  return createDirectNet({
    fetch: ((url, init) => fetch(url, init)) as FetchLike,
    openSocket: (url) => new WebSocket(url) as unknown as RawSocket,
    keyOf: async () => (await keystore.get?.()) ?? null,
    address: (kind, path, query) => pageVoiceURL(origin, kind, path, query),
    socketAuth: "token",
    previewOk: (url) => url.startsWith("https://") || url.startsWith(`${base.http}/_preview/`),
  });
}
