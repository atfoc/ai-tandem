// The kit gallery's section "SwipeRow and haptics" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// Three 60 pt rows from the screen's left edge (the content has the 16 pt margin, the row none: the 20 pt edge rule is checked on
// row c). a and b: Archive (grey, full) and Delete on a left swipe; c: Unarchive (accent, full) on a right swipe. The front is the
// pattern every row of the app uses: a Pressable whose tap opens the row and whose long press (500 ms) answers with a haptic and
// opens its menu. `kit-swipe-last` says what happened last.
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { haptic } from "../../platform/haptics";
import { Text } from "../../ui/Text.tsx";
import { LONG_PRESS_MS, PHONE } from "../../ui/metrics.ts";
import { SwipeRow, type SwipeAction } from "../../ui/SwipeRow.tsx";
import { useTokens } from "../../ui/theme.tsx";

type Name = "a" | "b" | "c";

export function Section() {
  const t = useTokens();
  const [last, setLast] = useState("none");
  const archive = (n: Name): SwipeAction => ({ id: "archive", label: "Archive", tone: "grey", full: true, onPress: () => setLast(`archive ${n}`) });
  const del = (n: Name): SwipeAction => ({ id: "delete", label: "Delete", tone: "danger", onPress: () => setLast(`delete ${n}`) });
  const unarchive = (n: Name): SwipeAction => ({ id: "unarchive", label: "Unarchive", tone: "accent", full: true, onPress: () => setLast(`unarchive ${n}`) });
  const rows: { n: Name; name: string; sub: string; right?: SwipeAction[]; left?: SwipeAction[] }[] = [
    { n: "a", name: "Roadmap", sub: "Swipe left: Archive, Delete", right: [archive("a"), del("a")] },
    { n: "b", name: "Meeting notes", sub: "Swipe left: Archive, Delete", right: [archive("b"), del("b")] },
    { n: "c", name: "Old sketch", sub: "Swipe right: Unarchive", left: [unarchive("c")] },
  ];
  return (
    <View style={styles.list}>
      <Text testID="kit-swipe-last" tone="muted" style={styles.last}>{last}</Text>
      {rows.map((r) => (
        <SwipeRow key={r.n} data={{ row: r.n }} right={r.right} left={r.left}>
          <Pressable accessibilityLabel={r.name} delayLongPress={LONG_PRESS_MS} onPress={() => setLast(`tap ${r.n}`)}
            onLongPress={() => { haptic("select"); setLast(`long ${r.n}`); }}
            style={[styles.front, { borderColor: t.line }]}>
            <Text size={17}>{r.name}</Text>
            <Text size={13} tone="muted">{r.sub}</Text>
          </Pressable>
        </SwipeRow>
      ))}
    </View>
  );
}

// The page of the gallery has a 16 pt padding; the list leaves it, so that its rows start at x = 0.
const styles = StyleSheet.create({
  list: { marginHorizontal: -16 },
  last: { marginHorizontal: 16, marginBottom: 4 },
  front: { height: PHONE.listRow, justifyContent: "center", paddingHorizontal: PHONE.margin, borderBottomWidth: StyleSheet.hairlineWidth },
});
