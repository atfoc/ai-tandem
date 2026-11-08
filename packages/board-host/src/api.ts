// What the board host asks of the server (design 2.2), over the connection module's client, for the one server it is a client of.
import type { CallAnswer, CallRequest, Envelope } from "@aiwb/conn";
import type { OutBody } from "./link.ts";

/** What the host needs of the connection module's client (a fake in the tests). */
export type ClientLike = {
  subscribe(onEnvelope: (e: Envelope) => void): { close(): void };
  call(req: CallRequest): Promise<CallAnswer>;
};

/** A refused call: the status, the server's code and words. `retry` is false for an answer that sending again cannot change. */
export class CallError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retry: boolean;
  constructor(status: number, text: string) {
    let e: any = null;
    try { e = text ? JSON.parse(text) : null; } catch {}
    super(typeof e?.error === "string" && e.error ? e.error : `the server answered ${status}`);
    this.status = status;
    this.code = typeof e?.code === "string" ? e.code : "";
    this.retry = status >= 500;
  }
}

export type HostApi = {
  /** `GET /api/tl/{id}/snapshot`: the stored snapshot as JSON text, or null when the board has none yet (204). */
  loadSnapshot(board: string): Promise<string | null>;
  /** `PUT /api/tl/{id}/snapshot` with the snapshot's JSON text. */
  saveSnapshot(board: string, json: string): Promise<void>;
  /** `POST /api/tl-host/out`: the answer's `gone`. */
  out(body: OutBody): Promise<string[]>;
  /** `POST /api/rpc-reply`. */
  rpcReply(id: string, reply: { result?: unknown; error?: string }): Promise<void>;
  /** `POST /api/client/flushed`: the answer to `server_stopping`. */
  flushed(): Promise<void>;
};

export function makeHostApi(client: ClientLike, server: string): HostApi {
  async function send(method: CallRequest["method"], path: string, json?: string): Promise<CallAnswer> {
    const r = await client.call({ server, method, path, body: json === undefined ? undefined : { json } });
    if (r.status >= 300) throw new CallError(r.status, r.text);
    return r;
  }
  const tl = (board: string) => `/api/tl/${encodeURIComponent(board)}`;
  return {
    async loadSnapshot(board) {
      const r = await send("GET", `${tl(board)}/snapshot`);
      return r.status === 204 || !r.text ? null : r.text;
    },
    async saveSnapshot(board, json) { await send("PUT", `${tl(board)}/snapshot`, json); },
    async out(body) {
      const r = await send("POST", "/api/tl-host/out", JSON.stringify(body));
      let gone: unknown;
      try { gone = r.text ? JSON.parse(r.text)?.gone : undefined; } catch {}
      return Array.isArray(gone) ? gone.filter((s): s is string => typeof s === "string") : [];
    },
    async rpcReply(id, reply) { await send("POST", "/api/rpc-reply", JSON.stringify({ id, ...reply })); },
    async flushed() { await send("POST", "/api/client/flushed"); },
  };
}
