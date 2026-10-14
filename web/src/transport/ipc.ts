// The IPC way: the functions the app's window gives the page (preload, `window.aiwbApp`) and nothing else.
import type { DesktopPick } from "../logic/chatimage.ts";
import type { AppAnswer, CallAnswer, CallBody, CallRequest, Envelope, StreamState, Transport } from "./types.ts";
import { TransportError, abortError } from "./types.ts";

/** What the window's preload gives the page. */
export interface AiwbApp {
  call(req: { id: string; server: string; method: string; path: string; body?: { json: string } | { bytes: Uint8Array; type: string } }): Promise<CallAnswer>;
  cancel(id: string): void;
  stream(open: boolean): Promise<{ ok: true }>;
  onEvents(cb: (batch: Envelope[]) => void): () => void;
  onStreamState(cb: (state: StreamState) => void): () => void;
  app(op: string, args?: unknown): Promise<AppAnswer>;
  pickImages(): Promise<DesktopPick>;
}

declare global {
  interface Window {
    /** The desktop app's preload; absent when the page is not in the app. */
    aiwbApp?: AiwbApp;
  }
}

const enc = encodeURIComponent;

/** A Blob goes over IPC as bytes. */
async function bodyOf(b: CallBody | undefined): Promise<{ json: string } | { bytes: Uint8Array; type: string } | undefined> {
  if (!b || "json" in b) return b;
  return { bytes: b.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(await b.bytes.arrayBuffer()), type: b.type };
}

const failed = (what: string, e: unknown) => new TransportError(`${what}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });

export function ipcTransport(app: AiwbApp = window.aiwbApp!): Transport {
  return {
    way: "ipc",
    async call(req: CallRequest): Promise<CallAnswer> {
      const { signal } = req;
      if (signal?.aborted) throw abortError(signal);
      const id = crypto.randomUUID();
      const body = await bodyOf(req.body);
      if (signal?.aborted) throw abortError(signal);
      let onAbort: (() => void) | undefined, aborted: Promise<never> | undefined;
      if (signal) {
        aborted = new Promise<never>((_, reject) => {
          onAbort = () => { app.cancel(id); reject(abortError(signal)); };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
      try {
        const asked = app.call({ id, server: req.server, method: req.method, path: req.path, ...(body ? { body } : {}) })
          .then((a) => a, (e) => { throw failed("the call did not reach the app", e); });
        return await (aborted ? Promise.race([asked, aborted]) : asked);
      } finally {
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        aborted?.catch(() => {});
      }
    },
    stream(onEnvelope, onState) {
      let open = true;
      const offEvents = app.onEvents((batch) => { if (open) for (const e of batch) onEnvelope(e); });
      const offState = app.onStreamState((s) => { if (open) onState(s); });
      void app.stream(true).catch(() => { if (open) onState("closed"); });
      return {
        close() {
          if (!open) return;
          open = false;
          offEvents(); offState();
          void app.stream(false).catch(() => {});
        },
      };
    },
    pictureURL: (server, chat, image) => `aiwb-picture://p/${enc(server)}/${enc(chat)}/${enc(image)}`,
    app: (op, args) => app.app(op, args).catch((e) => { throw failed("the app did not answer", e); }),
    pickImages: () => app.pickImages(),
  };
}
