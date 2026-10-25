// The glyphs and tiles of the library's phone screens (package S4): the folder tile of a group's row (the accent square of the mockup),
// the outlined document tile of a prompt's row, the same two in the head of a P1 sheet, and the glyphs of the sheets' rows. Every glyph
// takes `color` (ActionSheet draws the destructive row's in red); the tiles take their colours from the theme's tokens.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { useTokens } from "../../../ui/theme.tsx";

export const ROW_TILE = 32;

type Glyph = { size?: number; color?: string };

function Draw({ size, color, children }: { size: number; color?: string; children: ReactNode }) {
  const t = useTokens();
  return <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color ?? t.text} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">{children}</Svg>;
}

/** A group: a box with a lid line, as the mockup's rectangle. */
export const FolderGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Rect x="1.8" y="4" width="12.4" height="8" rx="1.2" /></Draw>;
/** A prompt: a page with lines of text. */
export const DocGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Path d="M4.5 4.5h7M4.5 8h7M4.5 11.5h4" /></Draw>;
export const PencilGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Path d="M10.8 2.7l2.5 2.5-7.6 7.6-3.2.7.7-3.2zM9.4 4.1l2.5 2.5" /></Draw>;
export const MoveGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Path d="M2.5 8h9M8.5 4.5 12 8l-3.5 3.5M13.5 3v10" /></Draw>;
export const BinGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Path d="M3 4.5h10M6.3 4.5V2.8h3.4v1.7M4.3 4.5l.6 8.7h6.2l.6-8.7M6.8 7v4M9.2 7v4" /></Draw>;
export const PlusGlyph = ({ size = 16, color }: Glyph) => <Draw size={size} color={color}><Path d="M8 3v10M3 8h10" /></Draw>;

/** The tile of a group's row: the accent fill with the glyph in `onAccent`. Decoration: the row's name says what it is. */
export function FolderTile() {
  const t = useTokens();
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.tile, { backgroundColor: t.accentFill }]}>
      <FolderGlyph size={18} color={t.onAccent} />
    </View>
  );
}

/** The tile of a prompt's row: outlined, the glyph in the muted ink. */
export function PromptTile() {
  const t = useTokens();
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.tile, styles.outlined, { borderColor: t.muted }]}>
      <DocGlyph size={18} color={t.muted} />
    </View>
  );
}

/** What a P1 sheet's head draws inside its tile (ActionSheet gives the tile its accent border). */
export const FolderHeadIcon = () => <FolderGlyph size={20} color={useTokens().accent} />;
export const PromptHeadIcon = () => <DocGlyph size={20} color={useTokens().accent} />;

const styles = StyleSheet.create({
  tile: { width: ROW_TILE, height: ROW_TILE, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  outlined: { borderWidth: 1.2, backgroundColor: "transparent" },
});
