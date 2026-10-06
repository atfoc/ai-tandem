// The server's HTTP API (section 4.12). Every call carries this tab's client id,
// so the server can tell the active client from a stale one.
import type { AgentKind, AttemptChanges, AttemptReport, Board, Catalog, ChatView, ContextSplit, Defaults, Draft, Group, Item, ModelChoice, PlanUsage, Reference,
  RunDelivery, RunDetail, RunGoal, RunNotes, RunSettings, RunView, Subagent, Target, TaskBrief, Tier, TreeLabel, TreeView } from "./types.ts";
import type { PermAnswer } from "./logic/perms.ts";
import { normBrief, normChanges, normDelivery, normGoal, normNotes, normReport } from "./logic/runnorm.ts";

/** GET /api/state and the `snapshot` event. */
export type Snapshot = {
  groups: Group[];
  boards: Board[];
  chats: ChatView[];
  runs?: RunView[]; // absent from a server that knows no runs
  defaults: Defaults;
  catalogs: Partial<Record<AgentKind, Catalog | null>>;
  home: string;
  defaultCwd: string;
  dataDir: string;
};

/** GET /api/hello: the running server's version and the web client's on disk. */
export type Hello = { app: string; version: string; pid: number; webVersion: string };

export type Dirs = { path: string; parent: string; dirs: string[]; git: boolean };

export const clientId: string = crypto.randomUUID(); // one per tab load

/** An API error: the server's message, with the HTTP status. */
export class ApiError extends Error {
  status: number;
  /** The message is the server's own sentence (its JSON `error`), not the status line. */
  said: boolean;
  constructor(status: number, msg: string, said = true) { super(msg); this.status = status; this.said = said; }
}

