// The page's side of the new boards (kind "tl", plans/better-board/design.md 2.3, 2.5, 6), one for the page:
// - it hands the `tl_sync` and `tl_closed` events of a server's stream to the link (link.ts) whose session they name, keeping
//   for a moment those of a session no link has claimed yet (an event may come before the answer of the open that made it);
// - it tells every link of a server when that server's stream goes down or comes (back) up (conn.ts says it);
// - it keeps the handle each mounted tl view gives (its camera and selection), and answers an agent's `get_view` and
//   `show_board` for a new board from it (conn.ts sends those here instead of to the board side).
import { getState } from "../state/store.ts";
import { ui, type ToolCall, type ToolResult } from "../state/ports.ts";
import { boardRef } from "../logic/context.ts";
import { ownId, sameServer } from "../logic/keys.ts";
import type { TlLinkHub, TlLinkPort } from "./link.ts";

/** A reference to an element of a new board: its tldraw id ("shape:…") or its key (the ref it was created with). */
export type TlRef = { id: string } | { key: string };

/** One element as the agent terms read it (board-tl `TlElement`, design 7.3): written as one JSON line. */
export type TlElementLine = { id: string } & Record<string, unknown>;

/** What a mounted tl view tells of itself (built in board-tl from the editor and model/read.ts). */
export interface TlViewHandle {
  /** bounds: the visible area in page coordinates; zoom: 1 = 100 %; selected: the selected elements, back to front. */
  getView(): { bounds: { x: number; y: number; w: number; h: number }; zoom: number; selected: TlElementLine[] };
  /** Fits the camera to the bounds of what the refs name; false when none of them names an element. */
  zoomTo(refs: TlRef[]): boolean;
}

/** A `tl_sync` or `tl_closed` event of a server's stream (ids the server's own). */
export type TlEvent = { type: "tl_sync"; board?: string; session?: string; messages?: unknown } | { type: "tl_closed"; board?: string; session?: string; reason?: unknown };

export type TlRegistryDeps = {
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(t: unknown): void;
  /** How long show_board waits for the view of the board it selected to mount (ms). */
  handleWait?: number;
  /** How long events of a session no link has claimed are kept (ms), and how many of them at most. */
  pendingMs?: number;
  pendingMax?: number;
};

export interface TlRegistry extends TlLinkHub {
  /** A `tl_sync` or `tl_closed` event of `server`'s stream. */
  event(server: string, m: TlEvent): void;
  /** `server`'s stream came (back) up (`hello`: true) or is not connected (false). */
  streamState(server: string, up: boolean): void;
  /** The handle of the tl view that shows `board` (the page's key), or null when it unmounts. */
  setHandle(board: string, handle: TlViewHandle | null): void;
  /** An agent's `get_view` or `show_board` for a new board (conn.ts decides, `usesTl`). */
  answer(params: ToolCall): Promise<ToolResult>;
}

/** Whether a board (the page's key) is a new board. */
export const isTl = (board?: string | null): boolean => !!board && getState().boards[board]?.kind === "tl";

/** Whether an agent's tool call goes to the registry instead of the board side: `get_view` when the chat's board is a new board,
 *  `show_board` when its target (or, with none, the chat's board) is one. */
export function usesTl(p: Partial<ToolCall> | null | undefined): boolean {
  if (!p) return false;
  if (p.name === "get_view") return isTl(p.board);
  if (p.name === "show_board") return isTl(p.target || p.board);
  return false;
}

const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

