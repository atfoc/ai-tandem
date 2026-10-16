// What the board side asks of the server (`BoardApi` of @aiwb/core), made over the connection module's client, for the one
// server this process is a client of. The ids here are the store's keys, which are the server's own ids (the writer treats its
// server as "this computer": nothing is a section). Refusals are thrown as core's ApiError, which the board side reads.
import { ApiError } from "@aiwb/core/api.ts";
import type { BoardApi } from "@aiwb/core/board/side.ts";
import type { CallAnswer, CallRequest } from "@aiwb/conn";

/** What the writer needs of the connection module's client (a fake in the tests). */
export type ClientLike = {
  subscribe(onEnvelope: (e: any) => void): { close(): void };
  call(req: CallRequest): Promise<CallAnswer>;
};

/** The ApiError of a refused answer (status 300 or more), as the server's JSON body says it (core/api.ts `refusal`). */
function refusal(status: number, text: string): ApiError {
  let e: any = null;
  try { e = text ? JSON.parse(text) : null; } catch {}
  const said = e?.error;
  return new ApiError(status, typeof said === "string" && said ? said : `The server answered ${status}.`, typeof said === "string" && !!said,
    typeof e?.code === "string" ? e.code : undefined);
}

export type WriterApi = BoardApi & {
  /** `POST /api/boards/{id}/release`; ifIdle: the server keeps the board when a call is open on it (`kept`). */
  release(id: string, ifIdle?: boolean): Promise<{ state: string }>;
  /** `POST /api/client/flushed`: the answer to `server_stopping`. */
  flushed(): Promise<void>;
  /** `POST /api/rpc-reply`. */
  rpcReply(id: string, reply: { result?: unknown; error?: string }): Promise<void>;
};

export function makeApi(client: ClientLike, server: string): WriterApi {
  async function send(method: CallRequest["method"], path: string, body?: unknown): Promise<CallAnswer> {
    const r = await client.call({ server, method, path, body: body === undefined ? undefined : { json: JSON.stringify(body) } });
    if (r.status >= 300) throw refusal(r.status, r.text);
    return r;
  }
  const json = <T>(r: CallAnswer): T => (r.status === 204 || !r.text ? undefined : JSON.parse(r.text)) as T;

  return {
    scene: async (id) => {
      const r = await send("GET", `/api/boards/${id}/scene`);
      return { scene: r.text ? JSON.parse(r.text) : undefined, rev: r.sceneRev || 0 };
    },
    saveScene: async (id, base, scene) => json<{ rev: number }>(await send("PUT", `/api/boards/${id}/scene?rev=${base}`, scene)).rev,
    // (the writer takes nothing by itself, D27: a board is its own only when the server gave it with a `held`)
    takeBoard: () => Promise.reject(new ApiError(409, "the headless writer takes no board by itself", true, "not_holder")),
    releaseBoard: (id) => release(id),
    release,
    flushed: async () => { await send("POST", "/api/client/flushed"); },
    rpcReply: async (id, reply) => { await send("POST", "/api/rpc-reply", { id, ...reply }); },
  };

  async function release(id: string, ifIdle = false): Promise<{ state: string }> {
    return json<{ state: string }>(await send("POST", `/api/boards/${id}/release`, ifIdle ? { ifIdle: true } : undefined));
  }
}
