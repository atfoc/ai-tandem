// The three dots after a status line ("Thinking…") and the blinking caret of an answer that has no text yet.
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import { useTokens } from "../../ui/theme.tsx";
import { webStyle } from "../../ui/webstyle.ts";

function useTick(ms: number): number {
  const [n, setN] = useState(0);
  useEffect(() => { const id = setInterval(() => setN((x) => x + 1), ms); return () => clearInterval(id); }, [ms]);
  return n;
}

/** `.dots`: three 4 px dots, each bright in turn. */
export function Dots({ color }: { color?: string }) {
  const t = useTokens(), tick = useTick(180);
  return (
    <View testID="dots" style={styles.dots}>
      {[0, 1, 2].map((i) => <View key={i} style={[styles.dot, { backgroundColor: color ?? t.muted, opacity: tick % 6 === i * 2 ? 1 : 0.4 }]} />)}
    </View>
  );
}

/** `.caret-blink`: a 7 × 14 bar of the text colour, on and half off. */
export function Caret() {
  const t = useTokens(), tick = useTick(450);
  return <View testID="caret" style={[{ width: 7, height: 14, marginLeft: 2, backgroundColor: t.text, opacity: tick % 2 ? 0.55 : 1 }, webStyle({ display: "inline-flex" })]} />;
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", gap: 3, alignItems: "center" },
  dot: { width: 4, height: 4, borderRadius: 2 },
});
