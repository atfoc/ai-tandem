// The HTTP way: for a page loaded over http from the test host (or the mock behind the same face), which holds the
// server list and the secrets. The page's own origin is the host's address. A call is a POST with fetch, the stream
// is the browser's EventSource, a picture has a plain address on the host. Never run in the app.
import type { AppAnswer, CallAnswer, CallRequest, Envelope, StreamState, Transport } from "./types.ts";
import { TransportError } from "./types.ts";

const enc = encodeURIComponent;
const SCENE_REV = "X-AIWB-Scene-Rev";

export function httpTransport(): Transport {
  return {
    way: "http",
    async call(req: CallRequest): Promise<CallAnswer> {
      const { body } = req;
      const type = body ? ("json" in body ? "application/json" : body.type) : undefined;
      let r: Response;
      try {
        r = await fetch(`/host/call?server=${enc(req.server)}&method=${enc(req.method)}&path=${enc(req.path)}`, {
          method: "POST", cache: "no-store", signal: req.signal, keepalive: req.keepalive,
          ...(body ? { headers: { "Content-Type": type! }, body: "json" in body ? body.json : body.bytes as BodyInit } : {}),
        });
      } catch (e) {
        if (req.signal?.aborted) throw req.signal.reason ?? e;
        throw new TransportError(`the call did not reach the host: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      let text: string;
      try { text = await r.text(); }
      catch (e) {
        if (req.signal?.aborted) throw req.signal.reason ?? e;
        throw new TransportError(`the host's answer was cut: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
      const rev = r.headers.get(SCENE_REV);
      return { status: r.status, text, sceneRev: rev === null || rev === "" || !Number.isFinite(Number(rev)) ? null : Number(rev) };
    },
    stream(onEnvelope: (e: Envelope) => void, onState: (s: StreamState) => void) {
      const es = new EventSource("/host/events");
      let open = true;
      es.onopen = () => { if (open) onState("open"); };
      es.onmessage = (m) => {
        if (!open) return;
        let e: Envelope;
        try { e = JSON.parse(m.data); } catch { return; }
        onEnvelope(e);
      };
      // (an error with the browser reconnecting by itself is not a state: the host then sends everything again)
      es.onerror = () => { if (open && es.readyState === EventSource.CLOSED) onState("closed"); };
      return { close() { open = false; es.close(); } };
    },
    pictureURL: (server, chat, image) => `/host/picture/${enc(server)}/${enc(chat)}/${enc(image)}`,
    async app(op, args): Promise<AppAnswer> {
      try {
        const r = await fetch(`/host/app/${enc(op)}`, {
          method: "POST", cache: "no-store",
          ...(args === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(args) }),
        });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        throw new TransportError(`the host did not answer: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
  };
}
