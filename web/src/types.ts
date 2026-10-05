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

export type GroupDefaults = {
  cwd?: string;
  byAgent?: Partial<Record<AgentKind, ModelChoice>>;
};

export type Defaults = {
  last: GroupDefaults;
  groups: Record<string, GroupDefaults>; // key: group id or UNGROUPED
};

export type Catalog = {
  models: CatalogModel[];
  default: ModelChoice;
};

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
  agent: AgentKind;
  name?: string;
  userNamed?: boolean;
  group?: string;
  board?: string;
  cwd: string;
  model: string;
  effort?: string;
  locked: boolean;
  created: string;
  instructionsSent?: boolean;
  usage: Usage;
  draft?: Draft;
  status: Status;
  statusTool?: string;
  error?: string;
  folderMissing?: boolean;
  // From the chat's subagent records; both absent (0) for a chat not opened since the server started.
  subsRunning?: number; // app-spawned subagents still running
  subsOwed?: number;    // finished ones whose result the agent has not received
  branches?: number;        // how many branches the chat has; absent when one
  branch?: string;          // the current branch; absent when it is MAIN
  forkedFrom?: string;      // the chat this one was forked from
  forkedFromTitle?: string; // that chat's title when it was forked
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
 *  Back gives them back, and tells them from the ones the user removed. */
export type PendingMove = Target & { held: Held; put: Held | null; typed?: Held; hid?: Reference[] };

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
};
