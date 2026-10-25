// Subagents: what the row and the drawer show, from an Agent/Task/spawn_subagent tool item, the
// subagent's state and, when loaded, its own thread. DOM-free.
import type { AgentKind, Catalog, Item, Subagent } from "../types.ts";
import { effortLabel, toolVerb, type BoardNames } from "./labels.ts";
import type { BranchKey } from "./branches.ts";
import { pausedLine, retryLine } from "./retry.ts";

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

/** A subagent that waits: it runs, and its own turn has ended while subagents it started still run
 *  or their results have not reached it yet. Neither working nor finished. */
export const subWaiting = (sa: Subagent): boolean => subStatus(sa) === "running" && !!sa.waiting;

/** What a waiting subagent's line says: how many of the subagents it started still run, and its own
 *  background work (bgWaiting) when that is part of what it waits on; else that their results have
 *  not reached it yet. subs: the chat's subagents. */
export function subWaitingText(sa: Subagent, subs?: Record<string, Subagent>): string {
  const n = subChildren(subs, sa.id).filter((x) => subStatus(x) === "running").length;
  if (sa.bgWaiting) return n ? `Waiting on ${n} subagent${n === 1 ? "" : "s"} and background work` : "Waiting for background work";
  return n ? `Waiting on ${n} subagent${n === 1 ? "" : "s"}` : "Waiting on its subagents' results";
}

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
 *  activity or result, one that is paused or retried says so, and one that waits says what it waits on
 *  (subs: the chat's subagents; now: unix ms, for the time to the next attempt). */
export function subLine(it: Item, sa: Subagent, items?: Item[], nameOf?: BoardNames, subs?: Record<string, Subagent>, now = Date.now()): { text: string; tone: "live" | "muted" | "error" } {
  if (sa.notCarried) return { text: NOT_CARRIED, tone: "muted" };
  if (sa.status === "paused") return { text: pausedLine(sa), tone: "error" };
  if (sa.status === "running" && sa.retry?.attempt) return { text: retryLine(sa.retry, now), tone: "muted" };
  if (subWaiting(sa)) return { text: subWaitingText(sa, subs), tone: "muted" };
  switch (sa.status) {
    case "running": return { text: subActivity(sa, items, nameOf), tone: "live" };
    case "completed": { const f = firstLine(subReport(it, sa, items)); return { text: f ? `Done · ${f}` : "Done", tone: "muted" }; }
    case "failed": return { text: firstLine(sa.error) || "Failed", tone: "error" };
    case "stopped": return { text: "Stopped", tone: "muted" };
    default: return { text: String(sa.status ?? ""), tone: "muted" }; // a status a newer server added
  }
}

const RESULT_STATUS: Record<Subagent["status"], string> = { running: "Running", completed: "Done", failed: "Failed", stopped: "Stopped", paused: "Paused" };
const RESULT_DELIVERY: Record<NonNullable<Subagent["delivery"]>, string> = {
  owed: "not sent yet", retry: "not sent yet", sent: "sent to the agent", "given-up": "could not be delivered",
};
/** A nested subagent's result goes to the subagent that started it, not to the chat's agent. */
const SENT_NESTED = "sent to the subagent that started it";

/** A result row's text: the subagent's name, then its final status, that it ended with an error
 *  when its state carries one, and whether the result has reached the agent, or for a nested
 *  subagent the one that started it, in whose thread the row is (nothing for a
 *  delivery state a newer server added, the raw word for a status it added). One that was not carried
 *  over has no result and nothing is owed for it. sa is undefined until the chat's subagents are loaded. */
export function subResultLine(sa: Subagent | undefined): { name: string; text: string; tone: "muted" | "error" } {
  if (!sa) return { name: "Subagent", text: "", tone: "muted" };
  if (sa.notCarried) return { name: sa.description || "Subagent", text: NOT_CARRIED, tone: "muted" };
  const parts = [Object.hasOwn(RESULT_STATUS, sa.status) ? RESULT_STATUS[sa.status] : String(sa.status ?? "")].filter(Boolean);
  if (sa.error) parts.push("ended with an error");
  const delivery = sa.delivery && (sa.delivery === "sent" && sa.parent ? SENT_NESTED : RESULT_DELIVERY[sa.delivery]);
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

/** The phone row's duration: "40s", "7m" (minutes only, from one minute on), "1h 02m". */
export function fmtDurationShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A chat's subagents in the order they started (nested ones included). */
export const subList = (subs: Record<string, Subagent> | undefined): Subagent[] =>
  Object.values(subs ?? {}).sort((a, b) => (a.started ?? 0) - (b.started ?? 0) || a.id.localeCompare(b.id));

// ---- nesting: a subagent names the one that started it (parent); none is the chat's agent.

/** The subagents one started, by its sid, in the order they started. */
export const subChildren = (subs: Record<string, Subagent> | undefined, sid: string): Subagent[] =>
  sid ? subList(subs).filter((x) => x.parent === sid && x.id !== sid) : [];

/** The subagents above one, outermost first: from the one the chat's agent started down to the one
 *  that started it. None for a subagent of the chat's agent, and for one whose parent is not known. */
export function subAncestors(sa: Subagent | undefined, subs: Record<string, Subagent> | undefined): Subagent[] {
  const out: Subagent[] = [], seen = new Set([sa?.id]);
  for (let p = sa?.parent ? subs?.[sa.parent] : undefined; p && !seen.has(p.id); p = p.parent ? subs?.[p.parent] : undefined) { // seen: a guard against a loop in the records
    seen.add(p.id); out.unshift(p);
  }
  return out;
}

/** A subagent with its level: 1 for one the chat's agent started, 2 for one that subagent started. */
export type SubNode = { sa: Subagent; level: number };

/** A chat's subagents as a tree laid out flat, for ‹ n/N ›: each one is followed by the ones it
 *  started, and theirs, before the next one of its own level; within a level in the order they
 *  started. One whose parent is not known stands at level 1. */
export function subTree(subs: Record<string, Subagent> | undefined): SubNode[] {
  const all = subList(subs), by = new Map<string, Subagent[]>();
  for (const x of all) {
    const p = x.parent && x.parent !== x.id && subs?.[x.parent] ? x.parent : "";
    by.set(p, [...(by.get(p) ?? []), x]);
  }
  const out: SubNode[] = [], seen = new Set<string>();
  const walk = (parent: string, level: number) => {
    for (const sa of by.get(parent) ?? []) {
      if (seen.has(sa.id)) continue;
      seen.add(sa.id); out.push({ sa, level }); walk(sa.id, level + 1);
    }
  };
  walk("", 1);
  for (const sa of all) if (!seen.has(sa.id)) { seen.add(sa.id); out.push({ sa, level: 1 }); walk(sa.id, 2); } // a loop in the records hangs on no root
  return out;
}

/** The head of a call's card on the phone: how many subagents the roots stand for (each root and every one it started, at any depth, once)
 *  and how many of them run (a waiting one too), and whether every root is a background one. Roots not linked yet have no id and
 *  count one each. */
export function subRunCounts(subs: Record<string, Subagent> | undefined, roots: Subagent[]): { count: number; running: number; background: boolean } {
  const seen = new Set<string>();
  let count = 0, running = 0;
  const walk = (sa: Subagent) => {
    if (sa.id) { if (seen.has(sa.id)) return; seen.add(sa.id); }
    count++;
    if (subStatus(sa) === "running") running++; // one that waits on those it started still runs (the mockup's "2 running")
    for (const x of subChildren(subs, sa.id)) walk(x);
  };
  for (const r of roots) walk(r);
  return { count, running, background: roots.length > 0 && roots.every((r) => !!r.background) };
}

// ---- the phone's subagent screen: its steps folded to one row, and the pills

/** What a subagent's steps did, counted from its thread: every tool call is a step; files read (a Read of a file, not a search), files
 *  edited (distinct paths, a Write counts), commands run. */
export type StepsSummary = { steps: number; reads: number; edits: number; runs: number };

const READ_FILE = new Set(["Read", "read"]);
const EDIT_FILE = new Set(["Edit", "MultiEdit", "NotebookEdit", "edit", "Write", "write"]);
const RUN_COMMAND = new Set(["Bash", "bash", "powershell"]);

export function stepsSummary(items?: Item[]): StepsSummary {
  const out = { steps: 0, reads: 0, edits: 0, runs: 0 };
  const edited = new Set<string>();
  let unnamed = 0;
  for (const it of items ?? []) {
    if (it?.kind !== "tool") continue;
    out.steps++;
    const name = it.name ?? "", input: any = it.input ?? {};
    if (READ_FILE.has(name)) out.reads++;
    else if (RUN_COMMAND.has(name)) out.runs++;
    else if (EDIT_FILE.has(name)) edited.add(String(input.file_path ?? input.notebook_path ?? input.path ?? `#${unnamed++}`));
  }
  out.edits = edited.size;
  return out;
}

/** "14 steps · read 8 files": the steps, then at most two of the read, edited and ran counts that are not 0, in that order. steps is the
 *  tool-call count the pills show (Claude's own count can be larger than the loaded thread's), `sum` what the loaded thread did. */
export function stepsLine(steps: number, sum: Pick<StepsSummary, "reads" | "edits" | "runs">): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [
    sum.reads ? `read ${plural(sum.reads, "file", "files")}` : "",
    sum.edits ? `edited ${plural(sum.edits, "file", "files")}` : "",
    sum.runs ? `ran ${plural(sum.runs, "command", "commands")}` : "",
  ].filter(Boolean).slice(0, 2);
  return [plural(steps, "step", "steps"), ...parts].join(" · ");
}

/** "Subagent 1 of 4 · Done": where it stands in the chat's subagents (the order ‹ › goes through), then its state in words. */
export function subScreenSub(sa: Subagent, subs: Record<string, Subagent> | undefined): { text: string; tone: "ok" | "wait" | "bad" } {
  const list = subTree(subs), at = list.findIndex((n) => n.sa.id === sa.id);
  const state = sa.notCarried ? { word: "Stopped", tone: "wait" as const }
    : subWaiting(sa) ? { word: subWaitingText(sa, subs), tone: "wait" as const }
    : sa.status === "running" ? { word: "Running", tone: "ok" as const }
    : sa.status === "completed" ? { word: "Done", tone: "wait" as const }
    : sa.status === "failed" ? { word: "Failed", tone: "bad" as const }
    : sa.status === "stopped" ? { word: "Stopped", tone: "wait" as const }
    : { word: String(sa.status ?? ""), tone: "wait" as const };
  return { text: [at >= 0 ? `Subagent ${at + 1} of ${list.length}` : "Subagent", state.word].filter(Boolean).join(" · "), tone: state.tone };
}

/** The subagents on either side of one in the chat's order, without wrapping round: the first has no previous, the last no next. */
export function subNeighbours(sa: Subagent, subs: Record<string, Subagent> | undefined): { prev?: Subagent; next?: Subagent } {
  const list = subTree(subs).map((n) => n.sa), at = list.findIndex((x) => x.id === sa.id);
  return at < 0 ? {} : { prev: list[at - 1], next: list[at + 1] };
}
