// TypeScript mirror of internal/model (field for field, by json name).
// Go's omitempty fields are optional here; time.Time is an RFC 3339 string.

export type AgentKind = "claude" | "cursor" | "pi";

/** The group id of the ungrouped area (model.Ungrouped). */
export const UNGROUPED = "__ungrouped__";

/** The id of a chat's first branch. */
export const MAIN = "main";

/** The order agents are offered in, everywhere. */
export const AGENT_ORDER: AgentKind[] = ["claude", "cursor", "pi"];

/** model.Archive, embedded in Group, Board and ChatMeta. */
export type Archive = {
  archived?: boolean;
  archiveOp?: string;
};

export type Group = Archive & {
  id: string;
  name: string;
  parent?: string; // the group it is nested in; absent at the top level
  collapsed?: boolean;
};

/** board.json */
export type Board = Archive & {
  id: string;
  name: string;
  group: string; // group id or UNGROUPED
  created: string;
  new?: boolean;
  server?: string; // entry id of the server the board lives on; absent = this computer
  gone?: boolean;  // no longer on its server
};

export type State = {
  version: number;
  groups: Group[];
  defaults: Defaults;
  /** Per-agent persisted catalogs (the model lists each agent reported); Cursor's older
   *  `cursorCatalog` is kept for backward compatibility. */
  catalogs?: Partial<Record<AgentKind, Catalog | null>>;
  cursorCatalog?: Catalog;
};

export type ModelChoice = {
  model: string;
  effort?: string;
};

/** The key of the local server's part of the defaults (model.LocalServer), and the wire value of
 *  "server" for the local server. */
export const LOCAL_SERVER = "local";

export type ServerDefaults = {
  agent?: AgentKind; // the agent a new chat starts with
  cwd?: string;
  byAgent?: Partial<Record<AgentKind, ModelChoice>>;
  run?: RunDefaults; // what a new run in the group starts with; recorded when a run starts
};

export type GroupDefaults = {
  server?: string; // the sticky server; absent: none stored
  servers?: Record<string, ServerDefaults>; // key: LOCAL_SERVER or an instance id
};

export type Defaults = {
  groups: Record<string, GroupDefaults>; // key: group id or UNGROUPED
};

export type Catalog = {
  models: CatalogModel[];
  default: ModelChoice;
};

/** What a server offers, as the local server sends it for another one (by entry id): its usable agents in the order
 *  they are offered, their catalogs, its home and the folder a new chat starts in. */
export type ServerLists = { agents: AgentKind[]; catalogs: Partial<Record<AgentKind, Catalog | null>>; home: string; defaultCwd: string };

export type CatalogModel = {
  id: string;
  label: string;
  note?: string;
  provider?: string; // pi only: the provider pi reported; absent/empty when unknown
  efforts?: string[];
  contextWindow?: number;
  defaultEffort?: string;
  effortLabels?: Record<string, string>;
};

export type Usage = {
  ctxIn: number;
  ctxOut: number;
  ctxWindow: number;
  ctxError?: string;
  turns: number;
};

/** GET /api/chats/{id}/context: what fills the context window, by category, as the agent reports it.
 * Claude's is kept on the server until messages or turns move past it; Cursor's is read each time. */
export type ContextSplit = {
  atMessage: number; // messages sent when it was taken
  atTurn: number;
  total: number;
  window: number;
  categories: ContextCategory[]; // in the agent's order
  facts?: { label: string; value: string }[]; // Claude: model, auto-compact, listed skills and commands
};

export type ContextCategory = {
  id: string; // Cursor's id; Claude's name in snake case
  label: string;
  tokens: number;
  kind: "used" | "deferred" | "buffer" | "free"; // deferred: not in the context; buffer: kept free
  chars?: number; // Cursor
  parts?: ContextCategory[]; // Claude's Messages: tool calls, tool results, attachments, …
  items?: ContextItem[]; // per skill, MCP tool, memory file, agent, tool or attachment type
};

export type ContextItem = { name: string; tokens: number; note?: string };

/** GET /api/usage/{agent}: the plan's limits, from `claude -p /usage` or `cursor-cost`. Not stored. */
export type PlanUsage = {
  plan: boolean; // false: no limits reported (API-key login, logged out)
  note?: string; // plan false: why; plan true: a warning about the limits (Cursor: its refresh failed)
  limits: UsageLimit[];
  fetchedAt: string; // when the numbers are from
};

