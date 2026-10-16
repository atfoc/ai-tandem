// TypeScript mirror of internal/model (field for field, by json name).
// Go's omitempty fields are optional here; time.Time is an RFC 3339 string.
//
// No record names the server it is on. In the store every id of a thing of a section (a remote
// server) is the page's key of it (logic/keys.ts): the record's own `id`, and every id it holds
// of another thing of that server (`group`, `board`, `chat`, `parent`, …).

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

type ModelChoice = {
  model: string;
  effort?: string;
};

/** The key of a server's own part of its defaults (model.LocalServer), and the page's name for this
 *  computer where an entry id of the server list is asked for (logic/keys.ts). */
export const LOCAL_SERVER = "local";

/** Who writes a board, as the server tells it (the `follow` answer, a `writer` event): a window (whichever; never named), the headless
 *  writer, or nobody (""). */
export type Writer = "window" | "headless" | "";

export type ServerDefaults = {
  agent?: AgentKind; // the agent a new chat starts with
  cwd?: string;
  byAgent?: Partial<Record<AgentKind, ModelChoice>>;
};

export type GroupDefaults = {
  servers?: Record<string, ServerDefaults>; // the key LOCAL_SERVER alone: in a section's defaults it means that server
};

export type Defaults = {
  groups: Record<string, GroupDefaults>; // key: group id or UNGROUPED
};

export type Catalog = {
  models: CatalogModel[];
  default: ModelChoice;
};

/** What a server offers, as the server's own snapshot gives it (by entry id): its usable agents in the order
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
  noImages?: boolean; // the model takes no images; absent: it takes them
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
  agent: AgentKind | ""; // "": no agent yet (none was usable when the chat was made)
  name?: string;
  userNamed?: boolean;
  group?: string;
  board?: string;
  run?: string;      // only from a server that still has runs: the chat is of a run, and the store keeps none of them (store.ts)
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
  // The chat's subagent settings, fixed at the first message; a branch and a fork have their source's. A view with none of the
  // three (an older server) is depth 1 and cap 100, so Off is a field of its own: read them with subSettings (logic/subsettings.ts).
  subOff?: boolean;  // depth Off: the agent has no subagent tools
  subDepth?: number; // 1 to 3: the deepest level a subagent of the chat may be at; absent = 1, and with subOff
  subCap?: number;   // 1 to 100: the most subagents of the chat running at the same time; absent = 100
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
  images?: ChatImage[];                       // the images the message will carry
};

/** model.Image: a picture the user attached to a message, as a draft and a sent message hold it. The bytes are on the
 *  server, in the image store of the top-level chat (logic/chatimage.ts imageUrl). */
export type ChatImage = {
  id: string;   // the SHA-256 of the bytes, 64 lower-case hex digits
  name: string; // the file's name, or a fixed one for a pasted picture; only shown
  type: string; // one of IMAGE_TYPES (logic/chatimage.ts), as the server found it from the bytes
  size: number; // in bytes
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
  images?: ChatImage[];     // user: the images the message carries
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

/** What a composer holds: its text, the boards picked in it, its quotes and its images (the uploaded ones: an upload that
 *  runs is not held yet). */
export type Held = { text: string; mentions: { name: string; id: string }[]; references: Reference[]; images: ChatImage[] };

/** A move chosen and not sent yet: held is what the composer held before it (for Back), put what
 *  the move put there (Branch and edit: the message, its quotes and its images), null when it put nothing.
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
  parent?: string;  // the sid of the subagent that started it, whose thread holds that call; absent = the chat's agent
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
  waiting?: boolean; // running, its own turn ended: subagents it started still run, or their results have not reached it yet
};

/** A server's tree: its groups in its order, with its boards, chats, branch records and defaults. What the
 *  snapshot's `sections` holds by entry id and a `section` event brings, with that server's own ids
 *  (logic/sectionwire.ts makes the page's keys of them). */
export type SectionTree = { groups?: Group[] | null; boards?: Board[] | null; chats?: ChatView[] | null; states?: BranchState[] | null; defaults?: Defaults | null };
