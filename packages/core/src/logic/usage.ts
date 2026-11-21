// Labels for an agent's plan usage limits in the context popover. DOM-free.

import type { AgentKind, PlanUsage, UsageLimit } from "../types.ts";

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

/** "in 4h 15m", "in 2d 3h", "in 12m": how long until a limit resets; "" when not reported. */
export function resetIn(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return "";
  const ms = Date.parse(resetsAt) - now;
  if (Number.isNaN(ms)) return "";
  if (ms < MIN) return "any moment";
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / HOUR), m = Math.floor((ms % HOUR) / MIN);
  if (d) return `in ${d}d${h ? ` ${h}h` : ""}`;
  if (h) return `in ${h}h${m ? ` ${m}m` : ""}`;
  return `in ${m}m`;
}

/** The reset as a local clock time: "1:09 AM" today, "Mon 6:59 PM" this week, else "Oct 3, 6:59 PM". */
export function resetAt(resetsAt: string | undefined, now: number, locale?: string, timeZone?: string): string {
  if (!resetsAt) return "";
  const t = new Date(resetsAt);
  if (Number.isNaN(t.getTime())) return "";
  const day = (d: Date) => d.toLocaleDateString("en-CA", { timeZone }); // yyyy-mm-dd in the zone
  const time = t.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", timeZone });
  if (day(t) === day(new Date(now))) return time;
  if (t.getTime() - now < 6 * DAY) return `${t.toLocaleDateString(locale, { weekday: "short", timeZone })} ${time}`;
  return `${t.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone })}, ${time}`;
}

/** The bar's colour: the context ring's thresholds, and at least "warn" when Claude says so. */
export function limitTone(l: Pick<UsageLimit, "percent" | "severity">): "ok" | "warn" | "danger" {
  if (l.percent > 80) return "danger";
  if (l.percent > 50 || (l.severity && l.severity !== "normal")) return "warn";
  return "ok";
}

/** "just now", "12s ago", "3m ago": how old the numbers are. */
export function updatedAgo(fetchedAt: string, now: number): string {
  const s = Math.floor((now - Date.parse(fetchedAt)) / 1000);
  if (Number.isNaN(s) || s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

/** Numbers older than 10 minutes: Cursor's come from a cache that may have stopped refreshing. */
export function isStale(fetchedAt: string, now: number): boolean {
  return now - Date.parse(fetchedAt) > 10 * MIN;
}

const ORDER: Record<string, number> = { session: 0, weekly_all: 1 };

/** The session first, then the week for all models, then the rest in the order given. */
export function sortLimits(ls: UsageLimit[]): UsageLimit[] {
  return ls.map((l, i) => ({ l, i })).sort((a, b) => (ORDER[a.l.kind] ?? 2) - (ORDER[b.l.kind] ?? 2) || a.i - b.i).map((x) => x.l);
}

/** The share used as reported, bounded for display and comparison. */
export const usedShare = (percent: number): number => Number.isNaN(percent) ? 0 : Math.min(100, Math.max(0, percent));
export const usedWords = (percent: number): string => `${Math.round(usedShare(percent))}% used`;

export type AgentPlan = { agent: AgentKind; usage?: PlanUsage; error?: string; loading?: boolean };

export function tightestLimit(plans: readonly AgentPlan[]): { agent: AgentKind; limit: UsageLimit; fetchedAt: string } | undefined {
  let best: { agent: AgentKind; limit: UsageLimit; fetchedAt: string } | undefined;
  let bestShare = -1, bestReset = -Infinity;
  for (const plan of plans) {
    if (plan.error || !plan.usage?.plan) continue;
    for (const limit of plan.usage.limits ?? []) {
      const share = usedShare(limit.percent);
      const at = Date.parse(limit.resetsAt ?? "");
      const reset = Number.isNaN(at) ? -Infinity : at;
      if (share > bestShare || (share === bestShare && reset > bestReset)) {
        best = { agent: plan.agent, limit, fetchedAt: plan.usage.fetchedAt };
        bestShare = share;
        bestReset = reset;
      }
    }
  }
  return best;
}

export function gaugeState(plans: readonly AgentPlan[]): "hidden" | "empty" | "ready" | "failed" {
  const capable = plans.filter((p) => p.error || !p.usage || p.usage.plan);
  if (!capable.length) return "hidden";
  if (tightestLimit(capable)) return "ready";
  return capable.every((p) => p.error) ? "failed" : "empty";
}

export const USAGE_MIN_INTERVAL = MIN;

/** The earliest automatic check, measured from the most recent request to this server. */
export function usageCheckAt({ foreground, working, turnEnded, last }: {
  foreground: boolean; working: boolean; turnEnded: boolean; last?: number;
}): number {
  if (!foreground) return Infinity;
  if (last === undefined) return 0;
  return last + (turnEnded ? USAGE_MIN_INTERVAL : working ? 5 * MIN : 30 * MIN);
}