class ToolError extends Error {
  code: string;
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

export function createTlRegistry(deps: TlRegistryDeps = {}): TlRegistry {
  const st = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const ct = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  const handleWait = deps.handleWait ?? 5000, pendingMs = deps.pendingMs ?? 10_000, pendingMax = deps.pendingMax ?? 1000;

  const at = (server: string, session: string) => `${server}\n${session}`;
  const ports = new Map<string, TlLinkPort>();                          // by server + session
  const watchers = new Map<string, Set<TlLinkPort>>();                  // by server
  const down = new Set<string>();
  type Pending = { server: string; events: TlEvent[]; timer: unknown };
  const pending = new Map<string, Pending>();                           // by server + session: events no link has claimed yet
  const handles = new Map<string, TlViewHandle>();                      // by board key
  const handleWaiters = new Map<string, Set<(h: TlViewHandle | null) => void>>();

  const deliver = (port: TlLinkPort, m: TlEvent) => {
    if (m.type === "tl_sync") { if (isStrings(m.messages)) port.messages(m.messages); }
    else port.closed(typeof m.reason === "string" && m.reason ? m.reason : "closed");
  };

  function dropPending(k: string) {
    const p = pending.get(k);
    if (!p) return;
    ct(p.timer);
    pending.delete(k);
  }

  function waitHandle(board: string): Promise<TlViewHandle | null> {
    const h = handles.get(board);
    if (h) return Promise.resolve(h);
    return new Promise((resolve) => {
      let set = handleWaiters.get(board);
      if (!set) handleWaiters.set(board, (set = new Set()));
      const done = (h: TlViewHandle | null) => { ct(timer); set!.delete(done); if (!set!.size) handleWaiters.delete(board); resolve(h); };
      const timer = st(() => done(null), handleWait);
      set.add(done);
    });
  }

  function getView(call: ToolCall): string {
    const s = getState();
    const on = s.sel.board;
    const own = s.boards[call.board];
    // (the same words as the board side's for a board that is not on screen; a board of another server is not named to this one's agent)
    const looking = !on || !s.boards[on] ? "no board" : sameServer(on, call.board) ? boardRef(s.boards[on]) : "a whiteboard that is not on this server";
    if (on !== call.board) return `The user is looking at ${looking}, not ${own ? boardRef(own) : ownId(call.board)}.`;
    const lines = [`active_board: ${boardRef(own)}, kind: new`];
    const h = handles.get(on);
    if (!h) return [...lines, "view: the board is still opening on the user's screen", "selection: none"].join("\n");
    const v = h.getView();
    const r = (n: number) => Math.round(n);
    lines.push(`view: x=${r(v.bounds.x)} y=${r(v.bounds.y)} w=${r(v.bounds.w)} h=${r(v.bounds.h)} (page px), zoom ${Math.round(v.zoom * 100)}%`);
    lines.push(v.selected.length ? `selection (${v.selected.length}):\n${v.selected.map((e) => "  " + JSON.stringify(e)).join("\n")}` : "selection: none");
    return lines.join("\n");
  }

  async function showBoard(call: ToolCall): Promise<string> {
    const s = getState();
    const id = call.target || call.board;
    const b = id ? s.boards[id] : undefined;
    if (!id || !b) throw new ToolError("NO_BOARD", `no board with id ${id ? ownId(id) : ""}; call list_boards to find ids`);
    // another board opens without a chat panel: the chat is not that board's
    const cur = s.sel.chat;
    const keep = id === call.board && cur && s.chats[cur]?.board === id ? cur : null;
    ui().select({ board: id, chat: keep }); // (it selects the board and never takes it)
    const refs: TlRef[] = Array.isArray(call.args?.refs) ? call.args.refs.filter((x: any) => typeof x?.id === "string" || typeof x?.key === "string") : [];
    const shown = `shown ${boardRef(b)}`;
    if (!refs.length) return shown;
    const h = await waitHandle(id);
    if (!h) return `${shown}; it did not open in time, so the refs were not brought into view`;
    return h.zoomTo(refs) ? shown : `${shown}; no element of it matches the refs, so the view was not moved`;
  }

  return {
    event(server, m) {
      if (!m || typeof m.session !== "string" || !m.session) return;
      const k = at(server, m.session);
      const port = ports.get(k);
      if (port) { deliver(port, m); return; }
      // a session no link has claimed (yet): kept for a moment, in order
      let p = pending.get(k);
      if (!p) pending.set(k, (p = { server, events: [], timer: st(() => pending.delete(k), pendingMs) }));
      if (p.events.length < pendingMax) p.events.push(m);
    },
    streamState(server, up) {
      if (up) down.delete(server); else down.add(server);
      for (const [k, p] of [...pending]) if (p.server === server) dropPending(k); // (the sessions of the stream before are gone)
      for (const port of [...(watchers.get(server) ?? [])]) port.stream(up);
    },
    attach(server, session, port) {
      const k = at(server, session);
      ports.set(k, port);
      const p = pending.get(k);
      if (!p) return;
      dropPending(k);
      for (const m of p.events) { if (ports.get(k) !== port) break; deliver(port, m); }
    },
    detach(server, session, port) {
      const k = at(server, session);
      if (ports.get(k) === port) ports.delete(k);
    },
    watch(server, port) {
      let set = watchers.get(server);
      if (!set) watchers.set(server, (set = new Set()));
      set.add(port);
      return () => { const w = watchers.get(server); w?.delete(port); if (w && !w.size) watchers.delete(server); };
    },
    isDown: (server) => down.has(server),
    setHandle(board, handle) {
      if (!handle) { handles.delete(board); return; }
      handles.set(board, handle);
      for (const done of [...(handleWaiters.get(board) ?? [])]) done(handle);
    },
    async answer(call) {
      if (call.name === "get_view") return getView(call);
      if (call.name === "show_board") return showBoard(call);
      throw new ToolError("UNKNOWN_TOOL", `unknown tool ${call.name}`);
    },
  };
}

let theRegistry: TlRegistry | null = null;
/** The page's registry. */
export function tlRegistry(): TlRegistry { return (theRegistry ??= createTlRegistry()); }
