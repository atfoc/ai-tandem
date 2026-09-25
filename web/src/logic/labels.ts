// One-line labels for tool cards and the chat status. DOM-free.
//
// Board tools take a board id (`board`, optional: the chat's own board when
// left out). The label names the board through `nameOf` (id → name, from the
// store), or says "this board" when the argument is left out.

import type { CatalogModel, ChatView } from "../types.ts";

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

/** Claude Code's own tools, and other MCP servers', in the same one-line style. */
export function genericTool(name: string, input: any, done: boolean): string | null {
  const i = input ?? {};
  switch (name) {
    case "Bash": return i.description ? clip(i.description) : `${done ? "Ran" : "Running"} ${i.command ? "`" + clip(i.command, 40) + "`" : "a command"}`;
    case "Read": return `${done ? "Read" : "Reading"} ${base(i.file_path) || "a file"}`;
    case "Write": return `${done ? "Wrote" : "Writing"} ${base(i.file_path) || "a file"}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `${done ? "Edited" : "Editing"} ${base(i.file_path ?? i.notebook_path) || "a file"}`;
    case "Glob": return `${done ? "Found files" : "Finding files"}${i.pattern ? " " + clip(i.pattern, 30) : ""}`;
    case "Grep": return `${done ? "Searched" : "Searching"}${i.pattern ? " for " + clip(i.pattern, 30) : ""}`;
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

/** The board a board tool call names: its name, the id when unknown, or "this board". */
function boardOf(input: any, nameOf: BoardNames): string {
  const id = input?.board ? String(input.board) : "";
  if (!id) return "this board";
  return nameOf(id) ?? id;
}

/** The label of a running tool call. */
export function toolVerb(name: string, input: any, nameOf: BoardNames = noNames): string {
  const g = genericTool(name, input, false);
  if (g) return g;
  const board = boardOf(input, nameOf);
  switch (short(name)) {
    case "list_boards": return "Listing boards";
    case "read_board": return `Reading ${board}`;
    case "get_view": return "Looking at your view";
    case "apply": return `Editing ${board}`;
    case "delete_elements": return `Deleting on ${board}`;
    case "create_board": return input?.name ? `Creating ${input.name}` : "Creating a board";
    case "show_board": return `Showing ${board}`;
    default: return short(name);
  }
}

/** The label of a finished tool call. */
export function toolDone(name: string, input: any, result: string | undefined, nameOf: BoardNames = noNames): string {
  const g = genericTool(name, input, true);
  if (g) return g;
  let r: any = null;
  try { r = result ? JSON.parse(result) : null; } catch {}
  const board = r && typeof r === "object" && typeof r.board === "string" ? r.board : boardOf(input, nameOf);
  switch (short(name)) {
    case "list_boards": return "Listed boards";
    case "read_board": return `Read ${board}`;
    case "get_view": return "Looked at your view";
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
    default: return short(name);
  }
}

/** The chat's status line. */
export function statusText(c: Pick<ChatView, "status" | "statusTool" | "usage">, nameOf: BoardNames = noNames): string {
  switch (c.status) {
    case "ready": return c.usage?.turns ? "Idle" : "Ready";
    case "thinking": return "Thinking…";
    case "writing": return "Writing…";
    case "tool": return toolVerb(c.statusTool ?? "", null, nameOf) + "…";
    case "approval": return "Needs your approval";
    case "stopped": return "Stopped";
    case "error": return "Can't start";
  }
}
