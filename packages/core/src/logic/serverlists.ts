// A thing's server and what that server offers: its usable agents, their catalogs, its home and
// its default folder. This computer's are the store's own fields; another server's come by
// entry id in the snapshot's `lists` and the `server_lists` event, and stay while it is not
// connected. Also the rules of the `server_lists` event, of what is read again when a section's
// tree arrives, and of a thread's load error, kept here so they are tested with no DOM.
import { LOCAL_SERVER, type AgentKind, type Catalog, type ChatView, type ServerLists, type TreeView } from "../types.ts";
import type { ServerState, ServerView } from "./servers.ts";
import { serverOfKey } from "./keys.ts";

/** What of the store these read. A field that is absent counts as empty. */
export type ListsState = {
  usable?: AgentKind[];
  catalogs?: Partial<Record<AgentKind, Catalog | null>>;
  home?: string;
  defaultCwd?: string;
  lists?: Record<string, ServerLists>;
  servers?: ServerView[];
  sections?: Record<string, unknown>; // by entry id: the trees the page holds (logic/sections.ts)
  connected?: boolean;                // whether the page holds this computer's own tree (its snapshot, until its entry leaves `connected`); absent counts as held
};

export const THIS_COMPUTER = "This computer";
/** The name of an entry the list no longer has. */
export const UNKNOWN_SERVER = "Unknown server";

/** The entry id of the server a chat, a board or a group is on, which its key says (logic/keys.ts):
 *  LOCAL_SERVER for a thing of this computer, and for none. */
export const serverOf = (c?: { id?: string } | null): string => serverOfKey(c?.id);

const NO_AGENTS: AgentKind[] = [];
const NO_CATALOGS: ServerLists["catalogs"] = {};
let local: ServerLists | undefined; // what listsOf gave last for this computer: the same object while its four parts are the same

/** A server's lists: this computer's from the store's own fields, another's as last received,
 *  also while it is not connected. None for a server whose lists never came. The same object
 *  for the same state. */
export function listsOf(s: ListsState, server: string): ServerLists | undefined {
  if (server !== LOCAL_SERVER) return s.lists?.[server];
  const agents = s.usable ?? NO_AGENTS, catalogs = s.catalogs ?? NO_CATALOGS, home = s.home ?? "", defaultCwd = s.defaultCwd ?? "";
  if (!local || local.agents !== agents || local.catalogs !== catalogs || local.home !== home || local.defaultCwd !== defaultCwd) local = { agents, catalogs, home, defaultCwd };
  return local;
}

/** The state of a server's entry; none for an entry the list lacks. */
export const serverState = (s: ListsState, server: string): ServerState | undefined => s.servers?.find((v) => v.id === server)?.state;

/** Whether the page holds a server's tree, and so the server takes a call now: this computer's from its snapshot until its entry
 *  leaves `connected`, another server's from its snapshot until then. The entry's state says the words; it comes in an event of
 *  its own, after the snapshot. */
export const serverConnected = (s: ListsState, server: string): boolean => (server === LOCAL_SERVER ? s.connected !== false : !!s.sections?.[server]);

/** What a server offers now: its lists only while it is connected. */
export function offered(s: ListsState, server: string): ServerLists | undefined {
  return serverConnected(s, server) ? listsOf(s, server) : undefined;
}

/** A server's name as the page says it: "This computer", or the entry's name. */
export const serverName = (s: ListsState, server: string): string =>
  server === LOCAL_SERVER ? THIS_COMPUTER : s.servers?.find((v) => v.id === server)?.name || UNKNOWN_SERVER;

/** The name of the section a thing is in, which stands before its path: "" for a thing of this computer. */
export const sectionName = (s: ListsState, key: string): string => (serverOfKey(key) === LOCAL_SERVER ? "" : serverName(s, serverOfKey(key)));

export const BOARD_SERVER = "A chat on a board is on the board's server";
export const SERVER_FINAL = "A chat is on the server it was made on";

/** What the chip that names a chat's server says on hover: a chat is on its board's server, and any
 *  other on the one it was made on. Nothing moves between servers. */
export const serverFixed = (c: Pick<ChatView, "board">): string => (c.board ? BOARD_SERVER : SERVER_FINAL);

/** The localStorage key of this computer's recent folders. Another server's are not kept in the browser. */
export const RECENT_KEY = "aiwb.dirs";

// ---- the events about a server (conn.ts)

/** `server_lists`: the lists by entry id with this entry's set, or with null taken out. */
export function withLists(lists: Record<string, ServerLists>, server: string, got: ServerLists | null | undefined): Record<string, ServerLists> {
  if (got) return { ...lists, [server]: got };
  if (!(server in lists)) return lists;
  const { [server]: _, ...rest } = lists;
  return rest;
}

export type ThreadError = { code?: string; message: string };

/** What a failed thread load is kept as: the server's code, when it named one, and its sentence. */
export function threadError(e: unknown): ThreadError {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error && e.message ? e.message : typeof e === "string" && e ? e : "The thread could not be loaded.";
  return typeof code === "string" && code ? { code, message } : { message };
}

/** The load errors by chat id with this chat's set, or with null cleared; the map itself when nothing changes. */
export function withThreadError(errors: Record<string, ThreadError>, chat: string, e: ThreadError | null): Record<string, ThreadError> {
  if (e) return { ...errors, [chat]: e };
  if (!(chat in errors)) return errors;
  const { [chat]: _, ...rest } = errors;
  return rest;
}

/** A map by thread key without one thread and what is under it (a list's subagents' threads:
 *  "<list>/<sid>"); the map itself when it has none of them. */
export function withoutThread<V>(map: Record<string, V>, key: string): Record<string, V> {
  const keys = Object.keys(map);
  const kept = keys.filter((k) => k !== key && !k.startsWith(key + "/"));
  if (kept.length === keys.length) return map;
  return Object.fromEntries(kept.map((k) => [k, map[k]]));
}

type BackState = {
  chats: Record<string, unknown>;
  gone?: Record<string, true>;
  sel: { chat: string | null };
  trees: Record<string, TreeView>;
  threadErrors: Record<string, ThreadError>;
};

/** A section's tree arrived (a `section` event with a tree, or a snapshot that has the section): the server is
 *  connected, for the first time or again. It may have restarted, and its thread versions then start again: a
 *  thread kept from before would drop every event up to its old version. And the server ended this page's
 *  follows of that server's chats with the connection.
 *  chats: the chats of that server the page keeps, whose threads, tree fetches and queues are forgotten. patch: the
 *  store without their trees and load errors (their branch records are the new tree's). load: the chat on screen
 *  when it is one of them, whose list and tree are read again at once, which follows it again; another one loads when
 *  it is opened. A chat that is no longer on that server (gone: it is on screen, and not in the new tree) is none of
 *  them: what the page shows of it stays, and nothing of it can be read. */
export function sectionBack<S extends BackState>(s: S, server: string): { chats: string[]; patch: Pick<S, "trees" | "threadErrors">; load: string | null } {
  const chats = Object.keys(s.chats).filter((id) => serverOfKey(id) === server && !s.gone?.[id]);
  const trees = { ...s.trees };
  let threadErrors = s.threadErrors, hadTree = false;
  for (const id of chats) {
    if (id in trees) { delete trees[id]; hadTree = true; }
    threadErrors = withThreadError(threadErrors, id, null);
  }
  return {
    chats,
    patch: { trees: hadTree ? trees : s.trees, threadErrors } as Pick<S, "trees" | "threadErrors">,
    load: s.sel.chat && chats.includes(s.sel.chat) ? s.sel.chat : null,
  };
}
