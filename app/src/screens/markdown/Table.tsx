// A GFM table (AD-75), in a box that scrolls sideways on its own. React Native has no table layout: the columns get a width
// from the longest text in them (within bounds), and the cells of a row stretch to the tallest, so a long cell wraps and the
// rows stay level.
import { ScrollView, Text as RNText, View } from "react-native";

import { useTokens } from "../../ui/theme.tsx";
import { alpha } from "./look.ts";
import { useLook } from "./look.tsx";
import type { Block, Cell, Inline } from "./doc.ts";
import { Inlines } from "./Inline.tsx";

const textLength = (kids: Inline[]): number =>
  kids.reduce((n, k) => n + (k.k === "text" || k.k === "code" ? k.v.length : k.k === "chip" ? k.ref.label.length + 3 : k.k === "mention" ? k.raw.length : k.k === "br" || k.k === "check" ? 1 : textLength(k.kids)), 0);

/** A column's width in points: its longest cell's characters at the table's size, with the cell's padding, between 56 and 320. */
export const columnWidth = (cells: Cell[], size: number): number =>
  Math.min(320, Math.max(56, Math.ceil(Math.max(0, ...cells.map((c) => textLength(c.kids))) * size * 0.54 + 20)));

export function TableBlock({ block, mt }: { block: Extract<Block, { k: "table" }>; mt: number }) {
  const t = useTokens();
  const look = useLook();
  const size = (look.size * 12.5) / 13;
  const columns = block.align.length || block.head.length;
  const widths = Array.from({ length: columns }, (_, i) => columnWidth([block.head[i], ...block.rows.map((r) => r[i])].filter(Boolean), size));
  const row = (cells: Cell[], head: boolean, striped: boolean, key: number) => (
    <View key={key} testID="md-row" style={{ flexDirection: "row", alignItems: "stretch" }}>
      {cells.map((c, i) => (
        <View key={i} testID={head ? "md-th" : "md-td"}
          style={{ width: widths[i], paddingVertical: 4, paddingHorizontal: 9, borderRightWidth: 1, borderBottomWidth: 1, borderColor: t.line2, backgroundColor: head ? t.panel : striped ? alpha(t.panel, 0.6) : undefined }}>
          <RNText style={{ color: look.color, fontSize: size, lineHeight: size * 1.45, fontWeight: head ? "600" : undefined, textAlign: (block.align[i] as "left" | "center" | "right" | null) ?? "left" }}>
            <Inlines kids={c.kids} />
          </RNText>
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView testID="md-table" horizontal style={{ marginTop: mt }} contentContainerStyle={{ borderTopWidth: 1, borderLeftWidth: 1, borderColor: t.line2 }}>
      <View>
        {block.head.length ? row(block.head, true, false, -1) : null}
        {block.rows.map((r, i) => row(r, false, i % 2 === 1, i))}
      </View>
    </ScrollView>
  );
}
