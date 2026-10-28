// What the phone's Model and effort sheet lists (ux-improvements goal 3.6, mockup co-03a, co-03e): the model's note and its context size as the
// row's second line, and the provider headings of a catalog that names more than one (pi). The wide picker's order is kept: the provider-less
// models first, then the providers in the order they appear (core's groupModels). The model and effort menu (ModelEffortMenu.tsx) lists the same
// way under its search: `menuSections`. No React and no react-native here, so Node loads it
// (app/test/c2-modelrows.test.ts).
import { filterModels, groupModels } from "@aiwb/core/logic/models.ts";
import type { CatalogModel } from "@aiwb/core/types.ts";

/** "200k context", "1M context"; "" when the window is not known. */
export function contextLine(win: number | undefined): string {
  if (!win || win <= 0) return "";
  if (win >= 1_000_000) return `${+(win / 1_000_000).toFixed(1)}M context`;
  if (win >= 1000) return `${Math.round(win / 1000)}k context`;
  return `${win} context`;
}

/** The row's second line: the note and the context size joined with " · ", whichever of them there is ("" for neither). */
export function modelNote(m: Pick<CatalogModel, "note" | "contextWindow">): string {
  return [m.note, contextLine(m.contextWindow)].filter((s): s is string => !!s).join(" · ");
}

export type ModelRow = { value: string; label: string; note?: string; section?: string };

/** The rows of the sheet, in the wide picker's order. A heading (the provider) only when the models name more than one distinct provider. */
export function modelRows(models: CatalogModel[]): ModelRow[] {
  const groups = groupModels(models);
  const sections = groups.length > 1;
  return groups.flatMap((g) => g.models.map((m): ModelRow => ({
    value: m.id, label: m.label, note: modelNote(m) || undefined, section: sections ? g.provider || undefined : undefined,
  })));
}

/** One run of the model and effort menu's list: the provider's heading ("" for none) and its models. */
export type MenuSection = { provider: string; models: CatalogModel[] };

/** The model and effort menu's list for a query, in core's listedModels order: the matching models in runs of one provider. A run is headed
 *  only when the whole catalog names more than one provider (as modelRows), so a search does not make the headings come and go. */
export function menuSections(models: CatalogModel[], query: string): MenuSection[] {
  const headed = groupModels(models).length > 1;
  return groupModels(filterModels(models, query)).map((g) => ({ provider: headed ? g.provider : "", models: g.models }));
}
