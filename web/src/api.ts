// The server's HTTP API (section 4.12). Every call carries this tab's client id,
// so the server knows which of its clients is calling.
import { LOCAL_SERVER } from "./types.ts";
import type { AgentKind, AttemptChanges, AttemptReport, Board, BranchState, Catalog, ChatView, ContextSplit, Defaults, Draft, Group, Item, ModelChoice, PlanUsage, Reference,
  RunDelivery, RunDetail, RunGoal, RunNotes, RunSettings, RunView, ServerLists, Subagent, Target, TaskBrief, Tier, TreeLabel, TreeView } from "./types.ts";
import type { PermAnswer } from "./logic/perms.ts";
import type { ServerView } from "./logic/servers.ts";
import { UNKNOWN_CLIENT, unknownClient } from "./logic/unknownclient.ts";
import { normBrief, normChanges, normDelivery, normGoal, normNotes, normReport } from "./logic/runnorm.ts";

/** GET /api/state and the `snapshot` event. */
export type Snapshot = {
  groups: Group[];
  boards: Board[];
  chats: ChatView[];
  runs?: RunView[]; // absent from a server that knows no runs
  servers?: ServerView[]; // the server list (logic/servers.ts); absent from a server without one
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
  constructor(status: number, msg: string, said = true, code?: string) { super(msg); this.status = status; this.said = said; if (code !== undefined) this.code = code; }
}