export type UsageLimit = {
  kind: string; // "session", "weekly_all", "weekly_scoped", Cursor's "individual.overall", …
  label: string; // "Current session", "Current week (Fable)"
  percent: number; // 0–100
  detail?: string; // Cursor: "$413.89 of $1,101"
  resetsAt?: string;
  severity?: string;
  active?: boolean;
};

/** chat.json */
export type ChatMeta = Archive & {
  id: string;
  agent: AgentKind;
  name?: string;
  userNamed?: boolean;
  group?: string;
  board?: string;
  run?: string;
  role?: AgentRole;
  cwd: string;
  model: string;
  effort?: string;
  sessionId?: string;
  locked: boolean;
  token?: string;
  created: string;
  turnActive?: boolean;
  instructionsSent?: boolean;
  mcpInstructionsSent?: boolean;
  usage: Usage;
};

export type Status = "ready" | "thinking" | "writing" | "tool" | "approval" | "stopped" | "error";

/** What clients see: ChatMeta without token, sessionId, turnActive (and mcpInstructionsSent), plus live state.
 *  instructionsSent is the curl-era disable marker. */
export type ChatView = Archive & {
  id: string;
  agent: AgentKind | ""; // "": no agent yet (none was usable when the chat was made)
  name?: string;
  userNamed?: boolean;
  group?: string;
  board?: string;
  run?: string;      // a chat on a run, or (with role) one of the run's agents
  role?: AgentRole;  // a run agent: never in the snapshot's chats, never in the sidebar
  server?: string;   // the entry id of the chat's server (logic/serverlists.ts serverOf); absent = this computer
  start?: "unconfirmed"; // an unstarted chat on another server whose first message got no answer: it may have arrived
  gone?: boolean;    // a chat on another server that the server no longer has
  cwd: string;
  model: string;
  effort?: string;
  locked: boolean;
  created: string;
  instructionsSent?: boolean;
  usage: Usage;
  draft?: Draft;
  draftRev?: number; // the counter of the current branch's draft, raised at each change; absent when 0
  status: Status;
  statusTool?: string;
  error?: string;
  folderMissing?: boolean;
  // A fork to a new chat with no message of its own yet: its model and effort are still open, its
  // folder is fixed. Absent otherwise; a branch is never fresh.
  fresh?: boolean;
  // From the chat's subagent records; both absent (0) for a chat not opened since the server started.
  subsRunning?: number; // app-spawned subagents still running
  subsOwed?: number;    // finished ones whose result the agent has not received
  branches?: number;        // how many branches the chat has; absent when one
  branch?: string;          // the current branch; absent when it is MAIN
  forkedFrom?: string;      // the chat this one was forked from
  forkedFromTitle?: string; // that chat's title when it was forked
  forkedBranch?: string;    // the branch of that chat it was forked from
  forkedAt?: number;        // the item count of the prefix it was forked with; absent for older forks
  // Over all the chat's branches; absent from a server without per-branch state.
  working?: number;   // how many branches are thinking, writing, on a tool or waiting for approval
  approvals?: number; // how many of those wait for approval
  hasDraft?: boolean; // a branch has a stored draft
};

/** One branch's session state: what ChatView tells of the current branch, for any branch. */
export type BranchState = {
  chat: string;
  branch: string;
  cwd: string;
  model: string;
  effort?: string;
  locked: boolean;
  usage: Usage;
  status: Status;
  statusTool?: string;
  error?: string;
  folderMissing?: boolean;
  fresh?: boolean;
  subsRunning?: number;
  subsOwed?: number;
  draft?: Draft;
  draftRev?: number; // the counter of the draft, raised at each change; absent when 0
};

/** The message typed in a chat's composer and not sent yet; the server clears it on send. */
export type Draft = {
  text: string;                               // the composer's value, with its reference tags
  mentions?: { name: string; id: string }[];  // boards picked from the @ menu
  references?: Reference[];                   // the quotes the message will carry (⌘L)
};

/** model.Reference: part of an earlier message in the chat that the user quoted (⌘L), with a
 *  comment. Positions are in the message's displayed text, not its markdown (logic/quotes.ts). */
