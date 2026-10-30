// The server API (the client API of every server), through the transport. A call takes the page's key of the
// thing it is about (logic/keys.ts). For a thing of this computer that is its id; for a thing of a section the key
// is split here: the entry id is the server the call goes to (the transport's argument, no part of the path) and
// every id in the path and in the body is that server's own. What a section's call answers gets the page's keys
// (logic/sectionwire.ts). Nothing else on the page builds a path or writes an id into a body.
import { LOCAL_SERVER, type Writer } from "./types.ts";
import type { AgentKind, Board, BranchState, Catalog, ChatImage, ChatView, ContextSplit, Defaults, Draft, Group, Item, PlanUsage, Reference,
  Subagent, Target, TreeLabel, TreeView } from "./types.ts";
import type { PermAnswer } from "./logic/perms.ts";
import type { LibraryTree } from "./logic/library.ts";
import { isBytesFile, type UploadFile } from "./logic/chatimage.ts";
import { ownId, pathOf, sameServer, serverOfKey } from "./logic/keys.ts";
import { boardIn, chatIn, draftOut, groupIn, stateIn } from "./logic/sectionwire.ts";
import { transport, type CallAnswer, type CallBody } from "./transport/index.ts";

/** A server's own snapshot (GET /api/state and the `snapshot` event): its own groups, boards, chats and the rest, with its
 *  own ids. */
export type Snapshot = {
  groups: Group[];
  boards: Board[];
  chats: ChatView[];
  library?: LibraryTree | null; // this server's prompt library; null or absent for a server without one
  libraryNotice?: string;       // why the library's file was set aside when the server started
  defaults: Defaults;
  agents?: AgentKind[]; // the server's usable agents
  catalogs: Partial<Record<AgentKind, Catalog | null>>;
  home: string;
  defaultCwd: string;
  states?: BranchState[]; // one per branch of every chat
};

export type Dirs = { path: string; parent: string; dirs: string[] };

/** An API error: the server's message, with the HTTP status and, when the server names one, its code. */
export class ApiError extends Error {
  status: number;
  /** The message is the server's own sentence (its JSON `error`), not the status line. */
  said: boolean;
  code?: string;
  /** With the code "stale" of a draft's save: the server's counter and its draft, null for none. */
  rev?: number;
  draft?: Draft | null;
  /** With the code "image_missing" of a Send: the ids of the images the chat does not hold. */
  images?: string[];
  constructor(status: number, msg: string, said = true, code?: string) { super(msg); this.status = status; this.said = said; if (code !== undefined) this.code = code; }
}

/** The ApiError of a refused answer (status 300 or more), as the server's JSON body says it. */
function refusal(status: number, text: string): ApiError {
  let e: any = null;
  try { e = text ? JSON.parse(text) : null; } catch {}
  const said = e?.error;
  // (no sentence of the server's: a proxy's or a body limit's answer has only a status)
  const err = new ApiError(status, typeof said === "string" && said ? said : `The server answered ${status}.`, typeof said === "string" && !!said,
    typeof e?.code === "string" ? e.code : undefined);
  if (err.code === "stale" && typeof e.rev === "number" && "draft" in e) { err.rev = e.rev; err.draft = e.draft; } // a draft's save
  if (Array.isArray(e?.images)) err.images = e.images.filter((x: unknown) => typeof x === "string"); // a Send that named images the chat does not hold
  return err;
}

/** Bytes sent as they are, with the type they are of (an image's upload), in the place of a JSON body. */
type Raw = { raw: UploadFile; type: string };
const isRaw = (b: unknown): b is Raw => (typeof Blob !== "undefined" && (b as Raw | null)?.raw instanceof Blob) || isBytesFile((b as Raw | null)?.raw);
const bodyOf = (b: unknown): CallBody | undefined =>
  b === undefined ? undefined : isRaw(b) ? { bytes: isBytesFile(b.raw) ? b.raw.bytes : b.raw as Blob, type: b.type } : { json: JSON.stringify(b) };

/** One call to a server; the answer as it came, for who reads more than its body. Throws an ApiError when the server refused
 *  (or the way made up an answer for it: not connected, no answer). keepalive lets the request finish while the page unloads. */
