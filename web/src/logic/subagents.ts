// Subagents: what the row and the drawer show, from an Agent/Task/spawn_subagent tool item, the
// subagent's state and, when loaded, its own thread. DOM-free.
import type { AgentKind, Catalog, Item, Subagent } from "../types.ts";
import { effortLabel, toolVerb, type BoardNames } from "./labels.ts";
import type { BranchKey } from "./branches.ts";

const DEFAULT_TYPES = new Set(["", "general-purpose", "generalPurpose", "general_purpose", "unspecified"]);

/** An Agent/Task/spawn_subagent tool call: it started a subagent. */
export const isSubagentTool = (it: Item | undefined): boolean =>
  !!it && it.kind === "tool" && (it.name === "Agent" || it.name === "Task" || it.name === "mcp__board__spawn_subagent");

export type SubKey = string & { readonly __subKey: unique symbol };
/** The key of a subagent's thread in store.items: "<chat>:<branch>/<sid>", k being its branch's key. */
export const subKey = (k: BranchKey, sid: string): SubKey => `${k}/${sid}` as SubKey;

/** The subagent of an Agent/Task item: its state once linked. Before that (the agent has not
 *  reported it yet, or a chat saved before subagents were tracked) it is built from the tool call;
 *  an unlinked call without a result counts as running only while the chat is busy. */
export function subagentOf(it: Item, subs: Record<string, Subagent> | undefined, chatBusy: boolean): Subagent {
  const input: any = it.input ?? {};
  const sa = it.subagent ? subs?.[it.subagent] : undefined;
  if (sa) return {
    ...sa,
    status: subStatus(sa),
    description: sa.description || input.description,
    prompt: sa.prompt || input.prompt,
    type: sa.type ?? input.subagent_type,
  };
  const done = it.result !== undefined || !!it.denied;
  return {
    id: it.subagent ?? "", tool: it.toolId ?? "",
    status: done ? (it.isError || it.denied ? "failed" : "completed") : chatBusy ? "running" : "stopped",
    description: input.description, prompt: input.prompt, type: input.subagent_type,
    error: it.denied ? "Denied" : it.isError ? it.result : undefined,
  };
}

/** The line of a subagent that was still running in the source when this copy was made. */
export const NOT_CARRIED = "Not carried over: it was running in the chat this was copied from";

/** A subagent's status as shown: one that was not carried over is stopped, whatever its record says. */
export const subStatus = (sa: Subagent): Subagent["status"] => (sa.notCarried ? "stopped" : sa.status);

/** The type badge: the type unless it is the default general-purpose one. */
export const subBadge = (type?: string): string | null => (DEFAULT_TYPES.has(type ?? "") ? null : type!);