export type Reference = {
  quote: string;
  comment?: string;
  item: number;  // index of the quoted item in the chat's thread
  start: number; // selection position in the item's displayed text
  end: number;
};

/** One entry of a chat's thread. */
export type Item = {
  kind: "user" | "text" | "tool" | "perm" | "note" | "subresult" | "end";
  text?: string;
  context?: string;
  references?: Reference[]; // user
  done?: boolean;
  toolId?: string;
  name?: string;
  input?: unknown;
  partial?: string;
  result?: string; // absent while running
  isError?: boolean;
  denied?: boolean;
  requestId?: string;
  toolName?: string;
  decided?: "" | "allow" | "deny";
  tone?: "muted" | "error";
  subagent?: string; // tool: the sid it started; perm: the sid that asked; subresult: the sid whose result was carried
  point?: string; // end: the agent's id for the point after the turn; "" when it has none
};

// ---- chat forking: GET /api/chats/{id}/tree

/** A label on a message, keyed by the branch that owns the item (the one whose own part holds it). */
export type TreeLabel = { branch: string; item: number; text: string };

/** A message in a branch's own part, with its index in the branch's items. end: the item count
 *  after the turn this reply closes; before: the count before this user message; ok: whether that
 *  point can be gone to. */
export type TreeItem = { i: number; kind: "user" | "text"; text: string; done?: boolean; end?: number; before?: number; ok?: boolean };

/** A branch: split from branch `from` at item count `at` (MAIN: no from, at 0), `len` items long.
 *  items holds only its own part (index >= at), and only messages and replies. */
export type TreeBranchView = { id: string; from?: string; at: number; len: number; items: TreeItem[] };

export type TreeView = { current: string; branches: TreeBranchView[]; labels: TreeLabel[] };

/** A point a message is sent to: a branch, an item count, and whether a new branch is asked for. */
export type Target = { branch: string; at: number; new: boolean };

/** What a composer holds. */
export type Held = { text: string; mentions: { name: string; id: string }[]; references: Reference[] };

/** A move chosen and not sent yet: held is what the composer held before it (for Back), put what
 *  the move put there (Branch and edit: the message and its quotes), null when it put nothing.
 *  typed: what the composer held when it went away (another chat was opened), until it opens again;
 *  while the move is being sent, only when it held anything: the move's end makes that the chat's
 *  draft. After a Send that failed with no composer open it is the message that was not sent.
 *  hid: the quotes the moves took out of the composer (they name another message past the point):
 *  Back gives them back, and tells them from the ones the user removed.
 *  from: the branch the chat was on when the move was started, which Back returns to: the
 *  composer is that branch's and holds its draft. A move is always to a branch that is not there
 *  yet (new): the end of one that is there is looked at, with no move.
 *  model, effort: the choice the new branch starts on, as shown, set together; both absent is the
 *  source's. */
export type PendingMove = Target & { from: string; held: Held; put: Held | null; typed?: Held; hid?: Reference[]; model?: string; effort?: string };

export type SubStatus = "running" | "completed" | "failed" | "stopped";

/** model.SubDelivery: what the app owes the agent for an app-spawned subagent's result. Absent:
 *  nothing owed. "retry" is owed after one failed attempt; "given-up" is not owed: two failed. */
export type SubDelivery = "owed" | "retry" | "sent" | "given-up";

/** model.Subagent: a subagent's state (subagent.json). Its thread is loaded apart (§7.3). */
export type Subagent = {
  id: string;       // the app's sid
  tool: string;     // the Agent/Task tool call that started it
  parent?: string;  // the sid whose thread holds that call
  agentId?: string;
  type?: string;
  description?: string;
  prompt?: string;
  model?: string;
  kind?: AgentKind; // json "kind": "claude" | "cursor" | "pi"; absent on unlinked rows
  effort?: string;  // json "effort"
  background?: boolean;
  status: SubStatus;
  error?: string;
  summary?: string;
  progress?: string;
  last?: string;
  tokens?: number;
  window?: number;
  toolUses?: number;
  started?: number; // unix ms
  ended?: number;
  delivery?: SubDelivery;
  notCarried?: boolean; // a copy's record of one still running in the source when the copy was made: stopped, nothing owed
};

