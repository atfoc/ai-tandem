// The server's HTTP API (section 4.12). Every call carries this tab's client id,
// so the server knows which of its clients is calling.
//
// A call takes the page's key of the thing it is about (logic/keys.ts). For a thing of this
// computer that is its id and the path is the local one. For a thing of a section the key is
// split here: the entry id goes into the path ("/api/on/<entry id>/…": the same call, which the
// local server passes on to that server) and every id in the path and in the body is that
// server's own. What such a call answers gets the page's keys before it is handed on
// (logic/sectionwire.ts). Nothing else on the page builds a path or writes an id into a body.
import { LOCAL_SERVER } from "./types.ts";
import type { AgentKind, AttemptChanges, AttemptReport, Board, BranchState, Catalog, ChatImage, ChatView, ContextSplit, Defaults, Draft, Group, Item, PlanUsage, Reference,
  RunDelivery, RunDetail, RunGoal, RunNotes, RunSettings, RunView, SectionTree, ServerLists, Subagent, Target, TaskBrief, TiersChange, TreeLabel, TreeView } from "./types.ts";
import type { PermAnswer } from "./logic/perms.ts";
import type { ServerView } from "./logic/servers.ts";
import type { LibraryView } from "./logic/library.ts";
import { UNKNOWN_CLIENT, unknownClient } from "./logic/unknownclient.ts";
import { normBrief, normChanges, normDelivery, normDetail, normGoal, normNotes, normReport, normRun } from "./logic/runnorm.ts";
import { apiRoot, ownId, pathOf, sameServer, serverOfKey } from "./logic/keys.ts";
import { boardIn, briefIn, chatIn, detailIn, draftIn, draftOut, groupIn, notesIn, runIn, stateIn } from "./logic/sectionwire.ts";

/** GET /api/state and the `snapshot` event. groups, boards, chats, states, runs and defaults are this computer's own, and nothing else. */
export type Snapshot = {
  groups: Group[];
  boards: Board[];
  chats: ChatView[];
  runs?: RunView[]; // absent from a server that knows no runs
  sections?: Record<string, SectionTree> | null; // by entry id: the tree of each server the local server holds one of (connected, its snapshot read); no key for any other entry
  servers?: ServerView[]; // the server list (logic/servers.ts); absent from a server without one
  libraries?: LibraryView[]; // the prompt libraries, this computer's first (logic/library.ts); absent from a server before them
  defaults: Defaults;
  agents?: AgentKind[]; // the server's usable agents; absent from a server before the list
  catalogs: Partial<Record<AgentKind, Catalog | null>>;
  home: string;
  defaultCwd: string;
  dataDir: string;
  states?: BranchState[]; // one per branch of every chat; a server before the branch records sends none
  lists?: Record<string, ServerLists>; // by entry id: what each other server offers; absent from a server that relays none
};

/** GET /api/hello: the running server's version and the web client's on disk. */
export type Hello = { app: string; version: string; pid: number; webVersion: string };

export type Dirs = { path: string; parent: string; dirs: string[]; git: boolean };

export const clientId: string = crypto.randomUUID(); // one per tab load

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

