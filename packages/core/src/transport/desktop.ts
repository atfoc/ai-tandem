// The page's side of the desktop window's bridge (AD-22). The preload builds the transport and exposes it as
// window.aiwbTransport (desktop/preload.js); this is the thin piece that makes it the page's Transport again, by
// the two things contextBridge forces on it:
//
//   - an AbortSignal cannot cross (it arrives as {}), so the page hands over `abort`: { aborted, listen(cb) },
//     plain data and one function, and the preload does the cancel by identifier;
//   - an Error loses its name and its properties (only the message crosses), so the errors are made here:
//     the signal's reason for an abort, a TransportError for anything else.
//
// Erasable TypeScript only, so that `node --test` can load it.
import type { DesktopPick } from "../logic/chatimage.ts";
import type { AppAnswer, CallAnswer, CallBody, CallRequest, Envelope, ServerId, StreamState, Transport } from "./types.ts";
import { TransportError, abortError } from "./types.ts";

/** What the preload exposes: the Transport minus what cannot cross (no signal, no `pictureURL`, a body as ArrayBuffer or Blob). */
export interface DesktopBridge {
  readonly way: "ipc";
  call(req: {
    server: ServerId; method: string; path: string;
    body?: { json: string } | { bytes: ArrayBuffer | Blob; type: string };
    abort?: { aborted: boolean; listen(cb: () => void): () => void };
  }): Promise<CallAnswer>;
  stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void): { close(): void };
  picture(server: ServerId, chat: string, image: string): Promise<string>;
  app(op: string, args?: unknown): Promise<AppAnswer>;
  pickImages(): Promise<DesktopPick>;
}

declare global {
  interface Window {
    /** The desktop app's bridge that builds the transport; absent when the page is not in the app. */
    aiwbTransport?: DesktopBridge;
  }
}

// A Blob crosses by reference and the preload reads it; an ArrayBuffer is a fast copy; a Uint8Array would be
// copied element by element (about 20 times slower), so it goes as its ArrayBuffer, cut to the view first.
function crossable(b: CallBody | undefined) {
  if (!b || "json" in b) return b;
  const { bytes, type } = b;
  if (bytes instanceof Blob) return { bytes, type };
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return { bytes: (whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer, type };
}

// The preload's own messages already say what failed ("the call did not reach the app: ..."); only the message crosses.
const failed = (e: unknown) => new TransportError(String((e as { message?: string })?.message ?? e), { cause: e });

export function desktopTransport(bridge: DesktopBridge): Transport {
  return {
    way: "ipc",
    async call(req: CallRequest): Promise<CallAnswer> {
      const { signal } = req;
      if (signal?.aborted) throw abortError(signal);
      const abort = signal && {
        aborted: false,
        listen(cb: () => void) {
          signal.addEventListener("abort", cb, { once: true });
          return () => signal.removeEventListener("abort", cb);
        },
      };
      try {
        return await bridge.call({ server: req.server, method: req.method, path: req.path, ...(req.body ? { body: crossable(req.body) } : {}), ...(abort ? { abort } : {}) });
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        throw failed(e);
      }
    },
    stream: (onEnvelope, onState) => bridge.stream(onEnvelope, onState),
    async picture(server, chat, image, signal) {
      if (signal?.aborted) throw abortError(signal);
      return bridge.picture(server, chat, image).catch((e) => { throw failed(e); });
    },
    app: (op, args) => bridge.app(op, args).catch((e) => { throw failed(e); }),
    pickImages: () => bridge.pickImages(),
  };
}