// ---- runs: mirror of the run types in internal/model/run.go, field for field, by json name.
//
// Time format: `created` and `started` are RFC 3339 strings, like every sidebar record
// (Board.created, ChatView.created). Every other time is epoch milliseconds as a number: fields
// named `t`, `at`, `…At`, `asOf` (as Subagent.started). Durations are milliseconds (`…Ms`).

export type RunStatus = "draft" | "running" | "stopping" | "stopped" | "stalled" | "error" | "completed" | "gave_up";
/** Which limit stalled the run: idle turns in a row, the turn limit, or the cost limit. */
export type StalledBy = "idle" | "turns" | "cost";
export type RunOutcome = "achieved" | "not_achieved";

/** What a task is doing: the kind of its last attempt's last phase, or how that attempt ended. */
export type PhaseKind = "held" | "deps" | "blocked" | "slot" | "setup" | "work" | "merge";
export type AttemptOutcome = "done" | "failed" | "cancelled";
export type TaskState = PhaseKind | AttemptOutcome;
export const TASK_STATES: TaskState[] = ["held", "deps", "blocked", "slot", "setup", "work", "merge", "done", "failed", "cancelled"];

/** Why a turn started: the run's start, the wait the orchestrator declared was met ("wait"), an
 *  event that starts one whatever the wait says ("events": a failed task, a chat's change), nothing
 *  was running ("idle"), or a resume. */
export type TurnReason = "start" | "wait" | "events" | "idle" | "resume";
export type TurnStatus = "running" | "done" | "failed";
export type AgentRole = "orchestrator" | "task" | "merge";
export type AgentStatus = "running" | "done" | "failed" | "interrupted" | "cancelled";
export type StopReason = "user" | "app_quit" | "stalled" | "error";

/** The three levels of model a run works with: the orchestrator picks one per task. */
export type Tier = "deep" | "standard" | "light";
export const TIERS: Tier[] = ["deep", "standard", "light"];
/** What an agent is recorded with: its tier, or "orchestrator" for a turn of an orchestrator that
 *  has a model of its own. */
export type AgentTier = Tier | "orchestrator";
/** The model and effort of each tier; all three keys are always present. `orchestrator` is the
 *  orchestrator's own choice: absent, the orchestrator runs on the deep tier. */
export type RunTiers = Record<Tier, ModelChoice> & { orchestrator?: ModelChoice };
/** What the composer saves of the tiers: the choices given change; the orchestrator's model ""
 *  takes its own choice away. */
export type TiersChange = Partial<Record<AgentTier, Partial<ModelChoice>>>;
/** Tokens an agent used. */
export type TokenCount = { in: number; out: number; cacheRead: number; cacheWrite: number };
/** The tasks the orchestrator waits for before its next turn: all of them, or any one. */
export type RunWait = { tasks: string[]; mode: "all" | "any"; turn: number }; // turn: the turn that declared it

/** What became of the run's result (its integration branch) in the folder's own branch. */
export type RunDeliveryState = "none" | "pending" | "applied" | "blocked";
export type RunDeliveryReason = "no_git" | "no_changes" | "manual" | "not_achieved" | "halted" | "other_branch" | "history_changed"
  | "local_changes" | "conflict" | "busy" | "folder_missing" | "not_repo" | "result_missing" | "git";
export interface RunDelivery {
  state: RunDeliveryState;
  reason?: RunDeliveryReason; // none, pending, blocked: why
  auto?: boolean;             // the app applied it (or tried to) when the run finished
  at?: number;
  result?: string;            // the result's commit
  commit?: string;            // applied: the branch's head after it
  how?: "ff" | "merge" | "already";
  branch?: string;            // the branch it was (or would be) applied to
  files?: string[];           // blocked: the files in the way; absent when none
  more?: number;              // files left out of `files`
  detail?: string;
  partial?: boolean;          // the run did not finish: the result is what was merged so far
}

/** A run's settings. The composer shows maxParallel, maxTurns, maxCost and setup; the rest keep the
 *  server's defaults. All of them are fixed when the run starts, except that a resume may raise
 *  maxTurns or maxCost. */
