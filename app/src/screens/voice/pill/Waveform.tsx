// The live waveform of the listening bar (VC-28): the last moments of the microphone's level as bars, the newest on the right. A muted or
// silent microphone draws a low line. `level` is the session's (RMS 0..1); the bars are the history of it that this component keeps.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { barHeights } from "./logic.ts";

const BARS = 20;
const HEIGHT = 28;

export function Waveform({ level }: { level: number }) {
  const t = useTokens();
  const [seen, setSeen] = useState<number[]>([]);
  useEffect(() => { setSeen((l) => [...l, level].slice(-BARS)); }, [level]);
  const bars = barHeights(seen, BARS);
  const peak = Math.round(Math.max(0, ...seen.slice(-BARS)) * 100);
  return (
    <View {...tid("pill-wave", { peak })} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.wave}>
      {bars.map((h, i) => <View key={i} style={[styles.bar, { height: Math.max(3, Math.round(h * HEIGHT)), backgroundColor: t.accent, opacity: 0.35 + 0.65 * (i / BARS) }]} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2, height: HEIGHT, width: BARS * 5 - 2, flexShrink: 0 },
  bar: { width: 3, borderRadius: 2 },
});