/** keepalive lets the request finish while the page unloads. */
export async function call<T = void>(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
  const r = await send(method, path, body, keepalive, signal);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Bytes sent as they are, with the type they are of (an image's upload), in the place of a JSON body. */
type Raw = { raw: Blob; type: string };
const isRaw = (b: unknown): b is Raw => typeof Blob !== "undefined" && (b as Raw | null)?.raw instanceof Blob;

/** One request; the answer as it came, for who reads more than its body. Throws an ApiError when the server refused.
 *  no-store: the browser's cache is left out, which holds a write back until a pending read of the same URL has ended (a run's
 *  Delete behind the page's own read of it, on a server that does not answer). */
async function send(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<Response> {
  const r = await fetch(path, {
    method, keepalive, signal, cache: "no-store",
    headers: { "Content-Type": isRaw(body) ? body.type : "application/json", "X-AIWB-Client": clientId },
    body: body === undefined ? undefined : isRaw(body) ? body.raw : JSON.stringify(body),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => null);
    const said = e?.error;
    // The server knows this page by its open event stream, and has none: the stream is cut, or not open yet. conn.ts opens one the browser gave up
    // (logic/unknownclient.ts); the user reads a sentence in place of the server's word, which is a code.
    if (r.status === 409 && said === "unknown_client") { unknownClient(); throw new ApiError(409, UNKNOWN_CLIENT, false, "unknown_client"); }
    // (no sentence of the server's: a proxy's or a body limit's answer has only a status)
    const err = new ApiError(r.status, typeof said === "string" && said ? said : r.statusText || `The server answered ${r.status}.`, typeof said === "string" && !!said,
      typeof e?.code === "string" ? e.code : undefined);
    if (err.code === "stale" && typeof e.rev === "number" && "draft" in e) { err.rev = e.rev; err.draft = e.draft; } // a draft's save
    if (Array.isArray(e?.images)) err.images = e.images.filter((x: unknown) => typeof x === "string"); // a Send that named images the chat does not hold
    throw err;
  }
  return r;
}

/** The header of a scene's read that carries its revision. */
const SCENE_REV = "X-AIWB-Scene-Rev";

type Kind = "groups" | "boards" | "chats" | "runs";

/** The query part that names the server whose folders or plan usage a call reads (the two calls that are about no thing
 *  of a server): none for this computer. first: the query has no part before it. */
const onServer = (server?: string, first = false) => (server && server !== LOCAL_SERVER ? `${first ? "?" : "&"}server=${encodeURIComponent(server)}` : "");

/** The query that names the branch of a chat a session call is for. */
const onBranch = (branch: string) => `?branch=${encodeURIComponent(branch)}`;

/** Where a new chat is made: in a group, on a board or on a run. The key names the server too. */
export type ChatPlace = { group: string } | { board: string } | { run: string };
const placeKey = (w: ChatPlace): string => ("group" in w ? w.group : "board" in w ? w.board : w.run);
/** The place as its server takes it: the group's, the board's or the run's own id. */
const placeOut = (w: ChatPlace): ChatPlace => ("group" in w ? { group: ownId(w.group) } : "board" in w ? { board: ownId(w.board) } : { run: ownId(w.run) });

/** An id is unique on one server only: the id of a group of one server means nothing on another, or names another
 *  group there. A call that would carry one across is not made, whoever asks: nothing is moved or nested from one
 *  section to another, or between a section and this computer. on: the entry id of the call's server; keys: what its
 *  body names ("": nothing). */
const ACROSS = "Nothing is moved from one server to another.";
const across = (on: string, ...keys: string[]): boolean => keys.some((k) => !!k && serverOfKey(k) !== on);
const notAcross = <T,>(): Promise<T> => Promise.reject(new Error(ACROSS));

/** A run's view as the store keeps it: made whole (logic/runnorm.ts), then with the page's keys. */
const runOf = (key: string) => (r: RunView): RunView => runIn(serverOfKey(key), normRun(r));

export const api = {
  state: () => call<Snapshot>("GET", "/api/state"),
  hello: () => call<Hello>("GET", "/api/hello"),
  /** Starts `relaunch` (stop + launch) on the server; 409 binary_missing when its program is gone. */
  restart: () => call("POST", "/api/restart"),
  flushed: () => call("POST", "/api/client/flushed"),
  /** The answer of a board tool call (an `rpc` event), whatever server the calling agent is on: the id says which call. */
  rpcReply: (id: string, reply: { result?: unknown; error?: string }) => call("POST", "/api/rpc-reply", { id, ...reply }),
  /** server: the entry id of the server the group is made on (LOCAL_SERVER: this computer). parent: a group of that server. */
  newGroup: (server: string, name?: string, parent?: string) =>
    (across(server || LOCAL_SERVER, parent ?? "") ? notAcross<Group>()
      : call<Group>("POST", `${apiRoot(server)}/groups`, { name, parent: parent ? ownId(parent) : parent }).then((g) => groupIn(server, g))),
  renameGroup: (id: string, name: string) => call("PATCH", pathOf("groups", id), { name }),
  /** Whether a group of this computer shows collapsed, which its server keeps. A section's group has no such call: its
   *  collapse is the browser's own (store.ts setCollapsed) and is never sent. */
  collapseGroup: (id: string, collapsed: boolean) =>
    (serverOfKey(id) === LOCAL_SERVER ? call("PATCH", `/api/groups/${id}`, { collapsed }) : Promise.reject(new Error("the collapse of a section's group is not sent"))),
  /** Nests a group in parent ("" = top level), before group before ("" = last). All three are of one server. */
  moveGroup: (id: string, parent: string, before = "") =>
    (across(serverOfKey(id), parent, before) ? notAcross()
      : call("POST", `${pathOf("groups", id)}/move`, { parent: parent ? ownId(parent) : "", before: before ? ownId(before) : "" })),
  archive: (k: Kind, id: string) => call("POST", `${pathOf(k, id)}/archive`),
  unarchive: (k: Kind, id: string) => call("POST", `${pathOf(k, id)}/unarchive`),
  deleteGroup: (id: string, contents: "delete" | "keep") => call("DELETE", `${pathOf("groups", id)}?contents=${contents}`),
  /** group: the group the board is made in, which is on the server the board is made on. */
  newBoard: (group: string, name?: string, isNew = false) =>
    call<Board>("POST", `${apiRoot(serverOfKey(group))}/boards`, { name, group: ownId(group), new: isNew }).then((b) => boardIn(serverOfKey(group), b)),
  /** A board's drawing, and the revision it is stored at (0 for a board never written). */
  scene: async (id: string): Promise<{ scene: any; rev: number }> => {
    const r = await send("GET", `${pathOf("boards", id)}/scene`);
    const text = await r.text();
    return { scene: text ? JSON.parse(text) : undefined, rev: Number(r.headers.get(SCENE_REV)) || 0 };
  },
  /** Writes a board's drawing on the revision base and answers the new one. Only the board's holder may: refused with the
   *  code "not_holder" otherwise, and with "stale" when the stored drawing is not at base. */
  saveScene: (id: string, base: number, scene: unknown): Promise<number> =>
    call<{ rev: number }>("PUT", `${pathOf("boards", id)}/scene?rev=${base}`, scene).then((r) => r.rev),
  /** Asks for a board. held: it is this client's, at the revision rev. waiting: its holder was asked to hand it over, and a
   *  `held` event follows. busy (only with ifFree): another client holds it, and nothing was asked. */
  takeBoard: (id: string, ifFree = false) =>
    call<{ state: "held" | "waiting" | "busy"; rev?: number }>("POST", `${pathOf("boards", id)}/take`, ifFree ? { ifFree: true } : undefined),
  /** Lets a board go. handed: to who waited for it. free: nobody did. none: it was not this client's. */
  releaseBoard: (id: string) => call<{ state: "handed" | "free" | "none" }>("POST", `${pathOf("boards", id)}/release`),
  renameBoard: (id: string, name: string) => call<Board>("POST", `${pathOf("boards", id)}/rename`, { name }).then((b) => boardIn(serverOfKey(id), b)),
  /** group: a group of the board's own server. */
  moveBoard: (id: string, group: string) => (sameServer(id, group) ? call("PATCH", pathOf("boards", id), { group: ownId(group) }) : notAcross()),
  seenBoard: (id: string) => call("POST", `${pathOf("boards", id)}/seen`),
  deleteBoard: (id: string) => call("DELETE", pathOf("boards", id)),
  /** Shows a board's file in this computer's file manager: for a board of this computer only (400 `not_here` for a section's). */
  reveal: (id: string) => call("POST", `${pathOf("boards", id)}/reveal`),
  /** A new chat that has not started, made where `where` is: in a group, on a board or on a run, on the server that group,
   *  board or run is on. It starts with what that server remembers for the place. Refused with the server's sentence where
   *  the chat cannot be made. */
  newChat: (where: ChatPlace) => {
    const server = serverOfKey(placeKey(where));
    return call<ChatView>("POST", `${apiRoot(server)}/chats`, placeOut(where)).then((c) => chatIn(server, c));
  },
  /** A run that has not started, in a group: on the group's server from this moment on. */
  newRun: (group: string, name?: string) => call<RunView>("POST", `${apiRoot(serverOfKey(group))}/runs`, { group: ownId(group), name }).then(runOf(group)),
  /** The run's view, with its folder checked again (after a 409). */
  run: (id: string) => call<RunView>("GET", pathOf("runs", id)).then(runOf(id)),
  renameRun: (id: string, name: string) => call<RunView>("PATCH", pathOf("runs", id), { name }).then(runOf(id)),
  /** group: a group of the run's own server. */
  moveRun: (id: string, group: string) => (sameServer(id, group) ? call<RunView>("PATCH", pathOf("runs", id), { group: ownId(group) }).then(runOf(id)) : notAcross<RunView>()),
  /** Until the run starts (409 after). Only the tiers and the fields given change; another agent: the
   *  answer has that agent's defaults in all three tiers. settings are merged. */
  configureRun: (id: string, p: { agent?: AgentKind; tiers?: TiersChange; cwd?: string; settings?: Partial<RunSettings> }) =>
    call<RunView>("PATCH", pathOf("runs", id), p).then(runOf(id)),
  /** The goal being typed; a started run ignores it. It has no counter: the last save wins. */
  saveRunDraft: (id: string, d: Draft, keepalive = false) => call("PUT", `${pathOf("runs", id)}/draft`, draftOut(serverOfKey(id), d), keepalive),
  /** Answers once the start is recorded, before any agent runs: the view has started, status running and no draft. */
  startRun: (id: string, goal: string) => call<RunView>("POST", `${pathOf("runs", id)}/start`, { goal }).then(runOf(id)),
  stopRun: (id: string) => call<RunView>("POST", `${pathOf("runs", id)}/stop`).then(runOf(id)),
  /** raise: the new limit; a run stalled by its turn or cost limit resumes only with a higher one (409). */
  resumeRun: (id: string, raise?: { maxTurns: number } | { maxCost: number }) => call<RunView>("POST", `${pathOf("runs", id)}/resume`, raise).then(runOf(id)),
  deleteRun: (id: string) => call("DELETE", pathOf("runs", id)),
  /** The detail's events are sent to this page no more (the read of the detail started that). */
  unfollowRun: (id: string) => call("POST", `${pathOf("runs", id)}/unfollow`),
  /** Puts the run's result into the folder's branch (`branch`: another one). The answer is what came of
   *  it, also when that is "blocked" or "pending"; 409 while the run is going or before it started. */
  applyRun: (id: string, branch?: string) => call<RunDelivery>("POST", `${pathOf("runs", id)}/apply`, branch ? { branch } : {}).then(normDelivery),
  /** A dry run: what applying would do now. */
  runDelivery: (id: string) => call<RunDelivery>("GET", `${pathOf("runs", id)}/delivery`).then(normDelivery),
  /** A started run's detail at its version; `run_detail` events carry the later ones. */
  runDetail: (id: string, signal?: AbortSignal) =>
    call<RunDetail>("GET", `${pathOf("runs", id)}/detail`, undefined, false, signal).then((d) => detailIn(serverOfKey(id), normDetail(d))),
  runGoal: (id: string) => call<RunGoal>("GET", `${pathOf("runs", id)}/goal`).then(normGoal),
  /** A task's brief: revision rev, or without it the one in force. */
  taskBrief: (run: string, task: string, rev?: number) =>
    call<TaskBrief>("GET", `${pathOf("runs", run)}/tasks/${task}/brief${rev === undefined ? "" : `?rev=${rev}`}`).then((b) => briefIn(serverOfKey(run), normBrief(b))),
  /** 404 while the attempt has no result. */
  attemptReport: (run: string, task: string, n: number) => call<AttemptReport>("GET", `${pathOf("runs", run)}/tasks/${task}/attempts/${n}/report`).then(normReport),
  /** 404 for a task that only reports, and while nothing is committed. */
  attemptChanges: (run: string, task: string, n: number) => call<AttemptChanges>("GET", `${pathOf("runs", run)}/tasks/${task}/attempts/${n}/changes`).then(normChanges),
  runNotes: (run: string, v: number) => call<RunNotes>("GET", `${pathOf("runs", run)}/notes/${v}`).then((n) => notesIn(serverOfKey(run), normNotes(n))),
  /** A branch's items and subagents. The answer names the branch served, and brings its record. */
  items: (id: string, branch: string) =>
    call<{ version: number; items: Item[]; subagents?: Subagent[]; branch?: string; state?: BranchState }>("GET", `${pathOf("chats", id)}/items${onBranch(branch)}`)
      .then((r) => (r?.state ? { ...r, state: stateIn(serverOfKey(id), r.state) } : r)),
  subItems: (chat: string, branch: string, sid: string) =>
    call<{ version: number; items: Item[] }>("GET", `${pathOf("chats", chat)}/subagents/${sid}/items${onBranch(branch)}`),
  chat: (id: string) => call<ChatView>("GET", pathOf("chats", id)).then((c) => chatIn(serverOfKey(id), c)),
  /** Ends this client's follow of a chat (a read of its items or tree started it): its content events stop. */
  unfollowChat: (id: string) => call("POST", `${pathOf("chats", id)}/unfollow`),
  openChat: (id: string, branch: string) => call("POST", `${pathOf("chats", id)}/open${onBranch(branch)}`),
  /** target: the point the message goes to; without it, the end of branch. The server refuses
   *  a target together with the query, so the branch is named in one of the two only.
   *  context: the block in front of a board chat's message, which names boards by their server's own ids (board.ts buildContext).
   *  images: the images the message carries, as its draft named them. Refused with the codes "image_id", "image_limit",
   *  "image_model" and "image_missing": the error of the last has the ids of the images the chat does not hold (images). */
  send: (id: string, branch: string, text: string, context: string, references: Reference[] = [], target?: Target & { model?: string; effort?: string }, images: readonly ChatImage[] = []) =>
    call("POST", `${pathOf("chats", id)}/messages${target ? "" : onBranch(branch)}`, {
      text, context,
      ...(references.length ? { references } : {}),
      ...(images.length ? { images } : {}),
      ...(target ? { target: { branch: target.branch, at: target.at, new: target.new,
        ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) } } : {}),
    }),
  /** A change of an unstarted chat's choices, the same call for a chat of this computer and of a section. The answer's chat has what the
   *  server made of it (another agent: that agent's model and effort). A chat's server is no choice: it is where the chat was made. */
  configure: (id: string, branch: string, p: { agent?: AgentKind; model?: string; effort?: string; cwd?: string; subDepth?: number; subCap?: number }) =>
    call<{ ok: boolean; chat?: ChatView }>("PATCH", `${pathOf("chats", id)}${onBranch(branch)}`, p).then((r) => (r?.chat ? { ...r, chat: chatIn(serverOfKey(id), r.chat) } : r)),
  /** Saves a branch's draft on the counter base and answers the new counter (rev). Refused with the code "stale" when the draft
   *  was changed elsewhere: the error then has the server's counter (rev) and its draft. missing: the ids of the images the draft
   *  named that the chat does not hold; it was saved without them. */
  saveDraft: (id: string, branch: string, d: Draft, base: number, keepalive = false): Promise<{ rev: number; missing?: string[] }> =>
    call<{ rev: number; missing?: unknown }>("PUT", `${pathOf("chats", id)}/draft${onBranch(branch)}&rev=${base}`, draftOut(serverOfKey(id), d), keepalive)
      .then((r) => ({ rev: r.rev, ...(Array.isArray(r.missing) && r.missing.length ? { missing: r.missing.filter((x): x is string => typeof x === "string") } : {}) }),
        (e) => { if (e instanceof ApiError && e.draft) e.draft = draftIn(serverOfKey(id), e.draft); throw e; }),
  /** Uploads an image to a chat (id: the top-level chat's): the body is the file's bytes, as they are. Answers the image as the
   *  chat holds it, which is what a draft and a message name. The same call for a chat of a section, which the local server
   *  passes on and answers as that server does. Refused with the codes "image_too_large" (413), "image_type" (415) and "image_cap"
   *  (409: too many images of the chat were never sent). For a chat of a section also as every call that cannot be made:
   *  "server_unreachable" (503: not connected, or too old; nothing was read or sent), "no_answer" (504), "bad_answer" (502) and
   *  "not_found" (404: the chat is gone there). The chat of a run's agent takes none (409).
   *  Whatever the refusal, the image leaves the strip and the error line says the server's sentence (uploads.ts). */
  uploadImage: (id: string, file: Blob, name: string, type: string, signal?: AbortSignal) =>
    call<ChatImage>("POST", `${pathOf("chats", id)}/images?name=${encodeURIComponent(name)}`, { raw: file, type }, false, signal),
  renameChat: (id: string, name: string) => call("PATCH", pathOf("chats", id), { name }),
  /** group: a group of the chat's own server. */
  moveChat: (id: string, group: string) => (sameServer(id, group) ? call("PATCH", pathOf("chats", id), { group: ownId(group) }) : notAcross()),
  interrupt: (id: string, branch: string) => call("POST", `${pathOf("chats", id)}/interrupt${onBranch(branch)}`),
  decide: (id: string, branch: string, answer: PermAnswer) => call("POST", `${pathOf("chats", id)}/permission${onBranch(branch)}`, answer),
  deleteChat: (id: string) => call("DELETE", pathOf("chats", id)),
  tree: (id: string) => call<TreeView>("GET", `${pathOf("chats", id)}/tree`),
  /** Blank text removes the label. Answers all the chat's labels. */
  setLabel: (id: string, branch: string, item: number, text: string) => call<{ labels: TreeLabel[] }>("PUT", `${pathOf("chats", id)}/label`, { branch, item, text }),
  /** Forks branch at item count `at` to a new chat, on the chat's own server; message: the user message that becomes its draft. */
  fork: (id: string, branch: string, at: number, message?: number) =>
    call<ChatView>("POST", `${pathOf("chats", id)}/fork`, { branch, at, message }).then((c) => chatIn(serverOfKey(id), c)),
  /** server: the entry id of the server whose folders are read; without it this computer's. */
  dirs: (path: string, server?: string) => call<Dirs>("GET", `/api/dirs?path=${encodeURIComponent(path)}${onServer(server)}`),
  contextSplit: (id: string, branch: string, fresh = false) => call<ContextSplit>("GET", `${pathOf("chats", id)}/context${onBranch(branch)}${fresh ? "&fresh=1" : ""}`),
  usage: (agent: AgentKind, fresh = false, server?: string) => call<PlanUsage>("GET", `/api/usage/${agent}${fresh ? "?fresh=1" : ""}${onServer(server, !fresh)}`),
};