/** keepalive lets the request finish while the page unloads. */
async function call<T = void>(method: string, path: string, body?: unknown, keepalive = false, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, {
    method, keepalive, signal,
    headers: { "Content-Type": "application/json", "X-AIWB-Client": clientId },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) {
    const said = (await r.json().catch(() => null))?.error;
    // (no sentence of the server's: a proxy's or a body limit's answer has only a status)
    throw new ApiError(r.status, typeof said === "string" && said ? said : r.statusText || `The server answered ${r.status}.`, typeof said === "string" && !!said);
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

type Kind = "groups" | "boards" | "chats" | "runs";

/** The query that asks for a branch of a chat; none asks for its current branch. */
const onBranch = (branch?: string) => (branch ? `?branch=${encodeURIComponent(branch)}` : "");

export const api = {
  state: () => call<Snapshot>("GET", "/api/state"),
  hello: () => call<Hello>("GET", "/api/hello"),
  /** Starts `relaunch` (stop + launch) on the server; 409 binary_missing when its program is gone. */
  restart: () => call("POST", "/api/restart"),
  release: () => call("POST", "/api/client/release", { client: clientId }),
  flushed: () => call("POST", "/api/client/flushed", { client: clientId }),
  rpcReply: (id: string, reply: { result?: unknown; error?: string }) => call("POST", "/api/rpc-reply", { id, ...reply }),
  newGroup: (name?: string, parent?: string) => call<Group>("POST", "/api/groups", { name, parent }),
  updateGroup: (id: string, p: { name?: string; collapsed?: boolean }) => call("PATCH", `/api/groups/${id}`, p),
  /** Nests a group in parent ("" = top level), before group before ("" = last). */
  moveGroup: (id: string, parent: string, before = "") => call("POST", `/api/groups/${id}/move`, { parent, before }),
  archive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/archive`),
  unarchive: (k: Kind, id: string) => call("POST", `/api/${k}/${id}/unarchive`),
  deleteGroup: (id: string, contents: "delete" | "keep") => call("DELETE", `/api/groups/${id}?contents=${contents}`),
  newBoard: (group: string, name?: string, isNew = false) => call<Board>("POST", "/api/boards", { name, group, new: isNew }),
  scene: (id: string) => call<any>("GET", `/api/boards/${id}/scene`),
  saveScene: (id: string, scene: unknown) => call("PUT", `/api/boards/${id}/scene`, scene),
  renameBoard: (id: string, name: string) => call<Board>("POST", `/api/boards/${id}/rename`, { name }),
  moveBoard: (id: string, group: string) => call("PATCH", `/api/boards/${id}`, { group }),
  seenBoard: (id: string) => call("POST", `/api/boards/${id}/seen`),
  deleteBoard: (id: string) => call("DELETE", `/api/boards/${id}`),
  reveal: (id: string) => call("POST", `/api/boards/${id}/reveal`),
  newChat: (agent: AgentKind, where: { group: string } | { board: string } | { run: string }) => call<ChatView>("POST", "/api/chats", { agent, ...where }),
  newRun: (group: string, name?: string) => call<RunView>("POST", "/api/runs", { group, name }),
  /** The run's view, with its folder checked again (after a 409). */
  run: (id: string) => call<RunView>("GET", `/api/runs/${id}`),
  renameRun: (id: string, name: string) => call<RunView>("PATCH", `/api/runs/${id}`, { name }),
  moveRun: (id: string, group: string) => call<RunView>("PATCH", `/api/runs/${id}`, { group }),
  /** Until the run starts (409 after). Only the tiers and the fields given change; another agent: the
   *  answer has that agent's defaults in all three tiers. settings are merged. */
  configureRun: (id: string, p: { agent?: AgentKind; tiers?: Partial<Record<Tier, Partial<ModelChoice>>>; cwd?: string; settings?: Partial<RunSettings> }) =>
    call<RunView>("PATCH", `/api/runs/${id}`, p),
  /** The goal being typed; a started run ignores it. */
  saveRunDraft: (id: string, d: Draft, keepalive = false) => call("PUT", `/api/runs/${id}/draft`, d, keepalive),
  /** Answers once the start is recorded, before any agent runs: the view has started, status running and no draft. */
  startRun: (id: string, goal: string) => call<RunView>("POST", `/api/runs/${id}/start`, { goal }),
  stopRun: (id: string) => call<RunView>("POST", `/api/runs/${id}/stop`),
  /** raise: the new limit; a run stalled by its turn or cost limit resumes only with a higher one (409). */
  resumeRun: (id: string, raise?: { maxTurns: number } | { maxCost: number }) => call<RunView>("POST", `/api/runs/${id}/resume`, raise),
  deleteRun: (id: string) => call("DELETE", `/api/runs/${id}`),
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
  /** A branch's items and subagents; without branch the current one's. The answer names the branch served. */
  items: (id: string, branch?: string) =>
    call<{ version: number; items: Item[]; subagents?: Subagent[]; branch?: string }>("GET", `/api/chats/${id}/items${onBranch(branch)}`),
  subItems: (chat: string, sid: string, branch?: string) =>
    call<{ version: number; items: Item[] }>("GET", `/api/chats/${chat}/subagents/${sid}/items${onBranch(branch)}`),
  chat: (id: string) => call<ChatView>("GET", `/api/chats/${id}`),
  openChat: (id: string) => call("POST", `/api/chats/${id}/open`),
  /** target: the point the message goes to; without it, the end of the current branch. */
  send: (id: string, text: string, context: string, references: Reference[] = [], target?: Target) =>
    call("POST", `/api/chats/${id}/messages`, {
      text, context,
      ...(references.length ? { references } : {}),
      ...(target ? { target: { branch: target.branch, at: target.at, new: target.new } } : {}),
    }),
  configure: (id: string, p: { model?: string; effort?: string; cwd?: string }) => call("PATCH", `/api/chats/${id}`, p),
  saveDraft: (id: string, d: Draft, keepalive = false) => call("PUT", `/api/chats/${id}/draft`, d, keepalive),
  renameChat: (id: string, name: string) => call("PATCH", `/api/chats/${id}`, { name }),
  moveChat: (id: string, group: string) => call("PATCH", `/api/chats/${id}`, { group }),
  interrupt: (id: string) => call("POST", `/api/chats/${id}/interrupt`),
  decide: (id: string, answer: PermAnswer) => call("POST", `/api/chats/${id}/permission`, answer),
  deleteChat: (id: string) => call("DELETE", `/api/chats/${id}`),
  tree: (id: string) => call<TreeView>("GET", `/api/chats/${id}/tree`),
  /** Blank text removes the label. Answers all the chat's labels. */
  setLabel: (id: string, branch: string, item: number, text: string) => call<{ labels: TreeLabel[] }>("PUT", `/api/chats/${id}/label`, { branch, item, text }),
  /** Forks branch at item count `at` to a new chat; message: the user message that becomes its draft. */
  fork: (id: string, branch: string, at: number, message?: number) => call<ChatView>("POST", `/api/chats/${id}/fork`, { branch, at, message }),
  dirs: (path: string) => call<Dirs>("GET", `/api/dirs?path=${encodeURIComponent(path)}`),
  contextSplit: (id: string, fresh = false) => call<ContextSplit>("GET", `/api/chats/${id}/context${fresh ? "?fresh=1" : ""}`),
  usage: (agent: AgentKind, fresh = false) => call<PlanUsage>("GET", `/api/usage/${agent}${fresh ? "?fresh=1" : ""}`),
};
