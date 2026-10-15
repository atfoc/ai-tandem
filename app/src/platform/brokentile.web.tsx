// The tile for a picture that cannot be had, on web. The name is drawn by CSS from `data-text`, not as a text node: in a sent message
// the tile is inside the message's element, whose text nodes the quotes read (quoteDom, K5) to tell which messages a selection takes
// text from (B-IM-02). The name is also the tile's accessible name.
import { StyleSheet, View, type ImageStyle, type StyleProp } from "react-native";

import { SANS } from "../ui/fonts.ts";
import { useTheme } from "../ui/theme.tsx";
import { TID } from "../ui/tid.ts";

const STYLES = `
.aiwb-tile-name { display: block; width: 100%; }
.aiwb-tile-name::before { content: attr(data-text); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: var(--aiwb-lines, 4); overflow: hidden; font-size: 11px; line-height: 1.25; text-align: center; overflow-wrap: anywhere; }
`;
function ensureStyles() {
  if (document.querySelector("style[data-aiwb-tile]")) return;
  const s = document.createElement("style");
  s.dataset.aiwbTile = "";
  s.textContent = STYLES;
  document.head.append(s);
}

export function BrokenPicture({ name, style, lines = 4 }: { name?: string; style?: StyleProp<ImageStyle>; lines?: number }) {
  const { tokens: t } = useTheme();
  ensureStyles();
  return (
    <View testID={TID.picture} dataSet={{ state: "broken" }} role="img" aria-label={name || "Image"}
      style={[styles.tile, { borderColor: t.line2, backgroundColor: t.bg }, style as never]}>
      <span className="aiwb-tile-name" data-text={name ?? ""} style={{ color: t.muted, fontFamily: SANS, ["--aiwb-lines" as string]: lines }} />
    </View>
  );
}

const styles = StyleSheet.create({
  tile: { borderWidth: 1, borderStyle: "dashed", borderRadius: 6, padding: 4, alignItems: "center", justifyContent: "center", overflow: "hidden", minWidth: 40, minHeight: 40 },
});
