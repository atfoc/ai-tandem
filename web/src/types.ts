// TypeScript mirror of internal/model (field for field, by json name).
// Go's omitempty fields are optional here; time.Time is an RFC 3339 string.

export type AgentKind = "claude" | "cursor";

/** The group id of the ungrouped area (model.Ungrouped). */
export const UNGROUPED = "__ungrouped__";

/** The order agents are offered in, everywhere. */
export const AGENT_ORDER: AgentKind[] = ["claude", "cursor"];

/** model.Archive, embedded in Group, Board and ChatMeta. */
export type Archive = {
  archived?: boolean;
  archiveOp?: string;
};

export type Group = Archive & {
  id: string;
  name: string;
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
  usage: Usage;
};

export type Status = "ready" | "thinking" | "writing" | "tool" | "approval" | "stopped" | "error";

/** What clients see: ChatMeta without token, sessionId, turnActive, instructionsSent, plus live state. */
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
  usage: Usage;
  status: Status;
  statusTool?: string;
  error?: string;
  folderMissing?: boolean;
};

/** One entry of a chat's thread. */
export type Item = {
  kind: "user" | "text" | "tool" | "perm" | "note";
  text?: string;
  context?: string;
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
};
