// A chat's server and what that server offers: its usable agents, their catalogs, its home and
// its default folder. The local server's are the store's own fields; another server's come by
// entry id in the snapshot's `lists` and the `server_lists` event, and stay while it is not
// connected. Also the rules of the events about a server (`server_lists`, `server_back`,
// `chat_reload`) and of a thread's load error, kept here so they are tested with no DOM.
import { LOCAL_SERVER, type AgentKind, type Catalog, type ChatView, type ServerLists, type TreeView } from "../types.ts";
import { agentOpen } from "./agentlist.ts";
import { stateLabel, type ServerState, type ServerView } from "./servers.ts";
import { withoutChat } from "./threads.ts";

/** What of the store these read. A field that is absent counts as empty. */
export type ListsState = {
  usable?: AgentKind[];
  catalogs?: Partial<Record<AgentKind, Catalog | null>>;
  home?: string;
  defaultCwd?: string;
  lists?: Record<string, ServerLists>;
  servers?: ServerView[];
};

export const THIS_COMPUTER = "This computer";
/** The name of an entry the list no longer has. */
export const UNKNOWN_SERVER = "Unknown server";

/** The entry id of a chat's server; a chat that names none is on this computer. */
export const serverOf = (c?: { server?: string }): string => c?.server || LOCAL_SERVER;

/** The entry id of the server whose lists a chat-shaped record is read by (its agents, its
 *  models). A run's own agent has a view that comes from the run's server as it is and names no
 *  server: its run's is taken. A sidebar chat's is its own. */
export const serverOfChat = (s: { runs?: Record<string, { server?: string } | undefined> }, c?: { server?: string; run?: string }): string =>
  (c?.run && s.runs?.[c.run]?.server) || serverOf(c);

const NO_AGENTS: AgentKind[] = [];
const NO_CATALOGS: ServerLists["catalogs"] = {};
let local: ServerLists | undefined; // what listsOf gave last for the local server: the same object while its four parts are the same

/** A server's lists: the local one's from the store's own fields, another's as last received,
 *  also while it is not connected. None for a server whose lists never came. The same object
 *  for the same state. */
export function listsOf(s: ListsState, server: string): ServerLists | undefined {
  if (server !== LOCAL_SERVER) return s.lists?.[server];
  const agents = s.usable ?? NO_AGENTS, catalogs = s.catalogs ?? NO_CATALOGS, home = s.home ?? "", defaultCwd = s.defaultCwd ?? "";
  if (!local || local.agents !== agents || local.catalogs !== catalogs || local.home !== home || local.defaultCwd !== defaultCwd) local = { agents, catalogs, home, defaultCwd };
  return local;
}

/** The state of a server's entry: the local one is always connected; none for an entry the list lacks. */
export const serverState = (s: ListsState, server: string): ServerState | undefined =>
  server === LOCAL_SERVER ? "connected" : s.servers?.find((v) => v.id === server)?.state;

/** Whether a server is connected: a chat on one that is not takes no call. */
export const serverConnected = (s: ListsState, server: string): boolean => serverState(s, server) === "connected";

/** What a server offers now: its lists only while it is connected (always for the local one). */
export function offered(s: ListsState, server: string): ServerLists | undefined {
  return serverConnected(s, server) ? listsOf(s, server) : undefined;
}

/** A server's name as the page says it: "This computer", or the entry's name. */
export const serverName = (s: ListsState, server: string): string =>
  server === LOCAL_SERVER ? THIS_COMPUTER : s.servers?.find((v) => v.id === server)?.name || UNKNOWN_SERVER;

const STOPPED: readonly ServerState[] = ["secret_not_accepted", "fingerprint_not_accepted", "certificate_changed", "name_not_known", "not_aiwb", "too_old", "another_server"];

/** Whether an entry's state waits for the user: no chat can be started on such a server. One that
 *  is unreachable, connecting or whose certificate was not accepted may come back by itself. */
export const waitsForUser = (state: ServerState): boolean => STOPPED.includes(state);

export const BOARD_LOCAL = "Boards and their chats are on this computer";
export const BOARD_SERVER = "A chat on a board is on the board's server";
export const RUN_SERVER = "A chat on a run is on the run's server";
export const START_UNCONFIRMED = "The first message may have arrived: the server cannot be changed until that is known";
export const SERVER_FIXED = "The server cannot be changed after the first message, in a fork or on a branch";

export type ServerOption = { id: string; label: string; disabled?: boolean; reason?: string };