export type RunSettings = {
  maxParallel: number;     // tasks at once (default 8; 1–16)
  maxTurns: number;        // orchestrator turns before the run stalls (default 60; 1–500)
  maxCost: number;         // USD before the run stalls; 0 = no limit (default 0)
  setup?: string;          // shell command run in every new task checkout; absent = none
  wake: "declared" | "each" | "idle"; // when a turn starts: the orchestrator says which tasks it waits for (default),
                           //   after every finished task, or only when nothing runs
  applyResult?: "auto" | "manual"; // the result goes into the folder's branch when the run finishes, or when the user says; absent = "auto"
  maxIdleTurns: number;    // idle turns in a row before the run stalls (default 3)
  agentTimeoutSec: number; // one launch of an agent (default 10800)
  agentRetries: number;    // extra counted launches of an agent after a failure (default 2)
  keepWorktrees?: boolean; // keep task checkouts after their task ends (default false)
};

/** Tasks by state; every key is always present. */
export type RunCounts = Record<TaskState, number>;

/** A run as the sidebar, the run bar and the run's meters need it: in the snapshot (`runs`), in the
 *  `run` event and in the answer of every run route. It changes at task and turn boundaries, never
 *  per agent event. */
export type RunView = Archive & {
  id: string;            // "r_" + 8 base36 characters; the folder name
  name: string;
  userNamed?: boolean;   // the user renamed it: starting the run does not name it from the goal
  group: string;         // group id or UNGROUPED
  created: string;
  agent: AgentKind | ""; // one agent kind for every agent of the run; "": a draft with no usable agent
  tiers: RunTiers;       // the model and effort of each tier
  tierDefaults?: RunTiers; // draft only: the agent kind's defaults
  cwd: string;
  folderMissing?: boolean;
  git?: boolean;         // cwd is inside a git work tree
  dirty?: boolean;       // draft: the folder has uncommitted changes
  blocked?: string;      // why the run cannot start (or resume) as it is set up; shown verbatim
  settings: RunSettings;
  draft?: Draft;         // the goal being typed; cleared by the server when the run starts
  started?: string;      // absent exactly while status is "draft"
  status: RunStatus;
  reason?: string;       // stopped, stalled, error: why, one sentence
  stalledBy?: StalledBy; // status "stalled" only
  outcome?: RunOutcome;  // completed: "achieved"; gave_up: "not_achieved"
  activeMs: number;      // working time (stops left out) up to asOf; while status is running or
  asOf: number;          //   stopping the client shows activeMs + (now - asOf)
  turns: number;         // orchestrator turns so far (the number of the latest turn)
  turnRunning?: number;  // the turn that is running now
  wait?: RunWait;        // what the orchestrator waits for now; absent = nothing
  delivery?: RunDeliveryState; // RunDetail.delivery.state
  idleStreak: number;    // idle turns in a row
  counts: RunCounts;
  cost: number | null;   // USD of the run's agents; null: this agent kind reports no cost
  costPartial?: boolean; // the sum is known to miss something
  attention: number;     // failed tasks + blocked tasks + refused calls in the latest turn
  server?: string;       // the entry id of the run's server; absent = this computer
  start?: "unconfirmed"; // a draft on another server whose start got no answer: its choices are fixed until that is known
  gone?: boolean;        // a run on another server that the server no longer has
  was?: string;          // only in a `run` event: the id the draft had before it got this one (the store moves to it and drops the field)
};

// ---- run detail: GET /api/runs/{id}/detail, kept current by `run_detail` events

export type RunDetail = {
  run: string;                      // the run's id
  version: number;                  // rises by one with every change of the run's recorded state
  status: RunStatus;                // the same value as RunView.status, changed together with stops
  startedAt: number;
  endedAt?: number;                 // completed and gave_up only; a halted run ends at its open stop
  goalSize: number;                 // characters of the goal; the text: GET /api/runs/{id}/goal
  git?: RunGit;                     // absent: the run does not use git
  stops: Stop[];                    // in time order; the last one is open while the run is halted
  turns: Turn[];                    // by n
  tasks: Task[];                    // in creation order
  chatOps: Op[];                    // changes made outside a turn by a chat on the run, by i
  agents: Record<string, RunAgent>; // key: the agent's chat id
  notes: NotesVersion[];            // by v; the texts: GET /api/runs/{id}/notes/{v}
  result?: RunResult;
  delivery?: RunDelivery;           // absent for a draft and for a live run
};

