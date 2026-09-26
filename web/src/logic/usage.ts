// Labels for the Claude plan's usage limits in the context popover. DOM-free.

import type { UsageLimit } from "../types.ts";

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

const ORDER: Record<string, number> = { session: 0, weekly_all: 1 };

/** The session first, then the week for all models, then the rest in the order given. */
export function sortLimits(ls: UsageLimit[]): UsageLimit[] {
  return ls.map((l, i) => ({ l, i })).sort((a, b) => (ORDER[a.l.kind] ?? 2) - (ORDER[b.l.kind] ?? 2) || a.i - b.i).map((x) => x.l);
}
