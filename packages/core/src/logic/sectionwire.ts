// A section's things between the wire and the page. A remote server's tree, events and answers come with that server's own ids, and the
// transport names the server apart: the entry id is a call's server or an envelope's `server`. The page keys everything by both
// (logic/keys.ts), so what comes in gets its keys here, in one place, before it enters the store;
// what goes out gets that server's own ids back (the `…Out` functions, which api.ts uses for a
// body). For this computer (no server, or LOCAL_SERVER) every function gives back what it was
// given. DOM-free.
import { LOCAL_SERVER, type Board, type BranchState, type ChatView, type Draft, type Group, type SectionTree } from "../types.ts";
import { keyOn } from "./keys.ts";

type Server = string | null | undefined;

const local = (server: Server): boolean => !server || server === LOCAL_SERVER;
/** An id that may be absent or "": only one that is there gets a key. */
const opt = <T extends string | undefined>(server: Server, id: T): T => (id ? keyOn(server, id) as T : id);

// ---- in: the page's keys

/** A group of a section (whether it is collapsed is the page's own matter, kept in the browser). */
export function groupIn(server: Server, g: Group): Group {
  if (local(server)) return g;
  return { ...g, id: keyOn(server, g.id), ...(g.parent ? { parent: keyOn(server, g.parent) } : {}) };
}

export const boardIn = (server: Server, b: Board): Board =>
  (local(server) ? b : { ...b, id: keyOn(server, b.id), group: keyOn(server, b.group) });

export function chatIn(server: Server, c: ChatView): ChatView {
  if (local(server)) return c;
  const out: ChatView = { ...c, id: keyOn(server, c.id) };
  if (c.group) out.group = keyOn(server, c.group);
  if (c.board) out.board = keyOn(server, c.board);
  if (c.forkedFrom) out.forkedFrom = keyOn(server, c.forkedFrom);
  return out;
}

export function stateIn(server: Server, st: BranchState): BranchState {
  if (local(server)) return st;
  return { ...st, chat: keyOn(server, st.chat) };
}

/** A section's tree with the page's keys. A list the server left out or sent as null is empty. The defaults are
 *  kept as they came: nothing on the page reads them by group. */
export function treeIn(server: string, t: SectionTree) {
  return {
    groups: (t.groups ?? []).map((g) => groupIn(server, g)),
    boards: (t.boards ?? []).map((b) => boardIn(server, b)),
    chats: (t.chats ?? []).map((c) => chatIn(server, c)),
    states: (t.states ?? []).filter((st) => st?.chat).map((st) => stateIn(server, st)),
    defaults: t.defaults ?? { groups: {} },
  };
}

/** The call of a board tool (an `rpc` event's params): the calling chat, its board and the board the call is for. The
 *  arguments are the agent's own and stay: what they name of a board is elements. */
export function toolCallIn<C extends { chat?: string; board?: string; target?: string }>(server: Server, call: C): C {
  if (local(server) || !call || typeof call !== "object") return call;
  return { ...call, chat: opt(server, call.chat), board: opt(server, call.board), target: opt(server, call.target) };
}

// ---- out: the server's own ids

/** A draft as its server takes it: without the boards a build that had the @ list picked in it (`mentions`, which a
 *  draft saved by one may still carry; the server takes a draft without them). */
export function draftOut(d: Draft): Draft {
  const { mentions, ...rest } = d as Draft & { mentions?: unknown };
  return mentions === undefined ? d : rest;
}