/** The servers a chat or a draft run can be put on: this computer first, then every entry with
 *  its name; one that is not connected has its state as the reason, and one whose state waits for
 *  the user is disabled. */
export function serverOptions(servers: ServerView[]): ServerOption[] {
  const options: ServerOption[] = [{ id: LOCAL_SERVER, label: THIS_COMPUTER }];
  for (const v of servers) {
    if (v.local || v.id === LOCAL_SERVER) continue;
    options.push(waitsForUser(v.state) ? { id: v.id, label: v.name, disabled: true, reason: stateLabel(v.state) }
      : v.state !== "connected" ? { id: v.id, label: v.name, reason: stateLabel(v.state) } : { id: v.id, label: v.name });
  }
  return options;
}

/** A chat's server choice: every entry with its name, this computer first; one that is not
 *  connected has its state as the reason, and one whose state waits for the user is disabled. fixed: why the chat's server cannot be
 *  changed, or "". The server is the authority (it answers 409).
 *  boardServer: the entry id of the server the chat's board is on, when that is not this
 *  computer: the chat is on that server, which is then the only option. */
export function serverChoice(servers: ServerView[], c: Pick<ChatView, "board" | "run" | "start" | "locked" | "forkedFrom" | "branch" | "branches" | "role">, boardServer?: string): { options: ServerOption[]; fixed: string } {
  const options = serverOptions(servers);
  if (c.board && boardServer && boardServer !== LOCAL_SERVER) {
    return { options: [options.find((o) => o.id === boardServer) ?? { id: boardServer, label: UNKNOWN_SERVER }], fixed: BOARD_SERVER };
  }
  const fixed = c.board ? BOARD_LOCAL : c.run ? RUN_SERVER : c.start === "unconfirmed" ? START_UNCONFIRMED : !agentOpen(c) ? SERVER_FIXED : "";
  return { options, fixed };
}

/** The localStorage key of a server's recent folders. */
export const recentKey = (server: string): string => (server === LOCAL_SERVER ? "aiwb.dirs" : `aiwb.dirs.${server}`);

// ---- the events about a server (conn.ts)

/** `server_lists`: the lists by entry id with this entry's set, or with null taken out. */
export function withLists(lists: Record<string, ServerLists>, server: string, got: ServerLists | null | undefined): Record<string, ServerLists> {
  if (got) return { ...lists, [server]: got };
  if (!(server in lists)) return lists;
  const { [server]: _, ...rest } = lists;
  return rest;
}

/** A snapshot's lists; a server that sends none has none. */
export const listsFrom = (s: { lists?: Record<string, ServerLists> | null }): Record<string, ServerLists> => s.lists ?? {};

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
  chats: Record<string, { server?: string }>;
  sel: { chat: string | null };
  trees: Record<string, TreeView>;
  states: Record<string, unknown>;
  threadErrors: Record<string, ThreadError>;
};

/** `server_back`: a server is connected again, and may have restarted, so its thread versions
 *  may have started again; a thread kept from before would drop every event up to its old version.
 *  chats: the chats on that server, whose threads, tree fetches and queues are forgotten. patch:
 *  the store without their trees, branch states and load errors. load: the chat on screen when it
 *  is one of them, whose list and tree are read again at once; another one loads when it is opened. */
export function serverBack<S extends BackState>(s: S, server: string): { chats: string[]; patch: Pick<S, "trees" | "states" | "threadErrors">; load: string | null } {
  const chats = Object.keys(s.chats).filter((id) => serverOf(s.chats[id]) === server);
  const trees = { ...s.trees };
  let states = s.states, threadErrors = s.threadErrors, hadTree = false;
  for (const id of chats) {
    if (id in trees) { delete trees[id]; hadTree = true; }
    states = withoutChat(states, id);
    threadErrors = withThreadError(threadErrors, id, null);
  }
  return {
    chats,
    patch: { trees: hadTree ? trees : s.trees, states, threadErrors } as Pick<S, "trees" | "states" | "threadErrors">,
    load: s.sel.chat && chats.includes(s.sel.chat) ? s.sel.chat : null,
  };
}

/** `chat_reload`: the chat's view and the list it shows are read again; its tree too when one is
 *  kept. Nothing for a chat this page does not know. */
export function chatReload(s: { chats: Record<string, unknown>; trees: Record<string, unknown> }, chat: string): { refresh: boolean; tree: boolean } {
  const known = !!chat && !!s.chats[chat];
  return { refresh: known, tree: known && !!s.trees[chat] };
}
