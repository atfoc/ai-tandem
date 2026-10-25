// What the phone's tool steps, permission cards and dock say (ux-improvements goal 3.5, package T2), decided from the items. DOM-free.
//
// foldOf: which run an item belongs to on the phone (the thread's rows fold it, screens/chat/rows.ts): a finished call that only read
// (a file read, a search, a listing, a look at a board) folds with the next ones of its kind into one row; a call that started a
// subagent goes in the card of its run of such calls. A call that failed, was denied or still runs is never folded: it is what the
// person has to see.
import type { Item } from "../types.ts";
import type { DiffRow, NumberedRow } from "./linediff.ts";
import { isSubagentTool } from "./subagents.ts";

/** What a run folds into (the app's rows.ts `FoldKind`, or none). */
export type FoldKindOf = "steps" | "subagents" | null;

/** The tools that only read, by name (Claude Code's, Pi's, Cursor's, the board's). */
const READS = new Set([
  "Read", "read", "Glob", "find", "Grep", "grep", "LS", "ls", "WebSearch", "WebFetch", "ToolSearch",
  "mcp__board__read_board", "mcp__board__get_view", "mcp__board__get_image", "mcp__board__list_boards",
]);

/** Whether a call only read and ended well: it folds with its neighbours on the phone. */
export function readOnlyStep(item: Item): boolean {
  return item.kind === "tool" && typeof item.name === "string" && READS.has(item.name)
    && item.result !== undefined && !item.isError && !item.denied;
}

/** The run an item folds into on the phone, or null. */
export function foldOf(item: Item): FoldKindOf {
  if (isSubagentTool(item)) return "subagents";
  return readOnlyStep(item) ? "steps" : null;
}

// ---- the phone's step card (ux-improvements goal 3.5): what its parts say, decided from the item and the texts

/** The exit code a shell call's result tells, or null when it tells none. Claude Code ends (or begins) a failed result with "Exit code N",
 *  Pi's says "Command exited with code N", and a Go program run through `go test` or `go run` ends with its own "exit status N". */
export function exitCode(item: Item): number | null {
  const r: unknown = item.result;
  if (typeof r !== "string") return null;
  const lines = r.split("\n").map((l) => l.trim()).filter(Boolean);
  const ends = [lines[0], lines[lines.length - 1]];
  for (const l of ends) { const m = l && /^Exit code (\d+)$/i.exec(l); if (m) return Number(m[1]); }
  for (const l of lines) { const m = /^Command exited with code (\d+)\b/.exec(l); if (m) return Number(m[1]); }
  const go = lines.length ? /^exit status (\d+)$/.exec(lines[lines.length - 1]) : null;
  if (go) return Number(go[1]);
  return null;
}

/** The last `n` lines of a text, with how many it has in all (a line break at the very end closes the last line and opens no empty one). */
export function lastLines(text: string, n: number): { text: string; shown: number; total: number } {
  const lines = text ? text.replace(/\n$/, "").split("\n") : [];
  const shown = Math.min(n, lines.length);
  return { text: lines.slice(lines.length - shown).join("\n"), shown, total: lines.length };
}

/** The second line of a folded run of reads from the labels of its calls ("Read coupon.go", "Read cart.go"): one verb they all begin with is
 *  said once, "Read coupon.go, cart.go"; calls with different verbs are told one after the other, "Read coupon.go · Searched for x". */
export function groupSummary(all: readonly string[]): string {
  const labels = [...new Set(all)]; // (the same label twice is said once)
  const split = labels.map((l) => { const at = l.indexOf(" "); return at > 0 ? { verb: l.slice(0, at), rest: l.slice(at + 1) } : { verb: l, rest: "" }; });
  if (split.length > 1 && split.every((s) => s.rest && s.verb === split[0].verb)) return `${split[0].verb} ${split.map((s) => s.rest).join(", ")}`;
  return labels.join(" · ");
}

/** The rows a card draws of its changes, at most `max` of all of them, in order; left: how many were not drawn. */
export function capRows<T>(changes: readonly (readonly T[])[], max: number): { changes: T[][]; left: number } {
  let room = max, left = 0;
  const shown = changes.map((rows) => { const keep = Math.max(0, Math.min(rows.length, room)); room -= keep; left += rows.length - keep; return rows.slice(0, keep); });
  return { changes: shown.filter((rows) => rows.length), left };
}

/** The line a change's first changed row has in its file (the new number for an added line, the old for a removed one), or null when
 *  the rows have no numbers or no changed row. */
export function headLine(rows: readonly NumberedRow[]): number | null {
  const r = rows.find((x) => x.kind === "add" || x.kind === "del");
  return r ? (r.kind === "add" ? r.b : r.a) ?? null : null;
}

/** The number a row shows in the one column of the phone's diff: the new line's for a line that is added or stays, the old for one that is removed. */
export const rowNumber = (r: NumberedRow): number | undefined => (r.kind === "del" ? r.a : r.b);

/** The rows as the text a copy puts on the clipboard: "-old", "+new", " same"; a stretch of unchanged lines left out is told in one line. */
export function unifiedText(changes: readonly (readonly DiffRow[])[]): string {
  return changes.map((rows) => rows.map((r) => r.kind === "skip" ? `@@ ${r.count} unchanged line${r.count === 1 ? "" : "s"} @@`
    : `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`).join("\n")).join("\n");
}
