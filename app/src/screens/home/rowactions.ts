// What a row of Home or a group's screen does besides opening: the swipe buttons, the long press and the sheet the "…" opens
// (ux-improvements goal 3.3, h2-design.md §3). A left swipe shows Archive (grey; a full swipe runs it) and Delete (red; it must be tapped
// and is confirmed); a long press, and the group screen's "…", open the row's action sheet (RowSheet.tsx).
import { useMemo } from "react";

import type { SwipeAction } from "../../ui/SwipeRow.tsx";
import { archiveItem } from "./archive.ts";
import { askDelete } from "./deletes.ts";
import type { RowKind } from "./model.ts";
import { openRowSheet } from "./RowSheet.tsx";

export type RowActions = {
  /** The buttons a left swipe shows (the row is wrapped in a SwipeRow only when there are some). */
  swipe?: SwipeAction[];
  onLongPress?(): void;
  /** Opens the row's action sheet: the group screen's "…" calls it. */
  openSheet?(): void;
};

export function useRowActions(item: { kind: RowKind; key: string }): RowActions {
  const { kind, key } = item;
  return useMemo(() => {
    if (!key) return {};
    const ref = { kind, key };
    const open = () => openRowSheet(ref);
    return {
      swipe: [
        { id: "archive", label: "Archive", tone: "grey", full: true, onPress: () => archiveItem(ref) },
        { id: "delete", label: "Delete", tone: "danger", onPress: () => askDelete(ref) },
      ],
      onLongPress: open,
      openSheet: open,
    };
  }, [kind, key]);
}
