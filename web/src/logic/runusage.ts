// What a run's agents used, for the dock's Usage tab: sums by tier and by kind of agent, and the
// orchestrator turns that changed nothing. All of it is derived from the run's detail: the
// server sends no sums. (logic/usage.ts is another thing: a chat's plan limits.)
import { money, tokensShort } from "./runview.ts";
import { TIERS } from "../types.ts";
import type { OpName, RunAgent, RunDetail, TokenCount } from "../types.ts";

export type UsageRow = { key: string; agents: number; cost: number | null; costPerAgent: number | null;
                         tokens: TokenCount | null; medianPeakContext: number | null;
                         /** How long its agents ran, from start to end; one still at work is not counted. null: none has ended. */
                         ms: number | null };
export type RunUsage = {
  byTier: UsageRow[];  // deep, standard, light: every agent in its own tier (the orchestrator's turns, the merge agents too), so the rows add up to the total; a tier with no agent has no row; last, NO_TIER for the agents with none
  byKind: UsageRow[];  // "orchestrator", the task kinds by cost, "merge"; a row with no agent is left out
  total: { agents: number; cost: number | null; medianPeakContext: number | null; ms: number | null };
  /** No agent has a cost or tokens (the agent kind reports none): the tab leaves those columns out. */
  bare: boolean;
  turns: { done: number; cost: number | null; quiet: number; quietCost: number | null };
};

type Used = Pick<RunAgent, "cost" | "tokens" | "peakContext" | "startedAt" | "endedAt">;

/** The sum of the numbers there are; null when there is none. */
function sum(values: (number | null | undefined)[]): number | null {
  let total: number | null = null;
  for (const v of values) if (typeof v === "number") total = (total ?? 0) + v;
  return total;
}

/** The upper median of the peaks that are known (above 0); null when none is. */
function medianPeak(agents: Used[]): number | null {
  const peaks = agents.map((a) => a.peakContext ?? 0).filter((p) => p > 0).sort((a, b) => a - b);
  return peaks.length ? peaks[Math.floor(peaks.length / 2)] : null;
}

function row(key: string, agents: Used[]): UsageRow {
  const cost = sum(agents.map((a) => a.cost));
  let tokens: TokenCount | null = null;
  for (const a of agents) {
    if (!a.tokens) continue;
    tokens ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    tokens.in += a.tokens.in; tokens.out += a.tokens.out; tokens.cacheRead += a.tokens.cacheRead; tokens.cacheWrite += a.tokens.cacheWrite;
  }
  const ms = sum(agents.map((a) => (a.endedAt != null ? Math.max(0, a.endedAt - a.startedAt) : null)));
  return { key, agents: agents.length, cost, costPerAgent: cost == null ? null : cost / agents.length, tokens, medianPeakContext: medianPeak(agents), ms };
}

/** The key of the agents with no tier (a run from before tiers). */
export const NO_TIER = "—";

/** The key of the task agents whose task the detail does not have (or that has no kind). */
export const NO_KIND = "other";

/** The ops that change the run's plan: a turn none of whose ops is one of these (refused ones do not count) changed nothing. */
const CHANGES: ReadonlySet<OpName> = new Set<OpName>(["add_task", "update_task", "cancel_task", "retry_task", "finish_run"]);

export function runUsage(detail: RunDetail): RunUsage {
  const agents = Object.values(detail.agents ?? {});
  const tasks = agents.filter((a) => a.role === "task");

  const tierless = agents.filter((a) => !TIERS.includes(a.tier));
  const byTier = [...TIERS.map((t) => row(t, agents.filter((a) => a.tier === t))), row(NO_TIER, tierless)].filter((r) => r.agents > 0);

  const kindOf = new Map((detail.tasks ?? []).map((t) => [t.id, t.kind]));
  const kinds = new Map<string, RunAgent[]>();
  for (const a of tasks) {
    const k = (a.task != null && kindOf.get(a.task)) || NO_KIND;
    kinds.set(k, [...(kinds.get(k) ?? []), a]);
  }
  const kindRows = [...kinds].map(([k, g]) => row(k, g)).sort((a, b) =>
    a.cost != null && b.cost != null && a.cost !== b.cost ? b.cost - a.cost
      : (a.cost == null) !== (b.cost == null) ? (a.cost == null ? 1 : -1)
        : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const byKind = [
    row("orchestrator", agents.filter((a) => a.role === "orchestrator")),
    ...kindRows,
    row("merge", agents.filter((a) => a.role === "merge")),
  ].filter((r) => r.agents > 0);

  const done = (detail.turns ?? []).filter((t) => t.status === "done");
  const quiet = done.filter((t) => !(t.ops ?? []).some((o) => !o.error && CHANGES.has(o.op)));
  const all = row("", agents);
  return {
    byTier, byKind,
    total: { agents: all.agents, cost: all.cost, medianPeakContext: all.medianPeakContext, ms: all.ms },
    bare: agents.length > 0 && agents.every((a) => a.cost == null && !a.tokens),
    turns: { done: done.length, cost: sum(done.map((t) => t.cost)), quiet: quiet.length, quietCost: sum(quiet.map((t) => t.cost)) },
  };
}

/** Whether the turns that changed nothing are worth a warning: more than a quarter of the done ones. */
export const manyQuiet = (t: Pick<RunUsage["turns"], "done" | "quiet">): boolean => t.quiet * 4 > t.done;

/** A row's share of its table's cost, 0 to 1; 0 when either is unknown or the table cost nothing. */
export function costShare(cost: number | null, of: number | null): number {
  return cost != null && of != null && of > 0 ? Math.max(0, Math.min(1, cost / of)) : 0;
}

// ---- how the figures are written

/** What is shown for a figure there is none of. */
export const NONE = "—";
/** "$117.62" as the run's header writes it; "—" for none. */
export const usageMoney = (usd: number | null | undefined): string => (typeof usd === "number" ? money(usd) : NONE);
/** "1.4M", "400k", "950"; "—" for none. */
export const usageTokens = (n: number | null | undefined): string => (typeof n === "number" ? tokensShort(n) : NONE);

/** The note under the tables of a run whose agents report less than the columns show: said from
 *  what is missing (all of the agents: the agent kind reports none; some: who). Empty when nothing
 *  is, and for a run with no agent. */
export function missingNote(detail: RunDetail): string {
  const agents = Object.values(detail.agents ?? {});
  if (!agents.length) return "";
  const cost = agents.filter((a) => a.cost == null).length, tokens = agents.filter((a) => !a.tokens).length;
  const peak = agents.filter((a) => !((a.peakContext ?? 0) > 0)).length;
  const all = agents.length;
  const list = (words: string[]) => (words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : words[0]);
  const none = [cost === all && "cost", tokens === all && "tokens", peak === all && "peak context"].filter((w): w is string => !!w);
  if (none.includes("cost") || none.includes("tokens")) return `This agent kind reports no ${list(none)}.`;
  const some = [cost > 0 && "cost", tokens > 0 && "tokens"].filter((w): w is string => !!w);
  if (!some.length) return "";
  // an agent reports its cost when it ends: on a live run the ones at work are the usual ones without
  const atWork = agents.every((a) => a.status === "running" || (a.cost != null && a.tokens));
  return atWork ? `The agents still at work have reported no ${list(some)} yet.` : `Some agents reported no ${list(some)}: the sums are of those that did.`;
}
