// A server's tile (goals 3.8.2, 3.8.4; mockups dl-03a to dl-03d, dl-05b): a square with the server glyph in the accent when the server is
// well, a red or amber "!" when it is not, a red shield when its certificate changed, grey while it connects. The list's rows, the detail's
// status header and the sheet's head draw it. Package S2.
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { useTokens } from "../../ui/theme.tsx";
import type { Tokens } from "../../ui/tokens.ts";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";
import type { TileKind } from "./facts.ts";

/** The colour of a tile's border and glyph, and of its fill. */
function colours(t: Tokens, kind: TileKind): { ink: string; fill: string } {
  if (kind === "ok") return { ink: t.accent, fill: t.accentSoft };
  if (kind === "bad" || kind === "cert") return { ink: t.danger, fill: t.dangerSoft };
  if (kind === "warn") return { ink: t.warnText, fill: t.warnSoft };
  return { ink: t.muted, fill: t.panel };
}

/** Two stacked bars: the server. */
const ServerGlyph = ({ size, color }: { size: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
    <Rect x="2.5" y="2.5" width="11" height="4.5" rx="1" />
    <Rect x="2.5" y="9" width="11" height="4.5" rx="1" />
    <Path d="M5 4.75h.01M5 11.25h.01" strokeWidth={1.8} strokeLinecap="round" />
  </Svg>
);

/** A shield with a plus: the certificate. */
export const ShieldGlyph = ({ size, color }: { size: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round">
    <Path d="M8 1.8 13 3.6v4c0 3-2.1 5.1-5 6.6-2.9-1.5-5-3.6-5-6.6v-4z" />
    <Path d="M8 5.6v3.6M6.2 7.4h3.6" />
  </Svg>
);

/** `size` is the tile's width in points, and its height unless `height` is given: 48 in the status header, 36 in the sheet's head, 30 × 37 in the list's rows. */
export function ServerTile({ kind, size = 48, height = size }: { kind: TileKind; size?: number; height?: number }) {
  const t = useTokens(), { ink, fill } = colours(t, kind);
  const glyph = Math.round(size * 0.5);
  return (
    <View {...tid("srv-tile", { kind })} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden
      style={[styles.tile, { width: size, height, borderColor: ink, backgroundColor: fill, borderRadius: Math.round(size / 8) }]}>
      {kind === "bad" || kind === "warn" ? <Text size={Math.round(size * 0.46)} weight="700" style={{ color: ink, lineHeight: Math.round(size * 0.56) }}>!</Text>
        : kind === "cert" ? <ShieldGlyph size={glyph} color={ink} /> : <ServerGlyph size={glyph} color={ink} />}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});
