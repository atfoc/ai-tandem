// One-line labels for tool cards and the chat status. DOM-free.
//
// Board tools take a board id (`board`, optional: the chat's own board when
// left out). The label names the board through `nameOf` (id → name, from the
// store), or says "this board" when the argument is left out.
// The run tools come from the same server and name a task or an agent of the run.

import type { BranchState, CatalogModel, ChatView, Item } from "../types.ts";
import { plainText } from "./refs.ts";
import { isBusy, starting } from "./status.ts";

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

/** An effort's name: the model's own (Cursor's) when it has one, else ours, else the id capitalised. */
export function effortLabel(id?: string, model?: CatalogModel): string {
  if (!id) return "";
  return model?.effortLabels?.[id] ?? EFFORT_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** Looks a board's name up by id; undefined when unknown. */
export type BoardNames = (id: string) => string | undefined;

const noNames: BoardNames = () => undefined;

const short = (n: string) => n.replace(/^mcp__board__/, "");
const base = (p: any) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const clip = (t: any, n = 48) => { const v = String(t ?? "").replace(/\s+/g, " ").trim(); return v.length > n ? v.slice(0, n - 1) + "…" : v; };
const host = (u: any) => { try { return new URL(String(u)).host; } catch { return clip(u, 30); } };

/** Claude Code's and Pi's own tools, and other MCP servers', in the same one-line style. Pi's
 *  built-ins are lower-case (read, bash, edit, write, grep, find, ls) and take a `path`. */
export function genericTool(name: string, input: any, done: boolean): string | null {
  const i = input ?? {};
  switch (name) {
    case "Bash": case "bash": return i.description ? clip(i.description) : `${done ? "Ran" : "Running"} ${i.command ? "`" + clip(i.command, 40) + "`" : "a command"}`;
    case "Read": case "read": return `${done ? "Read" : "Reading"} ${base(i.file_path ?? i.path) || "a file"}`;
    case "Write": case "write": return `${done ? "Wrote" : "Writing"} ${base(i.file_path ?? i.path) || "a file"}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": case "edit": return `${done ? "Edited" : "Editing"} ${base(i.file_path ?? i.notebook_path ?? i.path) || "a file"}`;
    case "Glob": case "find": return `${done ? "Found files" : "Finding files"}${i.pattern ? " " + clip(i.pattern, 30) : ""}`;
    case "Grep": case "grep": return `${done ? "Searched" : "Searching"}${i.pattern ? " for " + clip(i.pattern, 30) : ""}`;
    case "ls": return `${done ? "Listed" : "Listing"} ${base(i.path) || "a directory"}`;
    case "WebSearch": return `${done ? "Searched the web" : "Searching the web"}${i.query ? ": " + clip(i.query, 36) : ""}`;
    case "WebFetch": return `${done ? "Fetched" : "Fetching"} ${host(i.url)}`;
    case "Task": case "Agent": return `${done ? "Subagent finished" : "Subagent working"}${i.description ? ": " + clip(i.description, 36) : ""}`;
    case "TodoWrite": return done ? "Updated the plan" : "Updating the plan";
    case "ToolSearch": return done ? "Loaded tools" : "Loading tools";
    case "Skill": return `${done ? "Used" : "Using"} skill ${i.skill ?? i.name ?? ""}`;
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m && m[1] !== "board") return `${m[1]} · ${m[2].replace(/_/g, " ")}`;
  return null;
}

const what = (i: any) => clip(i?.id ?? i?.task ?? i?.agent ?? "", 24);
const titled = (i: any) => (i?.title ? `: ${clip(i.title, 36)}` : "");
/** "Reading task T07"; "Reading a task" when the call's input is not known (a chat's status line). */
const named = (verb: string, noun: string, i: any) => (what(i) ? `${verb} ${noun} ${what(i)}` : `${verb} ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun}`);
const pair = (running: string, done: string, noun: string) => (i: any): [string, string] => [named(running, noun, i), named(done, noun, i)];

/** The run tools (a chat on a run, and the run's own agents): [while it runs, once done]. */
const RUN_TOOLS: Record<string, (i: any) => [string, string]> = {
  get_run: () => ["Reading the run", "Read the run"],
  get_task: pair("Reading", "Read", "task"),
  get_agent: pair("Reading", "Read", "agent"),
  get_notes: () => ["Reading the notes", "Read the notes"],
  set_notes: () => ["Writing the notes", "Wrote the notes"],
  add_task: (i) => [`Adding a task${titled(i)}`, `Added a task${titled(i)}`],
  update_task: pair("Updating", "Updated", "task"),
  cancel_task: pair("Cancelling", "Cancelled", "task"),
  retry_task: pair("Retrying", "Retried", "task"),
  edit_notes: (i) => { const h = i?.heading ? `: ${clip(i.heading, 36)}` : ""; return [`Editing the notes${h}`, `Edited the notes${h}`]; },
  wait_for: (i) => {
    const ids = Array.isArray(i?.tasks) ? i.tasks.map(String).filter(Boolean) : [];
    if (!ids.length) return ["Setting what it waits for", "Set what it waits for"];
    const of = `${i.mode === "any" ? "the first of " : ""}${ids.join(", ")}`;
    return [`Waiting for ${of}`, `Will wait for ${of}`];
  },
  finish_run: () => ["Finishing the run", "Finished the run"],
  tell_orchestrator: () => ["Telling the orchestrator", "Told the orchestrator"],
};

/** A run tool's label, or null for any other tool. Object.hasOwn: a plain lookup would take a
 *  tool named toString for one of the table's. */
export function runTool(name: string, input: any, done: boolean): string | null {
  const n = short(name);
  if (!name.startsWith("mcp__board__") || !Object.hasOwn(RUN_TOOLS, n)) return null;
  return RUN_TOOLS[n](input ?? {})[done ? 1 : 0];
}

/** The board a board tool call names: its name, the id when unknown, or "this board". */
function boardOf(input: any, nameOf: BoardNames): string {
  const id = input?.board ? String(input.board) : "";
  if (!id) return "this board";
  return nameOf(id) ?? id;
}

/** The label of a running tool call. */
export function toolVerb(name: string, input: any, nameOf: BoardNames = noNames): string {
  const g = genericTool(name, input, false) ?? runTool(name, input, false);
  if (g) return g;
  const board = boardOf(input, nameOf);
  switch (short(name)) {
    case "list_boards": return "Listing boards";
    case "read_board": return `Reading ${board}`;
    case "get_view": return "Looking at your view";
    case "get_image": return `Looking at ${board}`;
    case "apply": return `Editing ${board}`;
    case "delete_elements": return `Deleting on ${board}`;
    case "create_board": return input?.name ? `Creating ${input.name}` : "Creating a board";
    case "show_board": return `Showing ${board}`;
    case "wait_subagents": return "Waiting for subagents";
    case "stop_subagent": return "Stopping subagent";
    case "list_subagent_models": return "Listing subagent models";
    default: return short(name);
  }
}

/** The label of a finished tool call. */
export function toolDone(name: string, input: any, result: string | undefined, nameOf: BoardNames = noNames): string {
  const g = genericTool(name, input, true) ?? runTool(name, input, true);
  if (g) return g;
  let r: any = null;
  try { r = result ? JSON.parse(result) : null; } catch {}
  const board = r && typeof r === "object" && typeof r.board === "string" ? r.board : boardOf(input, nameOf);
  switch (short(name)) {
    case "list_boards": return "Listed boards";
    case "read_board": return `Read ${board}`;
    case "get_view": return "Looked at your view";
    case "get_image": return `Looked at ${board}`;
    case "apply": {
      if (!r || typeof r !== "object") return `Edited ${board}`;
      const parts = [];
      const nc = Object.keys(r.created ?? {}).length, nu = (r.updated ?? []).length;
      if (nc) parts.push(`+${nc}`);
      if (nu) parts.push(`~${nu}`);
      if (r.conflicts?.length) parts.push(`${r.conflicts.length} conflict${r.conflicts.length > 1 ? "s" : ""}`);
      return `Edited ${board}${parts.length ? " · " + parts.join(" ") : ""}`;
    }
    case "delete_elements": return r && typeof r === "object" ? `Deleted ${r.deleted?.length ?? 0} on ${board}` : `Deleted on ${board}`;
    case "create_board": return `Created ${input?.name ?? "a board"}`;
    case "show_board": return `Showed ${board}`;
    case "wait_subagents": return "Waited for subagents";
    case "stop_subagent": return "Stopped subagent";
    case "list_subagent_models": return "Listed subagent models";
    default: return short(name);
  }
}

/** The chat's name, or its first message until it is named. */
export function chatTitle(c: Pick<ChatView, "name">, items?: Item[]): string {
  if (c.name) return c.name;
  const first = items?.find((i) => i.kind === "user");
  if (!first?.text) return "New chat";
  const t = plainText(first.text).replace(/\s+/g, " ").trim();
  return t.length > 42 ? t.slice(0, 40) + "…" : t;
}

/** What a chat that is not busy waits on, from its two subagent counts: the subagents it spawned
 *  that still run, and the results the agent has not been sent. "" with neither, while the agent is
 *  busy, and for an archived chat, which takes no message. */
export function waitingText(c: Pick<ChatView, "status" | "subsRunning" | "subsOwed" | "archived">): string {
  if (isBusy(c.status) || c.archived) return "";
  const running = c.subsRunning ?? 0, owed = c.subsOwed ?? 0;
  const parts: string[] = [];
  if (running > 0) parts.push(`Waiting on ${running} subagent${running === 1 ? "" : "s"}`);
  if (owed > 0) parts.push(owed === 1
    ? "1 subagent result not sent yet. It goes to the agent after your next message."
    : `${owed} subagent results not sent yet. They go to the agent after your next message.`);
  return parts.join(". ");
}

type Stated = Pick<ChatView, "status" | "statusTool" | "usage" | "subsRunning" | "subsOwed" | "archived" | "fresh">;

/** The chat's status line. An idle chat says what it waits on (waitingText), when it does; a fork
 *  without a message whose agent starts says that, not what a turn would. */
export function statusText(c: Stated, nameOf: BoardNames = noNames): string {
  if (starting(c)) return "Starting the agent…";
  switch (c.status) {
    case "ready": return waitingText(c) || (c.usage?.turns ? "Idle" : "Ready");
    case "thinking": return "Thinking…";
    case "writing": return "Writing…";
    case "tool": return toolVerb(c.statusTool ?? "", null, nameOf) + "…";
    case "approval": return "Needs your approval";
    case "stopped": return "Stopped";
    case "error": return "Can't start";
  }
}

type Row = Stated & Pick<ChatView, "working" | "approvals">;

/** The state a sidebar row's dot shows. A branch that waits for approval comes first, whichever
 *  branch it is: it blocks its agent until the user answers. Then the current branch's status when
 *  it is busy; then "thinking" when another branch works, as rowLine tells of it before a current
 *  branch that stopped or can't start; then that status; else "waiting" for an idle chat that
 *  waits on subagents or holds results for the agent, else the status. */
export const dotState = (c: Row): ChatView["status"] | "waiting" => {
  if ((c.approvals ?? 0) > 0) return "approval";
  if (isBusy(c.status)) return c.status;
  if ((c.working ?? 0) > 0) return "thinking";
  if (c.status !== "ready") return c.status;
  return waitingText(c) ? "waiting" : c.status;
};

/** A sidebar chat row's second line: an approval any branch waits for; else what the current
 *  branch is doing when that says something (busy, stopped, can't start); else how many other
 *  branches work; else what it waits on (subagents, their results), else its settings line. */
export function rowLine(c: Row & Pick<ChatView, "error">, settings: string, nameOf: BoardNames = noNames): string {
  if ((c.approvals ?? 0) > 0) return "Needs your approval";
  if (isBusy(c.status)) return statusText(c, nameOf);
  const n = c.working ?? 0;
  if (n > 0) return n === 1 ? "1 branch working" : `${n} branches working`;
  if (c.status === "stopped") return "Stopped";
  if (c.status === "error") return c.error || statusText(c, nameOf);
  return waitingText(c) ? statusText(c, nameOf) : settings;
}

/** What the chat's header tells of the branches other than the one the chat is on (shown), from
 *  the chat's records. asks: the first of them that waits for the user's approval, by its id;
 *  failed: the first of them whose turn could not start or ended in an error, by its id (its
 *  record says so until the branch is sent to again); working: how many of them are in a turn
 *  without waiting for approval. */
export function otherBranches(states: readonly Pick<BranchState, "branch" | "status">[], shown: string): { asks: string | null; failed: string | null; working: number } {
  const others = states.filter((st) => st.branch !== shown);
  return {
    asks: others.find((st) => st.status === "approval")?.branch ?? null,
    failed: others.find((st) => st.status === "error")?.branch ?? null,
    working: others.filter((st) => isBusy(st.status) && st.status !== "approval").length,
  };
}

export type BranchAlertKind = "asks" | "failed" | "working";

/** What the header shows of the other branches, in order: the approval alone; else the error, and
 *  after it how many work, when any do (an error stays until its branch is sent to again: it does
 *  not hide the count); else how many work; nothing when there is nothing to tell. */
export function alertsOf(o: ReturnType<typeof otherBranches>): BranchAlertKind[] {
  if (o.asks !== null) return ["asks"];
  const working: BranchAlertKind[] = o.working > 0 ? ["working"] : [];
  return o.failed !== null ? ["failed", ...working] : working;
}

/** The text of one of alertsOf's: the approval or the error by the branch's name (name gives it),
 *  or how many work. */
export function alertText(o: ReturnType<typeof otherBranches>, kind: BranchAlertKind, name: (branch: string) => string): string {
  if (kind === "asks") return `Approval needed on “${name(o.asks ?? "")}”`;
  if (kind === "failed") return `Error on “${name(o.failed ?? "")}”`;
  return `${o.working} other ${o.working === 1 ? "branch" : "branches"} working`;
}

/** The header's line about the other branches, the first of alertsOf's: the approval first, by
 *  the branch's name (name gives it); else the error, by the branch's name; else how many work;
 *  "" when there is nothing to tell. */
export function otherBranchesText(o: ReturnType<typeof otherBranches>, name: (branch: string) => string): string {
  const [first] = alertsOf(o);
  return first ? alertText(o, first, name) : "";
}
