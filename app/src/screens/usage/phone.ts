// What the phone's "Context and usage" sheet says (ux-improvements goal 3.5; package T3, chunk 2): the big number and its words, the legend's rows
// with their percents, the line that says how the count was made, and the tone of a plan limit. The numbers are the wide popup's (ctxsplit.ts,
// usage.ts); only the words and the thresholds of the phone are here. No React and no react-native here, so Node loads it (app/test/usagesheet.test.ts).
import { agentName } from "@aiwb/core/agents.ts";
import { byTokens, deferred, freeTokens, partSegments, segments, share, type Segment } from "@aiwb/core/logic/ctxsplit.ts";
import type { AgentKind, ContextCategory, ContextSplit, UsageLimit } from "@aiwb/core/types.ts";

/** Tokens in words, always with the one decimal the sheet draws: "72.8k", "200k", "3.1k", "950", "1.5M". */
export function tokensK(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** The big number and its words. With the split the number is the split's own total over its window (the legend beneath adds up to it), else
 *  the ring's. No window: the tokens alone, no share. */
export function bigNumber(used: number, win: number, s?: ContextSplit | null): { pct: string; words: string } {
  const total = s ? s.total : used, window = s ? s.window || s.total : win;
  if (!window) return { pct: tokensK(total), words: "tokens used" };
  return { pct: `${Math.round(Math.min(1, total / window) * 100)}%`, words: `used · ${tokensK(total)} of ${tokensK(window)} tokens` };
}

export type LegendRow = {
  id: string;
  label: string;
  tokens: number;
  /** "52.4k". */
  words: string;
  /** "26%", "<0.1%": the share of the window. */
  share: string;
  /** The bar's colour slot (ctxsplit.ts): 0 neutral. */
  slot: number;
  kind: ContextCategory["kind"];
  /** A tap opens what is under it: Claude's Messages parts, or a category's items (largest first, with their notes). */
  parts: LegendRow[];
  items: { name: string; note?: string; tokens: number; words: string }[];
};

const rowOf = (g: Segment, win: number): LegendRow => ({
  id: g.cat.id, label: g.cat.label, tokens: g.cat.tokens, words: tokensK(g.cat.tokens), share: share(g.cat.tokens, win), slot: g.slot, kind: g.cat.kind,
  parts: partSegments(g.cat.parts).map((p) => rowOf(p, win)),
  items: byTokens(g.cat.items).map((it) => ({ ...it, words: tokensK(it.tokens) })),
});

/** The legend: a row for each segment of the bar in its order, then free space, then (apart) what is listed but not loaded. */
export function legend(agent: AgentKind, s: ContextSplit): { used: LegendRow[]; free: LegendRow | null; deferred: LegendRow[]; win: number } {
  const win = s.window || s.total;
  const free = freeTokens(s.categories, win);
  return {
    win,
    used: segments(agent, s.categories).map((g) => rowOf(g, win)),
    free: free > 0 ? rowOf({ cat: { id: "free", label: "Free space", tokens: free, kind: "free" }, slot: 0 }, win) : null,
    deferred: deferred(s.categories).map((cat) => rowOf({ cat, slot: 0 }, win)),
  };
}

/** Whether a row has anything to open under it (a chevron only then). */
export const hasMore = (r: Pick<LegendRow, "parts" | "items">): boolean => r.parts.length > 0 || r.items.length > 0;

/** How the count was made, in what the answer carries (it has no time: goal 4.6 says not to make one up): the agent that counted and, when it
 *  knows it, the message it counted after. While it is asked again: "Counting…". */
export function countLine(agent: AgentKind, s: Pick<ContextSplit, "atMessage">, loading: boolean): string {
  if (loading) return "Counting again…";
  return `Counted by ${agentName(agent)}${s.atMessage > 0 ? ` after message ${s.atMessage}` : ""}.`;
}

/** A limit's tone on the phone: amber from 80 % (or when Claude says so), red from 95 %, else the accent. (The wide popup's `limitTone` warns
 *  above 50 % and is red above 80 %; the phone's design turns amber at 80 %.) */
export const AMBER_FROM = 80, RED_FROM = 95;
export function phoneTone(l: Pick<UsageLimit, "percent" | "severity">): "ok" | "warn" | "danger" {
  if (l.percent >= RED_FROM) return "danger";
  if (l.percent >= AMBER_FROM || (l.severity && l.severity !== "normal")) return "warn";
  return "ok";
}
