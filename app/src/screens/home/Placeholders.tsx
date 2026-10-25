// The rows Home draws while the selected server connects (plans/ux-improvements/h1-design.md §4.2): grey bars where rows will be.
// Screen readers hear one "Loading" and none of the bars.
import { StyleSheet, View } from "react-native";

import { PHONE } from "../../ui/metrics.ts";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { H1_TID } from "./ids.ts";

export function Placeholders({ rows = 5 }: { rows?: number }) {
  const t = useTokens();
  return (
    <View accessible accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <View key={i} {...tid(H1_TID.placeholder)} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={styles.row}>
          <View style={[styles.tile, { backgroundColor: t.line }]} />
          <View style={styles.bars}>
            <View style={[styles.bar, { width: "55%", backgroundColor: t.line }]} />
            <View style={[styles.bar, styles.short, { width: "32%", backgroundColor: t.line }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { height: PHONE.listRow, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: PHONE.margin },
  tile: { width: 36, height: 36, borderRadius: 8 },
  bars: { flex: 1, gap: 8 },
  bar: { height: 12, borderRadius: 4 },
  short: { height: 10 },
});
