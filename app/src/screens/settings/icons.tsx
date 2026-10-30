// The tile at the left of a Settings row (the mockup's 29 × 29 coloured square, radius 7) and the glyphs the shared icons do not have:
// servers, library, archive, info. The glyph is drawn in `onAccent`, the tile in a token of the theme, so a row is right in light, dark
// and every Catppuccin flavour.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { useTokens } from "../../ui/theme.tsx";
import type { TokenName } from "../../ui/tokens.ts";

export const TILE = 29;

/** A coloured square with a glyph; it is decoration (the row's label says what it is). */
export function Tile({ colour, children }: { colour: TokenName; children: (ink: string) => ReactNode }) {
  const t = useTokens();
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.tile, { backgroundColor: t[colour] }]}>
      {children(t.onAccent)}
    </View>
  );
}

type Glyph = { size?: number; color: string };

const draw = (size: number, color: string, children: ReactNode) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">{children}</Svg>
);

/** Two stacked machines: Servers. */
export const ServersGlyph = ({ size = 17, color }: Glyph) => draw(size, color, <>
  <Rect x="2" y="2.5" width="12" height="4.5" rx="1.2" /><Rect x="2" y="9" width="12" height="4.5" rx="1.2" /><Path d="M4.7 4.75h.01M4.7 11.25h.01" strokeWidth={1.8} />
</>);

/** An open book: Prompt library. */
export const LibraryGlyph = ({ size = 17, color }: Glyph) => draw(size, color, <Path d="M8 3.5C6.6 2.6 4.6 2.3 2 2.5v9.5c2.6-.2 4.6.1 6 1M8 3.5c1.4-.9 3.4-1.2 6-1v9.5c-2.6-.2-4.6.1-6 1M8 3.5V13" />);

/** A box with a lid: Archived. */
export const ArchiveGlyph = ({ size = 17, color }: Glyph) => draw(size, color, <>
  <Rect x="1.8" y="2.5" width="12.4" height="3.2" rx="1" /><Path d="M3 5.7v6.3a1.4 1.4 0 0 0 1.4 1.4h7.2A1.4 1.4 0 0 0 13 12V5.7M6.3 8.5h3.4" />
</>);

/** Lines, the middle two pushed in: Composer's editing. */
export const IndentGlyph = ({ size = 17, color }: Glyph) => draw(size, color, <Path d="M2.5 3.5h11M6 6.5h7.5M6 9.5h7.5M2.5 12.5h11M2.5 6.5l2 1.5-2 1.5" />);

/** A circled i: About. */
export const InfoGlyph = ({ size = 17, color }: Glyph) => draw(size, color, <>
  <Path d="M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z" /><Path d="M8 7.2V11" /><Path d="M8 4.9h.01" strokeWidth={1.8} />
</>);

const styles = StyleSheet.create({
  tile: { width: TILE, height: TILE, borderRadius: 7, alignItems: "center", justifyContent: "center" },
});