export type RunGit = {
  baseRef: string;            // the commit the run started from
  integrationBranch: string;  // where finished work is merged; the run's result
  resultHead?: string;        // its head when the run finished
  branch?: string;            // the folder's branch at the start; absent: detached
  dirtyAtStart?: boolean;     // the folder had uncommitted changes when the run started: they are not in the run
};

export type Stop = { at: number; resumedAt?: number; reason: StopReason };

export type RunResult = {
  outcome: RunOutcome;
  summary: string;   // the orchestrator's summary for the user, markdown
  turn: number;
  at: number;
};

/** Something the orchestrator is told about. */
export type RunEvent = {
  seq: number;
  t: number;
  type: "task_done" | "task_failed" | "chat_op";
  task?: string;
  chat?: string;     // chat_op: the chat that made the change
  text: string;      // the task's summary or error, or what the chat did: at most 600 characters (a tell_orchestrator message: 4,000)
};

export type OpName = "get_run" | "get_task" | "get_agent" | "get_notes" | "add_task" | "update_task"
  | "cancel_task" | "retry_task" | "set_notes" | "edit_notes" | "wait_for" | "finish_run" | "tell_orchestrator";

/** One call of a run tool: by the orchestrator in a turn (Turn.ops; reads included), or by a chat
 *  on the run outside a turn (RunDetail.chatOps; changes only). */
export type Op = {
  i: number;               // its index in Turn.ops or in RunDetail.chatOps
  t: number;
  op: OpName;
  chat?: string;           // chatOps only: the chat that made it
  turn?: number;           // chatOps only: the latest turn at that moment
  error?: string;          // the call was refused: the refusal (at most 400 characters)
  task?: string;
  agent?: string;          // get_agent: the agent's name
  title?: string;          // add_task, update_task
  kind?: string;           // add_task
  writes?: boolean;        // add_task
  dependsOn?: string[];    // add_task, update_task: the list after the call
  changed?: string[];      // update_task: "title" | "brief" | "kind" | "writes" | "depends_on"
  briefRev?: number;       // add_task, update_task: the brief revision the call wrote
  reason?: string;         // cancel_task, retry_task (at most 400 characters)
  attempt?: number;        // retry_task: the attempt it queued
  tier?: Tier;             // add_task, update_task, retry_task
  tierReason?: string;
  needsReport?: string[];  // add_task, update_task: the list after the call; absent when empty
  notesVersion?: number;   // set_notes, edit_notes
  size?: number;           // set_notes, edit_notes: characters
  heading?: string;        // edit_notes: the section
  tasks?: string[];        // wait_for
  mode?: "all" | "any";    // wait_for
  outcome?: RunOutcome;    // finish_run
  text?: string;           // tell_orchestrator, and finish_run's summary (at most 600 characters)
};

export type Turn = {
  n: number;
  agent: string;           // its agent's chat id (RunDetail.agents)
  reason: TurnReason;
  idle?: boolean;          // it started with nothing running and nothing able to start
  wait?: RunWait;          // the wait it started under
  waitMet?: boolean;       // that wait was met when it started; otherwise reason and wokenBy say what started it early
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
  wokenBy: RunEvent[];     // the events that started it
  learned: RunEvent[];     // the events it read while running (get_run)
  ops: Op[];
  summary?: string;        // the orchestrator's closing message
  error?: string;          // failed: why
  cost: number | null;
};

export type BriefRev = { rev: number; at: number; turn?: number; chat?: string; size: number };

export type Task = {
  id: string;              // "T01", "T02", …
  title: string;
  kind: string;            // a one-word label: research, implement, review, …
  writes: boolean;         // its changes are merged; false: it only reports
  dependsOn: string[];
  needsReport: string[];   // a subset of dependsOn: the dependencies whose reports its agent is given whole
  tier: Tier;
  tierReason: string;      // why the orchestrator chose it, one sentence
  addedTurn: number;       // the turn that added it; for a task a chat added, the latest turn then
  addedBy?: string;        // the chat that added it
  createdAt: number;
  changedTurns: number[];  // the turns that updated or retried it
  briefRev: number;        // the brief revision in force
  briefs: BriefRev[];      // every revision; the texts: GET /api/runs/{id}/tasks/{tid}/brief?rev=
  attempts: Attempt[];     // at least one; the last one is the current one
};

