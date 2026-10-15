// What the composer says of a chat's model and effort (the old page's Composer.tsx: modelOf, modelLabel, subline), from the catalog. No React and
// no react-native here, so Node loads it.
import { effortLabel } from "@aiwb/core/logic/labels.ts";
import type { Catalog, CatalogModel, ChatView } from "@aiwb/core/types.ts";

export { effortLabel };

export const modelOf = (c: Pick<ChatView, "model">, cat?: Catalog): CatalogModel | undefined => cat?.models.find((m) => m.id === c.model);
export const modelLabel = (c: Pick<ChatView, "model">, cat?: Catalog): string => modelOf(c, cat)?.label ?? c.model;

/** "model · effort", from the catalog's labels. */
export function subline(c: Pick<ChatView, "model" | "effort">, cat?: Catalog): string {
  const m = modelOf(c, cat);
  const withEffort = c.effort && (m ? !!m.efforts?.length : true);
  return `${modelLabel(c, cat)}${withEffort ? " · " + effortLabel(c.effort, m) : ""}`;
}
