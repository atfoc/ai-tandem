// SPIKE (rn-spike-electron): the page's side of the window's bridge. The preload builds the transport and
// exposes it as window.aiwbApp (spikes/electron/bridge/preload.js); this is the thin piece that makes it the
// page's Transport (web/src/transport/types.ts) again, by the two things contextBridge forces on it:
//
//   - an AbortSignal cannot cross (it arrives as {}), so the page hands over `abort`: { aborted, listen(cb) },
//     plain data and one function, and the preload does the cancel by identifier;
//   - an Error loses its name and its properties (only the message crosses), so the errors are made here:
//     the signal's reason for an abort, a TransportError for anything else.
//
// Erasable TypeScript only, so that `node --test` can load it (test/bridgeTransport.test.mjs).
import type { AppAnswer, CallAnswer, CallRequest, Envelope, StreamState, Transport } from "../../../../web/src/transport/types.ts";
import { TransportError, abortError } from "../../../../web/src/transport/types.ts";

/** What the preload exposes: the Transport minus what cannot cross. */
export interface Bridge {
  call(req: {
    server: string; method: string; path: string;
    body?: { json: string } | { bytes: ArrayBuffer | Uint8Array | Blob; type: string };
    abort?: { aborted: boolean; listen(cb: () => void): () => void };
  }): Promise<CallAnswer>;
  stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void): { close(): void };
  pictureURL(server: string, chat: string, image: string): string;
  app(op: string, args?: unknown): Promise<AppAnswer>;
  pickImages?(): Promise<any>;
}

type Body = NonNullable<CallRequest["body"]>;

// A Blob crosses by reference and the preload reads it; an ArrayBuffer is a fast copy; a Uint8Array would be
// copied element by element (about 20 times slower), so it goes as its ArrayBuffer, cut to the view first.
function crossable(b: Body | undefined) {
  if (!b || "json" in b) return b;
  const { bytes, type } = b;
  if (bytes instanceof Blob) return { bytes, type };
  const whole = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
  return { bytes: (whole ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as ArrayBuffer, type };
}

// The preload's own messages already say what failed ("the call did not reach the app: ..."); only the message crosses.
const failed = (e: unknown) => new TransportError(String((e as { message?: string })?.message ?? e), { cause: e });

export function transportFromBridge(bridge: Bridge): Transport {
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
        const a = await bridge.call({ server: req.server, method: req.method, path: req.path, ...(req.body ? { body: crossable(req.body) } : {}), ...(abort ? { abort } : {}) });
        return a;
      } catch (e) {
        if (signal?.aborted) throw abortError(signal);
        throw failed(e);
      }
    },
    stream: (onEnvelope, onState) => bridge.stream(onEnvelope, onState),
    pictureURL: (server, chat, image) => bridge.pictureURL(server, chat, image),
    app: (op, args) => bridge.app(op, args).catch((e) => { throw failed(e); }),
    ...(bridge.pickImages ? { pickImages: () => bridge.pickImages!() } : {}),
  };
}