export type Phase = {
  k: PhaseKind;
  t: number;
  on?: string[];           // deps: the dependencies not done yet; blocked: the failed or cancelled ones
  turn?: number;           // held: the turn whose end releases it
  chat?: string;           // held: or the chat whose reply's end releases it
};

/** The agent's own result block, as it reported it. */
export type AttemptResult = { outcome: "completed" | "failed"; summary: string; reportSize: number };

export type Attempt = {
  n: number;
  tier: Tier;              // the tier it runs on (a retry may raise it)
  queuedTurn: number;      // the turn that added (n = 1) or retried the task; for a chat, the latest turn then
  queuedBy?: string;       // the chat that did
  queuedAt: number;
  phases: Phase[];         // in time order; each lasts until the next one or endedAt
  startedAt?: number;      // a slot was taken (the first setup phase)
  endedAt?: number;
  outcome?: AttemptOutcome;
  error?: string;          // failed: why
  cancel?: { t: number; reason: string; turn?: number; chat?: string };
  result?: AttemptResult;  // the report: GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report
  mergedAt?: number;
  conflicts?: string[];    // the files a merge agent had to resolve
  agents: { work?: string; merge?: string }; // chat ids (RunDetail.agents)
  cost: number | null;
  branch?: string;         // writing tasks
  base?: string;           // the integration head it started from
  head?: string;           // its own last commit
  merged?: string;         // the integration head after its merge; absent: nothing was merged
};

export type Launch = { n: number; startedAt: number; endedAt?: number; resume: boolean; error?: string };

/** One agent of the run. Its transcript is the chat with this id (role set): GET /api/chats/{id}. */
export type RunAgent = {
  id: string;              // its chat id
  name: string;            // what the run calls it: "turn-007", "T03-work", "T03-a2-work", "T03-merge"
  role: AgentRole;
  task?: string;
  attempt?: number;
  turn?: number;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  launches: Launch[];      // one per process started for it
  error?: string;
  cost: number | null;
  tier: AgentTier;         // an orchestrator's is "deep", or "orchestrator" with a model of its own; a merge agent's "standard"
  model: string;
  effort?: string;
  tokens: TokenCount | null; // null: this agent kind reports none (Cursor)
  peakContext?: number;    // tokens of its fullest context so far; 0 or absent = unknown
  tools?: number;          // tool calls so far            ┐ not part of the recorded state: sent in
  activity?: string;       // its last action, one line    ┘ `run_activity` events while it runs
};

export type NotesVersion = { v: number; at: number; turn?: number; chat?: string; size: number };

// ---- events

/** `run_detail {run, version, patch}`: the records a change touched. Scalars replace; stops is the
 *  whole list; turns, tasks, chatOps and notes replace the record with the same key or are added;
 *  agents are merged by id. Nothing is ever removed from a detail. */
export type RunPatch = Partial<Omit<RunDetail, "run" | "version">>;
export type RunDetailEvent = { type: "run_detail"; run: string; version: number; patch: RunPatch };

/** `run_activity {run, agents}`: what running agents do right now, at most every 2 s per run. It
 *  is not versioned: the values are merged into the agents the detail has. */
export type RunActivityEvent = {
  type: "run_activity"; run: string;
  agents: Record<string, { activity?: string; tools?: number; cost?: number | null; peakContext?: number }>;
};

// ---- loaded on demand

/** GET /api/runs/{id}/goal */
export type RunGoal = { text: string };
/** GET /api/runs/{id}/tasks/{tid}/brief[?rev=] */
export type TaskBrief = BriefRev & { task: string; text: string };
/** GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report */
export type AttemptReport = { task: string; attempt: number; outcome: "completed" | "failed"; summary: string; report: string };
/** GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes */
export type AttemptChanges = {
  task: string; attempt: number;
  branch: string; base: string; head: string;
  merged?: string; mergedAt?: number;
  files: { path: string; add: number; del: number; binary?: boolean }[];
  add: number; del: number;
  commits: { sha: string; subject: string; at: number }[];
  conflicts?: string[];
};
/** GET /api/runs/{id}/notes/{v} */
export type RunNotes = NotesVersion & { text: string };

/** What a new run in a group starts with (GroupDefaults.run). */
export type RunDefaults = { agent: AgentKind; tiers?: RunTiers; maxParallel: number; maxTurns: number; maxCost: number; setup?: string; setupCwd?: string };