/** keepalive lets the request finish while the page unloads. */
export async function call<T = void>(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
  const r = await send(method, path, body, keepalive, signal);
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** One request; the answer as it came, for who reads more than its body. Throws an ApiError when the server refused.
 *  no-store: the browser's cache is left out, which holds a write back until a pending read of the same URL has ended (a run's
 *  Delete behind the page's own read of it, on a server that does not answer). */
async function send(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<Response> {
  const r = await fetch(path, {
    method, keepalive, signal, cache: "no-store",
    headers: { "Content-Type": "application/json", "X-AIWB-Client": clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
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
    throw err;
  }
  return r;
}

/** The header of a scene's read that carries its revision. */
const SCENE_REV = "X-AIWB-Scene-Rev";

type Kind = "groups" | "boards" | "chats" | "runs";

/** The query part that names the server a call is for: none for this computer. first: the query has no part before it. */
const onServer = (server?: string, first = false) => (server && server !== LOCAL_SERVER ? `${first ? "?" : "&"}server=${encodeURIComponent(server)}` : "");

/** The query that names the branch of a chat a session call is for. */
const onBranch = (branch: string) => `?branch=${encodeURIComponent(branch)}`;

export const api = {
  state: () => call<Snapshot>("GET", "/api/state"),
  hello: () => call<Hello>("GET", "/api/hello"),
  /** Starts `relaunch` (stop + launch) on the server; 409 binary_missing when its program is gone. */
  restart: () => call("POST", "/api/restart"),
  flushed: () => call("POST", "/api/client/flushed"),
  rpcReply: (id: string, reply: { result?: unknown; error?: string }) => call("POST", "/api/rpc-reply", { id, ...reply }),
  newGroup: (name?: string, parent?: string) => call<Group>("POST", "/api/groups", { name, parent }),
  updateGroup: (id: string, p: { name?: string; collapsed?: boolean }) => call("PATCH", `/api/groups/${id}`, p),
  /** Nests a group in parent ("" = top level), before group before ("" = last). */
  moveGroup: (id: string, parent: string, before = "") => call("POST", `/api/groups/${id}/move`, { parent, before }),
  archive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/archive`),
  unarchive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/unarchive`),
  deleteGroup: (id: string, contents: "delete" | "keep") => call("DELETE", `/api/groups/${id}?contents=${contents}`),
  newBoard: (group: string, name?: string, isNew = false) => call<Board>("POST", "/api/boards", { name, group, new: isNew }),
  /** A board's drawing, and the revision it is stored at (0 for a board never written). */
  scene: async (id: string): Promise<{ scene: any; rev: number }> => {
    const r = await send("GET", `/api/boards/${id}/scene`);
    const text = await r.text();
    return { scene: text ? JSON.parse(text) : undefined, rev: Number(r.headers.get(SCENE_REV)) || 0 };
  },
  /** Writes a board's drawing on the revision base and answers the new one. Only the board's holder may: refused with the
   *  code "not_holder" otherwise, and with "stale" when the stored drawing is not at base. */
  saveScene: (id: string, base: number, scene: unknown): Promise<number> =>
    call<{ rev: number }>("PUT", `/api/boards/${id}/scene?rev=${base}`, scene).then((r) => r.rev),
  /** Asks for a board. held: it is this client's, at the revision rev. waiting: its holder was asked to hand it over, and a
   *  `held` event follows. busy (only with ifFree): another client holds it, and nothing was asked. */
  takeBoard: (id: string, ifFree = false) =>
    call<{ state: "held" | "waiting" | "busy"; rev?: number }>("POST", `/api/boards/${id}/take`, ifFree ? { ifFree: true } : undefined),
  /** Lets a board go. handed: to who waited for it. free: nobody did. none: it was not this client's. */
  releaseBoard: (id: string) => call<{ state: "handed" | "free" | "none" }>("POST", `/api/boards/${id}/release`),
  renameBoard: (id: string, name: string) => call<Board>("POST", `/api/boards/${id}/rename`, { name }),
  moveBoard: (id: string, group: string) => call("PATCH", `/api/boards/${id}`, { group }),
  seenBoard: (id: string) => call("POST", `/api/boards/${id}/seen`),
  deleteBoard: (id: string) => call("DELETE", `/api/boards/${id}`),
  reveal: (id: string) => call("POST", `/api/boards/${id}/reveal`),
  /** server: the entry id of the server the chat is to be on; without it the place's own. */
  newChat: (where: ({ group: string } | { board: string } | { run: string }) & { server?: string }) => call<ChatView>("POST", "/api/chats", where),
  newRun: (group: string, name?: string) => call<RunView>("POST", "/api/runs", { group, name }),
  /** The run's view, with its folder checked again (after a 409). */
  run: (id: string) => call<RunView>("GET", `/api/runs/${id}`),
  renameRun: (id: string, name: string) => call<RunView>("PATCH", `/api/runs/${id}`, { name }),
  moveRun: (id: string, group: string) => call<RunView>("PATCH", `/api/runs/${id}`, { group }),
  /** Until the run starts (409 after). Only the tiers and the fields given change; another agent: the
   *  answer has that agent's defaults in all three tiers. settings are merged. */
  configureRun: (id: string, p: { server?: string; agent?: AgentKind; tiers?: Partial<Record<Tier, Partial<ModelChoice>>>; cwd?: string; settings?: Partial<RunSettings> }) =>
    call<RunView>("PATCH", `/api/runs/${id}`, p),
  /** The goal being typed; a started run ignores it. */
  saveRunDraft: (id: string, d: Draft, keepalive = false) => call("PUT", `/api/runs/${id}/draft`, d, keepalive),
  /** Answers once the start is recorded, before any agent runs: the view has started, status running and no draft. */
  startRun: (id: string, goal: string) => call<RunView>("POST", `/api/runs/${id}/start`, { goal }),
  stopRun: (id: string) => call<RunView>("POST", `/api/runs/${id}/stop`),
  /** raise: the new limit; a run stalled by its turn or cost limit resumes only with a higher one (409). */
  resumeRun: (id: string, raise?: { maxTurns: number } | { maxCost: number }) => call<RunView>("POST", `/api/runs/${id}/resume`, raise),
  /** local: only this sidebar's record of a run on another server goes (the server refuses it while that server is connected). */
  deleteRun: (id: string, o: { local?: boolean } = {}) => call("DELETE", `/api/runs/${id}${o.local ? "?local=1" : ""}`),
  /** The detail's events are sent to this page no more (the read of the detail started that). */
  unfollowRun: (id: string) => call("POST", `/api/runs/${id}/unfollow`),
  /** Puts the run's result into the folder's branch (`branch`: another one). The answer is what came of
   *  it, also when that is "blocked" or "pending"; 409 while the run is going or before it started. */
  applyRun: (id: string, branch?: string) => call<RunDelivery>("POST", `/api/runs/${id}/apply`, branch ? { branch } : {}).then(normDelivery),
  /** A dry run: what applying would do now. */
  runDelivery: (id: string) => call<RunDelivery>("GET", `/api/runs/${id}/delivery`).then(normDelivery),
  /** A started run's detail at its version; `run_detail` events carry the later ones. */
  runDetail: (id: string, signal?: AbortSignal) => call<RunDetail>("GET", `/api/runs/${id}/detail`, undefined, false, signal),
  runGoal: (id: string) => call<RunGoal>("GET", `/api/runs/${id}/goal`).then(normGoal),
  /** A task's brief: revision rev, or without it the one in force. */
  taskBrief: (run: string, task: string, rev?: number) =>
    call<TaskBrief>("GET", `/api/runs/${run}/tasks/${task}/brief${rev === undefined ? "" : `?rev=${rev}`}`).then(normBrief),
  /** 404 while the attempt has no result. */
  attemptReport: (run: string, task: string, n: number) => call<AttemptReport>("GET", `/api/runs/${run}/tasks/${task}/attempts/${n}/report`).then(normReport),
  /** 404 for a task that only reports, and while nothing is committed. */
  attemptChanges: (run: string, task: string, n: number) => call<AttemptChanges>("GET", `/api/runs/${run}/tasks/${task}/attempts/${n}/changes`).then(normChanges),
  runNotes: (run: string, v: number) => call<RunNotes>("GET", `/api/runs/${run}/notes/${v}`).then(normNotes),
  /** A branch's items and subagents. The answer names the branch served, and brings its record. */
  items: (id: string, branch: string) =>
    call<{ version: number; items: Item[]; subagents?: Subagent[]; branch?: string; state?: BranchState }>("GET", `/api/chats/${id}/items${onBranch(branch)}`),
  subItems: (chat: string, branch: string, sid: string) =>
    call<{ version: number; items: Item[] }>("GET", `/api/chats/${chat}/subagents/${sid}/items${onBranch(branch)}`),
  chat: (id: string) => call<ChatView>("GET", `/api/chats/${id}`),
  /** Ends this client's follow of a chat (a read of its items or tree started it): its content events stop. */
  unfollowChat: (id: string) => call("POST", `/api/chats/${id}/unfollow`),
  openChat: (id: string, branch: string) => call("POST", `/api/chats/${id}/open${onBranch(branch)}`),
  /** target: the point the message goes to; without it, the end of branch. The server refuses
   *  a target together with the query, so the branch is named in one of the two only. */
  send: (id: string, branch: string, text: string, context: string, references: Reference[] = [], target?: Target & { model?: string; effort?: string }) =>
    call("POST", `/api/chats/${id}/messages${target ? "" : onBranch(branch)}`, {
      text, context,
      ...(references.length ? { references } : {}),
      ...(target ? { target: { branch: target.branch, at: target.at, new: target.new,
        ...(target.model ? { model: target.model } : {}), ...(target.effort ? { effort: target.effort } : {}) } } : {}),
    }),
  /** server: an entry id (LOCAL_SERVER for this computer); the answer's chat has that server's agent, folder, model and effort. */
  configure: (id: string, branch: string, p: { server?: string; agent?: AgentKind; model?: string; effort?: string; cwd?: string }) => call<{ ok: boolean; chat?: ChatView }>("PATCH", `/api/chats/${id}${onBranch(branch)}`, p),
  /** Saves a branch's draft on the counter base and answers the new counter. Refused with the code "stale" when the draft was
   *  changed elsewhere: the error then has the server's counter (rev) and its draft. */
  saveDraft: (id: string, branch: string, d: Draft, base: number, keepalive = false): Promise<number> =>
    call<{ rev: number }>("PUT", `/api/chats/${id}/draft${onBranch(branch)}&rev=${base}`, d, keepalive).then((r) => r.rev),
  renameChat: (id: string, name: string) => call("PATCH", `/api/chats/${id}`, { name }),
  moveChat: (id: string, group: string) => call("PATCH", `/api/chats/${id}`, { group }),
  interrupt: (id: string, branch: string) => call("POST", `/api/chats/${id}/interrupt${onBranch(branch)}`),
  decide: (id: string, branch: string, answer: PermAnswer) => call("POST", `/api/chats/${id}/permission${onBranch(branch)}`, answer),
  /** local: only this server's record of a chat on another server goes (refused while that server is connected and has the chat). */
  deleteChat: (id: string, o: { local?: boolean } = {}) => call("DELETE", `/api/chats/${id}${o.local ? "?local=1" : ""}`),
  tree: (id: string) => call<TreeView>("GET", `/api/chats/${id}/tree`),
  /** Blank text removes the label. Answers all the chat's labels. */
  setLabel: (id: string, branch: string, item: number, text: string) => call<{ labels: TreeLabel[] }>("PUT", `/api/chats/${id}/label`, { branch, item, text }),
  /** Forks branch at item count `at` to a new chat; message: the user message that becomes its draft. */
  fork: (id: string, branch: string, at: number, message?: number) => call<ChatView>("POST", `/api/chats/${id}/fork`, { branch, at, message }),
  /** server: the entry id of the server whose folders are read; without it this computer's. */
  dirs: (path: string, server?: string) => call<Dirs>("GET", `/api/dirs?path=${encodeURIComponent(path)}${onServer(server)}`),
  contextSplit: (id: string, branch: string, fresh = false) => call<ContextSplit>("GET", `/api/chats/${id}/context${onBranch(branch)}${fresh ? "&fresh=1" : ""}`),
  usage: (agent: AgentKind, fresh = false, server?: string) => call<PlanUsage>("GET", `/api/usage/${agent}${fresh ? "?fresh=1" : ""}${onServer(server, !fresh)}`),
};
