// Provider grouping and search for the shared model picker. DOM-free: used by
// Composer (the model menu) and tested directly under node:test.

import type { CatalogModel } from "../types.ts";

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
