// What the context ring says (the old page's Composer.tsx, "context usage"): the tokens used and the window, their text, the title and the tone,
// and the keeping of the popup's last answers. No React and no react-native here, so Node loads it (app/test/usage.test.ts).
import type { Catalog, ChatView, ContextSplit, PlanUsage } from "@aiwb/core/types.ts";

/** Tokens as "950", "4.2k", "42k", "1.5M" (one decimal below 10k and 10M, none above). */
export const fmtK = (n: number): string =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);

export type Context = { used: number; win: number; error?: string };

/** What a chat's context meter shows: the tokens used and the model's window (the usage's, else the catalog's), or why they are not
 *  known. cat: the catalog of the chat's agent on its server. */
export function contextOf(c: Pick<ChatView, "usage" | "model">, cat?: Catalog): Context {
  const u = c.usage ?? { ctxIn: 0, ctxOut: 0, ctxWindow: 0, turns: 0 };
  const model = cat?.models.find((m) => m.id === c.model);
  return { used: (u.ctxIn ?? 0) + (u.ctxOut ?? 0), win: u.ctxWindow || model?.contextWindow || 0, error: u.ctxError || undefined };
}

/** "Context: 42,900 of 200,000 tokens (21.5%)": the ring's title and the popup's first line. */
export const ctxTitle = (used: number, win: number): string =>
  `Context: ${used.toLocaleString("en-US")}${win ? ` of ${win.toLocaleString("en-US")}` : ""} tokens${win ? ` (${(Math.min(1, used / win) * 100).toFixed(1)}%)` : ""}`;

/** The share of the window the ring's text ends with: one decimal below 10%. */
export const ctxShare = (used: number, win: number): string => {
  const pct = Math.min(1, used / win);
  return `${pct < 0.1 ? (pct * 100).toFixed(1) : Math.round(pct * 100)}%`;
};

/** What the ring says beside it, as one text: "used / window share", the tokens used alone with no window, nothing before the first reply. */
export const ctxText = (used: number, win: number): string => (used ? `${fmtK(used)}${win ? ` / ${fmtK(win)} ${ctxShare(used, win)}` : ""}` : "");

export type RingTone = "ok" | "warn" | "danger";

/** The fraction of the window used (0 with no window) and the tone: warning above 50%, danger above 80%. */
export function ringOf(used: number, win: number): { pct: number; tone: RingTone } {
  const pct = win ? Math.min(1, used / win) : 0;
  return { pct, tone: pct > 0.8 ? "danger" : pct > 0.5 ? "warn" : "ok" };
}

/** The popup's lines for the context: the ring's numbers and what the context holds, or, before the first reply, the window and when
 *  usage shows. */
export function contextLines({ used, win }: Pick<Context, "used" | "win">): string[] {
  return used
    ? [ctxTitle(used, win), "System prompt, tools, board reads and the conversation so far."]
    : [`${win ? `Context window: ${win.toLocaleString("en-US")} tokens. ` : ""}Usage shows after the first reply.`];
}

/** What the popup keeps while the app is open so that it opens with numbers: each agent's last plan answer by server (`usageKey`), each
 *  branch's last context split by its key. */
export const lastUsage: Record<string, PlanUsage> = {};
export const lastSplit: Record<string, ContextSplit> = {};
