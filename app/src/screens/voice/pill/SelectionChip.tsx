// The selection chip over the pill (VC-28, goal 3.6): "n selected" while the board on screen has a selection, with the × that leaves it out of the
// spoken turn. What is sent is `selectionTag` (selection.ts) at the moment the turn goes.
import { Pressable, StyleSheet, View } from "react-native";
import { useSyncExternalStore } from "react";

import { useStore } from "../../../state/useStore.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useControlRef } from "../../../ui/useControlRef";
import { webStyle } from "../../../ui/webstyle.ts";
import { PILL_SELECTED, PILL_SELECTION_REMOVE, PILL_SELECTION_TIP } from "../../../voice/words.ts";
import { selectedOn } from "@aiwb/core/logic/roles.ts";
import { selectionKey } from "./logic.ts";
import { leaveSelectionOut, leftOut, subscribeLeft } from "./selection.ts";

/** How many selected elements go with the next turn: none when the person took them out, or this window cannot write to the board. */
export function useSelectedCount(board: string): number {
  const count = useStore((s) => selectedOn(s.selection.count, board, s.sel.board, s.roles[board]));
  const key = useStore((s) => selectionKey(s.selection));
  const out = useSyncExternalStore(subscribeLeft, leftOut, leftOut);
  return out === `${board}\n${key}` ? 0 : count;
}

export function SelectionChip({ board }: { board: string }) {
  const t = useTokens();
  const n = useSelectedCount(board);
  const tip = useControlRef(PILL_SELECTION_REMOVE);
  if (!n) return null;
  return (
    <View {...tid("pill-selection", { count: n })} accessibilityLabel={PILL_SELECTION_TIP(n)}
      style={[styles.chip, { backgroundColor: t.accentSoft, borderColor: t.accent }]}>
      <Text size={12} tone="accent" weight="600">{PILL_SELECTED(n)}</Text>
      <Pressable {...tid("pill-selection-remove")} ref={tip} accessibilityRole="button" accessibilityLabel={PILL_SELECTION_REMOVE} hitSlop={8}
        onPress={() => leaveSelectionOut(board)} style={[styles.x, webStyle({ cursor: "pointer" })]}>
        <Text size={14} tone="accent">×</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: "row", alignItems: "center", gap: 6, height: 26, marginBottom: 6, paddingLeft: 10, paddingRight: 6, borderRadius: 13, borderWidth: 1 },
  x: { width: 18, height: 18, alignItems: "center", justifyContent: "center" },
});