async function send(server: string, method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<CallAnswer> {
  const r = await transport().call({ server, method: method as "GET", path, body: bodyOf(body), keepalive, signal });
  if (r.status >= 300) throw refusal(r.status, r.text);
  return r;
}

/** A call to the server `server` (an entry id, LOCAL_SERVER for this computer): its answer's JSON, undefined for none. */
export async function call<T = void>(server: string, method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
  const r = await send(server, method, path, body, keepalive, signal);
  return (r.status === 204 || !r.text ? undefined : JSON.parse(r.text)) as T;
}

/** An operation of the app (the server list, the owner's things): its answer's JSON; an ApiError when it was refused. */
export async function appCall<T = void>(op: string, args?: unknown): Promise<T> {
  const r = await transport().app(op, args);
  if (r.status >= 300) throw refusal(r.status, r.text);
  return (r.text ? JSON.parse(r.text) : undefined) as T;
}

type Kind = "groups" | "boards" | "chats";

/** A call about a thing of the page: to the server its key names, on the thing's path (and what follows it). */
const thing = <T = void>(kind: Kind, key: string, method: string, rest = "", body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> => {
  const p = pathOf(kind, key);
  return call<T>(p.server, method, p.path + rest, body, keepalive, signal);
};

/** The query part of the call that reads the folders or the plan usage of a server: the server is the call's. */
const onBranch = (branch: string) => `?branch=${encodeURIComponent(branch)}`;

/** Where a new chat is made: in a group or on a board. The key names the server too. */
export type ChatPlace = { group: string } | { board: string };
const placeKey = (w: ChatPlace): string => ("group" in w ? w.group : w.board);
/** The place as its server takes it: the group's or the board's own id. */
const placeOut = (w: ChatPlace): ChatPlace => ("group" in w ? { group: ownId(w.group) } : { board: ownId(w.board) });

/** An id is unique on one server only: the id of a group of one server means nothing on another, or names another
 *  group there. A call that would carry one across is not made, whoever asks: nothing is moved or nested from one
 *  section to another, or between a section and this computer. on: the entry id of the call's server; keys: what its
 *  body names ("": nothing). */
const ACROSS = "Nothing is moved from one server to another.";
const across = (on: string, ...keys: string[]): boolean => keys.some((k) => !!k && serverOfKey(k) !== on);
const notAcross = <T,>(): Promise<T> => Promise.reject(new Error(ACROSS));

export const api = {
  /** The answer to a server's `server_stopping`: its board writes are on the server. server: the server whose event it answers. */
  flushed: (server: string = LOCAL_SERVER) => call<void>(server, "POST", "/api/client/flushed"),
  /** The answer of a board tool call (an `rpc` event), whatever server the calling agent is on: the id says which call. server: the
   *  server whose event the call was. */
  rpcReply: (id: string, reply: { result?: unknown; error?: string }, server: string = LOCAL_SERVER) => call<void>(server, "POST", "/api/rpc-reply", { id, ...reply }),
  /** server: the entry id of the server the group is made on (LOCAL_SERVER: this computer). parent: a group of that server. */
  newGroup: (server: string, name?: string, parent?: string) =>
    (across(server || LOCAL_SERVER, parent ?? "") ? notAcross<Group>()
      : call<Group>(server || LOCAL_SERVER, "POST", "/api/groups", { name, parent: parent ? ownId(parent) : parent }).then((g) => groupIn(server, g))),
  renameGroup: (id: string, name: string) => thing("groups", id, "PATCH", "", { name }),
  /** Nests a group in parent ("" = top level), before group before ("" = last). All three are of one server. */
  moveGroup: (id: string, parent: string, before = "") =>
    (across(serverOfKey(id), parent, before) ? notAcross()
      : thing("groups", id, "POST", "/move", { parent: parent ? ownId(parent) : "", before: before ? ownId(before) : "" })),
  archive: (k: Kind, id: string) => thing(k, id, "POST", "/archive"),
  unarchive: (k: Kind, id: string) => thing(k, id, "POST", "/unarchive"),
  deleteGroup: (id: string, contents: "delete" | "keep") => thing("groups", id, "DELETE", `?contents=${contents}`),
  /** group: the group the board is made in, which is on the server the board is made on. */
  newBoard: (group: string, name?: string, isNew = false) =>
    call<Board>(serverOfKey(group), "POST", "/api/boards", { name, group: ownId(group), new: isNew }).then((b) => boardIn(serverOfKey(group), b)),
  /** A board's drawing, and the revision it is stored at (0 for a board never written). */
  scene: async (id: string): Promise<{ scene: any; rev: number }> => {
    const p = pathOf("boards", id), r = await send(p.server, "GET", `${p.path}/scene`);
    return { scene: r.text ? JSON.parse(r.text) : undefined, rev: r.sceneRev || 0 };
  },
  /** Writes a board's drawing on the revision base and answers the new one. Only the board's holder may: refused with the
   *  code "not_holder" otherwise, and with "stale" when the stored drawing is not at base. */
  saveScene: (id: string, base: number, scene: unknown): Promise<number> =>
    thing<{ rev: number }>("boards", id, "PUT", `/scene?rev=${base}`, scene).then((r) => r.rev),
  /** Asks for a board. held: it is this client's, at the revision rev. waiting: its holder was asked to hand it over, and a
   *  `held` event follows. busy (only with ifFree): another client holds it, and nothing was asked. */
  takeBoard: (id: string, ifFree = false) =>
    thing<{ state: "held" | "waiting" | "busy"; rev?: number }>("boards", id, "POST", "/take", ifFree ? { ifFree: true } : undefined),
  /** Lets a board go. handed: to who waited for it. free: nobody did. none: it was not this client's. With ifIdle (the headless writer's
   *  quiet time): kept when nobody waits for the board and a call on it is open; nothing changes then. */
  releaseBoard: (id: string, ifIdle = false) =>
    thing<{ state: "handed" | "free" | "none" | "kept" }>("boards", id, "POST", "/release", ifIdle ? { ifIdle: true } : undefined),
  /** Follows a board from now on (its `scene` and `writer` events reach this client), whether or not this client holds it: the board is
   *  on its screen. Again is no change. Answers the stored revision and who writes now. */
  followBoard: (id: string) =>
    thing<{ rev?: number; writer?: string }>("boards", id, "POST", "/follow").then((r): { rev: number; writer: Writer } => ({
      rev: typeof r?.rev === "number" ? r.rev : 0, writer: r?.writer === "window" || r?.writer === "headless" ? r.writer : "",
    })),
  /** Ends the follow of a board; no follow is no error. */
  unfollowBoard: (id: string) => thing("boards", id, "POST", "/unfollow"),
  renameBoard: (id: string, name: string) => thing<Board>("boards", id, "POST", "/rename", { name }).then((b) => boardIn(serverOfKey(id), b)),
  /** group: a group of the board's own server. */
  moveBoard: (id: string, group: string) => (sameServer(id, group) ? thing("boards", id, "PATCH", "", { group: ownId(group) }) : notAcross()),
  seenBoard: (id: string) => thing("boards", id, "POST", "/seen"),
  deleteBoard: (id: string) => thing("boards", id, "DELETE"),
  /** Shows a board's file in this computer's file manager (an owner's thing of the app): for a board of this computer only
   *  (a section's server is on another machine). */
  reveal: async (id: string) => {
    if (serverOfKey(id) !== LOCAL_SERVER) throw new ApiError(400, "Only a board of this computer can be shown in its file manager.", true, "not_here");
    await appCall("owner.reveal", { board: ownId(id) });
  },
  /** A new chat that has not started, made where `where` is: in a group or on a board, on the server that group
   *  or board is on. It starts with what that server remembers for the place. Refused with the server's sentence where
   *  the chat cannot be made. */
  newChat: (where: ChatPlace) => {
    const server = serverOfKey(placeKey(where));
    return call<ChatView>(server, "POST", "/api/chats", placeOut(where)).then((c) => chatIn(server, c));
  },
  /** A branch's items and subagents. The answer names the branch served, and brings its record. */
  items: (id: string, branch: string) =>
    thing<{ version: number; items: Item[]; subagents?: Subagent[]; branch?: string; state?: BranchState }>("chats", id, "GET", `/items${onBranch(branch)}`)
      .then((r) => (r?.state ? { ...r, state: stateIn(serverOfKey(id), r.state) } : r)),
  subItems: (chat: string, branch: string, sid: string) =>
    thing<{ version: number; items: Item[] }>("chats", chat, "GET", `/subagents/${sid}/items${onBranch(branch)}`),
  chat: (id: string) => thing<ChatView>("chats", id, "GET").then((c) => chatIn(serverOfKey(id), c)),
  openChat: (id: string, branch: string) => thing("chats", id, "POST", `/open${onBranch(branch)}`),
  /** target: the point the message goes to; without it, the end of branch. The server refuses
   *  a target together with the query, so the branch is named in one of the two only.
   *  context: the block in front of a board chat's message, which names boards by their server's own ids (board.ts buildContext).
   *  images: the images the message carries, as its draft named them. Refused with the codes "image_id", "image_limit",
   *  "image_model" and "image_missing": the error of the last has the ids of the images the chat does not hold (images). */
  send: (id: string, branch: string, text: string, context: string, references: Reference[] = [], target?: Target & { model?: string; effort?: string }, images: readonly ChatImage[] = []) =>
    thing("chats", id, "POST", `/messages${target ? "" : onBranch(branch)}`, {
      text, context,
      ...(references.length ? { references } : {}),
      ...(images.length ? { images } : {}),
      ...(target ? { target: { branch: target.branch, at: target.at, new: target.new,
        ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) } } : {}),
    }),
  /** A change of an unstarted chat's choices, the same call for a chat of this computer and of a section. The answer's chat has what the
   *  server made of it (another agent: that agent's model and effort). A chat's server is no choice: it is where the chat was made. */
  configure: (id: string, branch: string, p: { agent?: AgentKind; model?: string; effort?: string; cwd?: string; subDepth?: number; subCap?: number }) =>
    thing<{ ok: boolean; chat?: ChatView }>("chats", id, "PATCH", onBranch(branch), p).then((r) => (r?.chat ? { ...r, chat: chatIn(serverOfKey(id), r.chat) } : r)),
  /** Saves a branch's draft on the counter base and answers the new counter (rev). Refused with the code "stale" when the draft
   *  was changed elsewhere: the error then has the server's counter (rev) and its draft. missing: the ids of the images the draft
   *  named that the chat does not hold; it was saved without them. */
  saveDraft: (id: string, branch: string, d: Draft, base: number, keepalive = false): Promise<{ rev: number; missing?: string[] }> =>
    thing<{ rev: number; missing?: unknown }>("chats", id, "PUT", `/draft${onBranch(branch)}&rev=${base}`, draftOut(d), keepalive)
      .then((r) => ({ rev: r.rev, ...(Array.isArray(r.missing) && r.missing.length ? { missing: r.missing.filter((x): x is string => typeof x === "string") } : {}) })),
  /** Uploads an image to a chat (id: the top-level chat's): the body is the file's bytes, as they are. Answers the image as the
   *  chat holds it, which is what a draft and a message name. The same call for a chat of this computer and of a section. Refused with the codes
   *  "image_too_large" (413), "image_type" (415) and "image_cap" (409: too many images of the chat were never sent). For a chat of a section also as
   *  every call that cannot be made: "server_unreachable" (503: not connected, or too old; nothing was read or sent), "no_answer" (504),
   *  "bad_answer" (502) and "not_found" (404: the chat is gone there).
   *  Whatever the refusal, the image leaves the strip and the error line says the server's sentence (uploads.ts). */
  uploadImage: (id: string, file: UploadFile, name: string, type: string, signal?: AbortSignal) =>
    thing<ChatImage>("chats", id, "POST", `/images?name=${encodeURIComponent(name)}`, { raw: file, type }, false, signal),
  renameChat: (id: string, name: string) => thing("chats", id, "PATCH", "", { name }),
  /** group: a group of the chat's own server. */
  moveChat: (id: string, group: string) => (sameServer(id, group) ? thing("chats", id, "PATCH", "", { group: ownId(group) }) : notAcross()),
  interrupt: (id: string, branch: string) => thing("chats", id, "POST", `/interrupt${onBranch(branch)}`),
  decide: (id: string, branch: string, answer: PermAnswer) => thing("chats", id, "POST", `/permission${onBranch(branch)}`, answer),
  deleteChat: (id: string) => thing("chats", id, "DELETE"),
  tree: (id: string) => thing<TreeView>("chats", id, "GET", "/tree"),
  /** Blank text removes the label. Answers all the chat's labels. */
  setLabel: (id: string, branch: string, item: number, text: string) => thing<{ labels: TreeLabel[] }>("chats", id, "PUT", "/label", { branch, item, text }),
  /** Forks branch at item count `at` to a new chat, on the chat's own server; message: the user message that becomes its draft. */
  fork: (id: string, branch: string, at: number, message?: number) =>
    thing<ChatView>("chats", id, "POST", "/fork", { branch, at, message }).then((c) => chatIn(serverOfKey(id), c)),
  /** server: the entry id of the server whose folders are read; without it this computer's. */
  dirs: (path: string, server: string = LOCAL_SERVER) => call<Dirs>(server, "GET", `/api/dirs?path=${encodeURIComponent(path)}`),
  contextSplit: (id: string, branch: string, fresh = false) => thing<ContextSplit>("chats", id, "GET", `/context${onBranch(branch)}${fresh ? "&fresh=1" : ""}`),
  usage: (agent: AgentKind, fresh = false, server: string = LOCAL_SERVER) => call<PlanUsage>(server, "GET", `/api/usage/${agent}${fresh ? "?fresh=1" : ""}`),
};
