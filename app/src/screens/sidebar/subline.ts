// The line under a chat's name in the sidebar when the chat is doing nothing: "model · effort", in the labels of the catalog of the chat's own
// server (the old page's Composer.tsx `subline`). No React and no react-native here, so Node loads it (test/sidebar.test.ts).
import { effortLabel } from "@aiwb/core/logic/labels.ts";
import type { Catalog, CatalogModel, ChatView } from "@aiwb/core/types.ts";

const modelOf = (c: Pick<ChatView, "model">, cat?: Catalog): CatalogModel | undefined => cat?.models.find((m) => m.id === c.model);

/** "model · effort". The model's own label when the catalog has the model, else its id; no effort part for a chat with none, or one whose
 *  model the catalog says has no efforts. */
export function subline(c: Pick<ChatView, "model" | "effort">, cat?: Catalog): string {
  const m = modelOf(c, cat);
  const withEffort = c.effort && (m ? !!m.efforts?.length : true);
  return `${m?.label ?? c.model}${withEffort ? " · " + effortLabel(c.effort, m) : ""}`;
}
