// A permission request in words (the phone's card and dock, ux T2): which requests still wait, who asks for what, the title the agent
// gave it, what it asks for, and the clock time of an answer. DOM-free.
import type { Item } from "../types.ts";

/** The requests of a thread that still wait: `perm` items with no answer whose place is at or after `end`, where the part copied from a
 *  fork's source ends (the server closes an undecided request there, and it cannot be answered). */
export function pendingPerms(items: readonly (Item | null | undefined)[], end: number): { item: Item; index: number }[] {
  const out: { item: Item; index: number }[] = [];
  items.forEach((item, index) => { if (item && item.kind === "perm" && !item.decided && index >= end) out.push({ item, index }); });
  return out;
}

const RUN = new Set(["bash", "powershell"]);
const EDIT = new Set(["edit", "multiedit", "notebookedit", "write"]);

/** What the request asks to do, as a phrase after "wants to": "run a command", "edit a file"… */
function permDoes(toolName: string): string {
  const n = toolName.toLowerCase();
  if (RUN.has(n)) return "run a command";
  if (EDIT.has(n)) return "edit a file";
  if (n === "delete") return "delete a file";
  if (n === "webfetch") return "fetch a page";
  if (n === "websearch") return "search the web";
  if (n.startsWith("mcp__board__")) return "use the board";
  return `use ${toolName || "a tool"}`;
}

/** "Claude wants to run a command". A subagent's request names the subagent as the one who asks: `asker` is its description. */
export function permWho(item: Item, agentName: string, asker?: string): string {
  const who = item.subagent ? `Subagent “${asker || "Subagent"}”` : agentName;
  return `${who} wants to ${permDoes(String(item.toolName ?? ""))}`;
}

type PermInput = { command?: unknown; file_path?: unknown; url?: unknown; notebook_path?: unknown; description?: unknown };

/** The title the agent gave the request (its input's `description`); "" when it gave none. */
export function permTitle(item: Item): string {
  const d = ((item.input ?? {}) as PermInput).description;
  return typeof d === "string" ? d.trim() : "";
}

/** What the request asks for: the command, the file, the URL or the notebook; "" when it names none. */
export function permWhat(item: Item): string {
  const i = (item.input ?? {}) as PermInput;
  const w = i.command ?? i.file_path ?? i.url ?? i.notebook_path;
  return w == null ? "" : String(w);
}

/** The clock time of an answer as the card says it: "14:03" (24-hour clock, local time; the clock of statewords' formatSince). */
export function permClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
