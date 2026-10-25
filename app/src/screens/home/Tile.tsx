// The square tile of the first run's and the empty Home's picture (mockup sh-08a, sh-08b): a glyph in a tinted, bordered square.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { useTokens } from "../../ui/theme.tsx";

export type TileTone = "accent" | "claude" | "plain";

export function Tile({ tone, children }: { tone: TileTone; children: ReactNode }) {
  const t = useTokens();
  const fill = tone === "accent" ? t.accentSoft : tone === "claude" ? t.claudeSoft : t.panel;
  const border = tone === "accent" ? t.accent : tone === "claude" ? t.claude : t.line2;
  // (a picture: screen readers skip it)
  return <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.tile, { backgroundColor: fill, borderColor: border }]}>{children}</View>;
}

/** A server drawn as two stacked bars (the third tile of the first run). */
export function ServerGlyph({ color }: { color: string }) {
  return (
    <View style={styles.stack}>
      <View style={[styles.bar, { borderColor: color }]} />
      <View style={[styles.bar, { borderColor: color }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { width: 60, height: 56, borderWidth: 1.5, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  stack: { gap: 4 },
  bar: { width: 28, height: 11, borderWidth: 1.5, borderRadius: 2 },
});
