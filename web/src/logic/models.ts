// Provider grouping and search for the shared model picker, and the model and effort a branch or
// a fork starts on. DOM-free: used by Composer (the model menu) and tested directly under node:test.

import type { AgentKind, Catalog, CatalogModel, ChatView } from "../types.ts";
import { isBusy } from "./status.ts";

/** One provider section of the picker; provider "" is the provider-less group. */
export type ModelGroup = { provider: string; models: CatalogModel[] };

/** Groups models by provider for the picker: one group per provider id in first-appearance
 *  order; the provider-less group ("") is always first; within a group the input order is kept. */
export function groupModels(models: CatalogModel[]): ModelGroup[] {
  const byProvider = new Map<string, CatalogModel[]>();
  for (const m of models) {
    const provider = m.provider ?? "";
    const group = byProvider.get(provider);
    if (group) group.push(m);
    else byProvider.set(provider, [m]);
  }
  const out: ModelGroup[] = [];
  for (const [provider, group] of byProvider) {
    if (provider === "") out.unshift({ provider, models: group });
    else out.push({ provider, models: group });
  }
  return out;
}

/** The lowercased haystacks; a model matches when one of them holds every term. A model with a
 *  provider is searched by exactly "provider - label" (the user-facing name): its id repeats the
 *  provider/model key, so including the id would let a later term re-match inside it and break
 *  strictly left-to-right matching (e.g. "deep open" would find openrouter's DeepSeek V3 again).
 *  A provider-less model is searched by "label - note" (an absent note leaves no gap) or by its id
 *  alone, never across the two: its id repeats the label's words in the same way. */
const searchTexts = (m: CatalogModel): string[] =>
  m.provider
    ? [`${m.provider} - ${m.label}`.toLowerCase()]
    : [[m.label, m.note].filter((s): s is string => !!s).join(" - ").toLowerCase(), m.id.toLowerCase()];

/** True when every whitespace-separated query term appears in one of the model's search texts in
 *  order and without overlap; an empty or whitespace-only query matches everything.
 *  Case-insensitive because both sides are lowercased. */
export function modelMatches(m: CatalogModel, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t);
  return searchTexts(m).some((text) => {
    let cursor = 0;
    for (const term of terms) {
      const at = text.indexOf(term, cursor);
      if (at < 0) return false;
      cursor = at + term.length;
    }
    return true;
  });
}

/** The models matching the query, in catalog order. Empty/whitespace-only query keeps everything. */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  return models.filter((m) => modelMatches(m, query));
}

// ---- the model and effort of a new branch or a fork: open until its first own message.

/** A model and the effort it runs at; an absent and an empty effort are the same. */
export type Choice = { model: string; effort?: string };

/** What pi keeps free of a model's context window; mirrors the server's guard. */
export const PI_RESERVE = 16384;

/** Where the toolbar's model and effort controls write: the pending move, the server (PATCH), or nowhere (fixed). */
export function pickerMode(c: Pick<ChatView, "locked" | "fresh" | "status">, move: boolean): "move" | "patch" | "fixed" {
  if (move) return "move";
  return !c.locked || (!!c.fresh && !isBusy(c.status)) ? "patch" : "fixed";
}

/** The choice a pending move shows: its own once one was made, else the source branch's. */
export function moveChoice(move: { model?: string; effort?: string } | undefined, source: Choice): Choice {
  return move?.model ? { model: move.model, effort: move.effort } : source;
}

/** The choice after picking a model, as the server resolves it: the effort is kept when the new
 *  model offers it, else it is the model's default when it has efforts, else none. Without a
 *  catalog or with an id it does not hold, the effort is kept. */
export function withModel(cur: Choice, id: string, cat?: Catalog): Choice {
  const m = cat?.models.find((x) => x.id === id);
  if (!m) return { model: id, effort: cur.effort };
  if (cur.effort && m.efforts?.includes(cur.effort)) return { model: id, effort: cur.effort };
  return { model: id, effort: m.efforts?.length ? m.defaultEffort : undefined };
}

export function withEffort(cur: Choice, effort: string): Choice {
  return { model: cur.model, effort };
}

export function sameChoice(a: Choice, b: Choice): boolean {
  return a.model === b.model && (a.effort || "") === (b.effort || "");
}

/** The server refuses this model for a conversation of this size (pi only); false when a size is
 *  not known. */
export function tooSmall(agent: AgentKind, ctxIn: number | undefined, m: CatalogModel | undefined): boolean {
  return agent === "pi" && ctxIn !== undefined && m?.contextWindow !== undefined && ctxIn > m.contextWindow - PI_RESERVE;
}

/** What the composer tells about a choice of another model than the parent's, for a point with
 *  `at` items before it: that the model cannot take the conversation (warn), else that the history
 *  is read again. Null with no parent, nothing before the point, or the parent's model. */
export function modelNotice(o: { agent: AgentKind; choice: Choice; parent: Choice | undefined; at: number; ctxIn?: number; cat?: Catalog }): { text: string; warn: boolean } | null {
  if (!o.parent || o.at === 0 || o.choice.model === o.parent.model) return null;
  const row = (id: string) => o.cat?.models.find((x) => x.id === id);
  const m = row(o.choice.model);
  if (tooSmall(o.agent, o.ctxIn, m)) return { text: `${m?.label ?? o.choice.model} has too small a context window for this conversation. Pick a larger model.`, warn: true };
  return { text: `Another model than the conversation so far (${row(o.parent.model)?.label ?? o.parent.model}): the history is read again once, at full price.`, warn: false };
}
