// The board host's loop over its one stream (design 5.2): the server's events go to the rooms (`tl_open`, `tl_sync`, `tl_close`,
// `tl_drop`), to the agents' dispatcher (`rpc`), and `server_stopping` saves every dirty room before it answers. What the rooms
// send goes out through the link (link.ts).
import type { Envelope } from "@aiwb/conn";
import { handleTool as defaultHandleTool, type HandleTool } from "./agent.ts";
import { makeHostApi, type ClientLike, type HostApi } from "./api.ts";
import { createLink, type Link } from "./link.ts";
import { createRooms, type Rooms } from "./rooms.ts";
import { answerRpc } from "./rpc.ts";
import type { BoardSchema } from "./schema.ts";

export type HostOptions = {
  client: ClientLike;
  /** The entry id of the server in the client's list. */
  server: string;
  /** Where a line of the host's own goes; never board content and never a secret. */
  log?: (line: string) => void;
  handleTool?: HandleTool;
  schema?: () => BoardSchema;
  sendGapMs?: number;
  retryMs?: number;
  saveDelayMs?: number;
  quietMs?: number;
  /** The one stream ended or its server left `connected`, after it had been connected. The host has stopped listening. */
  onEnd?: (reason: string) => void;
};

export type ServerState = { state: string; detail: string };

export type Host = {
  rooms: Rooms;
  link: Link;
  api: HostApi;
  /** Resolves with the first snapshot; rejects when the server refuses the connection in a way that waits for a person. */
  connected: Promise<void>;
  lastState(): ServerState;
  /** Saves every dirty room and sends what the link holds (at most limitMs together), then stops listening. */
  shutdown(limitMs: number): Promise<void>;
};

/** The states of a connection that do not mend by themselves (as the headless writer's loop.ts). */
const REFUSED = new Set(["certificate_not_accepted", "secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "name_not_known",
  "not_aiwb", "too_old", "another_server"]);

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

export function startHost(o: HostOptions): Host {
  const log = o.log ?? (() => {});
  const handleTool = o.handleTool ?? defaultHandleTool;
  const api = makeHostApi(o.client, o.server);
  const link = createLink({
    post: (body) => api.out(body), onGone: (sessions) => rooms.gone(sessions), log, sendGapMs: o.sendGapMs, retryMs: o.retryMs,
  });
  const rooms = createRooms({
    store: { load: (b) => api.loadSnapshot(b), save: (b, json) => api.saveSnapshot(b, json) },
    link, schema: o.schema, saveDelayMs: o.saveDelayMs, quietMs: o.quietMs, log,
  });

  let closed = false, ended = false, wasConnected = false;
  let last: ServerState = { state: "connecting", detail: "" };
  let sub: { close(): void } | null = null;
  let onConnected!: () => void, onRefused!: (e: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { onConnected = resolve; onRefused = reject; });
  connected.catch(() => {});

  async function rpc(m: any) {
    const reply = await answerRpc(m, rooms, handleTool);
    if (closed) return;
    await api.rpcReply(m.id, reply).catch((e) => { if (e?.status !== 409) log(`rpc reply failed: ${messageOf(e)}`); });
  }

  function onEvent(m: any) {
    switch (m?.type) {
      case "snapshot": wasConnected = true; onConnected(); return;
      case "tl_open": if (m.board && m.session) rooms.open(m.board, m.session); return;
      case "tl_sync": if (m.board && m.session) rooms.sync(m.board, m.session, strings(m.messages)); return;
      case "tl_close": if (m.board && m.session) rooms.close(m.board, m.session); return;
      case "tl_drop": if (m.board) void rooms.drop(m.board, String(m.reason ?? "")); return;
      case "rpc": if (m.id) void rpc(m); return;
      case "server_stopping":
        void Promise.all([rooms.flushAll(), link.flush()]).then(() => api.flushed())
          .catch((e) => log(`answering server_stopping failed: ${messageOf(e)}`));
        return;
    }
  }

  function end(reason: string) {
    if (ended) return;
    ended = true;
    sub?.close();
    o.onEnd?.(reason);
  }

  function onEnvelope(e: Envelope) {
    if (closed || ended) return;
    if ("app" in e) {
      const v: any = (e.app as any)?.type === "server_state" ? (e.app as any).server : null;
      if (!v || v.id !== o.server) return;
      last = { state: String(v.state), detail: typeof v.detail === "string" ? v.detail : "" };
      if (!wasConnected && REFUSED.has(last.state)) onRefused(new Error("the server refused the connection"));
      if (wasConnected && v.state !== "connected") end(`the connection to the server ended (${last.detail || last.state})`);
      return;
    }
    if (e.server !== o.server) return;
    try { onEvent(e.event); } catch (err) { log(`an event of the server could not be handled: ${messageOf(err)}`); }
  }

  sub = o.client.subscribe(onEnvelope);

  return {
    rooms, link, api, connected,
    lastState: () => last,
    async shutdown(limitMs) {
      if (closed) return;
      const started = Date.now();
      // (saved before the listening stops: a save is a call of the client)
      await rooms.shutdown(limitMs);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([link.flush(), new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, limitMs - (Date.now() - started))); })]);
      clearTimeout(timer);
      link.stop();
      closed = true;
      sub?.close();
    },
  };
}
