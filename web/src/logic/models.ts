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

const has = (s: string | undefined, q: string) => (s ?? "").toLowerCase().includes(q);

/** True when the trimmed, case-insensitive query is empty, or is a substring of the model's
 *  label, id, provider or note. An empty provider never matches a non-empty query. */
export function modelMatches(m: CatalogModel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return has(m.label, q) || has(m.id, q) || has(m.provider, q) || has(m.note, q);
}

/** The models matching the query, in catalog order. Empty/whitespace-only query keeps everything. */
export function filterModels(models: CatalogModel[], query: string): CatalogModel[] {
  return models.filter((m) => modelMatches(m, query));
}