/** The first non-empty line, without leading markdown marks. */
export function firstLine(text?: string): string {
  const l = String(text ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
  return l.replace(/^[#>*\-\s]+/, "").trim();
}

const lastText = (items?: Item[]) => [...(items ?? [])].reverse().find((i) => i?.kind === "text")?.text ?? "";

/** The live activity while it runs: the running tool, else Claude's progress line, else
 *  Writing…/Thinking… from its last item. items is its thread, when loaded. */
export function subActivity(sa: Subagent, items?: Item[], nameOf?: BoardNames): string {
  const its = items ?? [];
  const tool = [...its].reverse().find((i) => i?.kind === "tool" && i.result === undefined && !i.denied);
  if (tool) return toolVerb(tool.name ?? "", tool.input, nameOf) + "…";
  if (sa.progress) return sa.progress;
  const last = its.at(-1);
  return last?.kind === "text" && !last.done ? "Writing…" : "Thinking…";
}

/** The report: the agent's own summary, else the Agent call's result (a foreground Claude
 *  subagent), else its last text (from its thread, else as kept when it ended). "" when none. */
export function subReport(it: Item, sa: Subagent, items?: Item[]): string {
  if (sa.summary) return sa.summary;
  if (!sa.background && sa.status === "completed" && it.result) return it.result;
  return lastText(items) || sa.last || "";
}

/** The report is shown in the drawer only when it is not just the last text again. */
export function showReport(it: Item, sa: Subagent, items?: Item[]): boolean {
  const r = subReport(it, sa, items).trim();
  return !!r && r !== (lastText(items) || sa.last || "").trim();
}

/** The row's summary line and its tone. One that was not carried over says so in place of its
 *  activity or result. */
export function subLine(it: Item, sa: Subagent, items?: Item[], nameOf?: BoardNames): { text: string; tone: "live" | "muted" | "error" } {
  if (sa.notCarried) return { text: NOT_CARRIED, tone: "muted" };
  switch (sa.status) {
    case "running": return { text: subActivity(sa, items, nameOf), tone: "live" };
    case "completed": { const f = firstLine(subReport(it, sa, items)); return { text: f ? `Done · ${f}` : "Done", tone: "muted" }; }
    case "failed": return { text: firstLine(sa.error) || "Failed", tone: "error" };
    case "stopped": return { text: "Stopped", tone: "muted" };
    default: return { text: String(sa.status ?? ""), tone: "muted" }; // a status a newer server added
  }
}

const RESULT_STATUS: Record<Subagent["status"], string> = { running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped" };
const RESULT_DELIVERY: Record<NonNullable<Subagent["delivery"]>, string> = {
  owed: "not sent yet", retry: "not sent yet", sent: "sent to the agent", "given-up": "could not be delivered",
};

/** A result row's text: the subagent's name, then its final status, that it ended with an error
 *  when its state carries one, and whether the result has reached the agent (nothing for a
 *  delivery state a newer server added, the raw word for a status it added). One that was not carried
 *  over has no result and nothing is owed for it. sa is undefined until the chat's subagents are loaded. */
export function subResultLine(sa: Subagent | undefined): { name: string; text: string; tone: "muted" | "error" } {
  if (!sa) return { name: "Subagent", text: "", tone: "muted" };
  if (sa.notCarried) return { name: sa.description || "Subagent", text: NOT_CARRIED, tone: "muted" };
  const parts = [Object.hasOwn(RESULT_STATUS, sa.status) ? RESULT_STATUS[sa.status] : String(sa.status ?? "")].filter(Boolean);
  if (sa.error) parts.push("ended with an error");
  const delivery = sa.delivery && RESULT_DELIVERY[sa.delivery];
  if (delivery) parts.push(delivery);
  return { name: sa.description || "Subagent", text: parts.join(" · "), tone: sa.error || sa.status === "failed" ? "error" : "muted" };
}

/** "model · effort" labels from the subagent's own kind and catalog, not the parent chat.
 *  Cursor puts the effort in the id ("gpt-5.4-mini-medium" = model gpt-5.4-mini, effort medium).
 *  Claude reports no effort for subagents; its model is matched by exact catalog id only. Pi
 *  reports an unqualified model ("deepseek-flash") against provider-qualified catalog ids
 *  ("deepseek/deepseek-flash"), matched by suffix. Unknown ids, a missing catalog, or an absent
 *  kind are shown as the raw id — never the parent kind. `effort` is used when the catalog match
 *  did not already produce one (Claude/Pi often won't parse it from the model id). */
export function subModelLabel(id: string | undefined, agent?: AgentKind, cat?: Catalog, effort?: string): { model: string; effort?: string } | null {
  if (!id) return null;
  const withEffort = (m: { model: string; effort?: string }) =>
    m.effort || !effort ? m : { ...m, effort: effortLabel(effort) };
  if (!agent) return withEffort({ model: id });
  const models = cat?.models ?? [];
  const exact = models.find((m) => m.id === id);
  if (exact) return withEffort({ model: exact.label });
  if (agent === "cursor") {
    for (const m of models) {
      const rest = id.startsWith(m.id + "-") ? id.slice(m.id.length + 1) : "";
      if (rest && m.efforts?.includes(rest)) return { model: m.label, effort: effortLabel(rest, m) };
    }
  } else if (agent === "pi") {
    const m = models.find((m) => m.id.endsWith("/" + id));
    if (m) return withEffort({ model: m.label });
  }
  return withEffort({ model: id });
}

/** Tool calls in its thread; Claude's own count when larger (it counts before the lines arrive,
 *  and it is all there is while the thread is not loaded). */
export const subToolCount = (sa: Subagent, items?: Item[]) =>
  Math.max(sa.toolUses ?? 0, (items ?? []).filter((i) => i?.kind === "tool").length);

/** Run time in ms, live while running; null when the start is unknown. */
export const subDurationMs = (sa: Subagent, now: number): number | null =>
  sa.started ? Math.max(0, (sa.ended || now) - sa.started) : null;

/** "0s", "42s", "3m 05s", "1h 02m". */
export function fmtDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A chat's subagents in the order they started (nested ones included), for ‹ n/N ›. */
export const subList = (subs: Record<string, Subagent> | undefined): Subagent[] =>
  Object.values(subs ?? {}).sort((a, b) => (a.started ?? 0) - (b.started ?? 0) || a.id.localeCompare(b.id));
