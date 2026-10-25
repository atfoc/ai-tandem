// A GFM table (AD-75), in a box that scrolls sideways on its own. React Native has no table layout: the columns get a width
// from the longest text in them (within bounds), and the cells of a row stretch to the tallest, so a long cell wraps and the
// rows stay level.
import { useContext, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, Text as RNText, useWindowDimensions, View, type ViewStyle } from "react-native";

import { PHONE, TYPE } from "../../ui/metrics.ts";
import { useTokens } from "../../ui/theme.tsx";
import { webStyle } from "../../ui/webstyle.ts";
import { pushScreen } from "../shell/screens.ts";
import { T1_TID } from "../chat/ids.ts";
import { WhereContext } from "./env.tsx";
import { alpha } from "./look.ts";
import { useLook } from "./look.tsx";
import type { Block, Cell, Inline } from "./doc.ts";
import { Inlines } from "./Inline.tsx";

const textLength = (kids: Inline[]): number =>
  kids.reduce((n, k) => n + (k.k === "text" || k.k === "code" ? k.v.length : k.k === "chip" ? k.ref.label.length + 3 : k.k === "mention" ? k.raw.length : k.k === "br" || k.k === "check" ? 1 : textLength(k.kids)), 0);

/** The width of a column's longest cell's text in points at `size`, without padding (about half the size for a character). */
export const textWidth = (cells: Cell[], size: number): number => Math.max(0, ...cells.map((c) => textLength(c.kids))) * size * 0.54;

/** A column's width in points: its longest cell's text at the table's size, with the cell's padding, between 56 and 320. */
export const columnWidth = (cells: Cell[], size: number): number => Math.min(320, Math.max(56, Math.ceil(textWidth(cells, size) + 20)));

type TableOf = Extract<Block, { k: "table" }>;

export function TableBlock({ block, mt }: { block: TableOf; mt: number }) {
  return useLook().phone ? <PhoneTable block={block} mt={mt} /> : <WideTable block={block} mt={mt} />;
}

function WideTable({ block, mt }: { block: TableOf; mt: number }) {
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

// The phone's table in a chat's thread (goal 3.5): it bleeds to the screen's edges, its first column is pinned outside the box that
// scrolls sideways (a rule at its right), a fade says more lies to the right, and under it a hint and "Open full table" (the viewer,
// screens/markdown/TableScreen.tsx). The rows of the two parts are level: each reports its height and both take the larger.
const BODY = 15;
const ROW = 36;
const FADE = 40;

/** The first column of a pinned table is at most this wide, so that a long first cell leaves room for the others. */
const PIN_MAX = 170;

/** The columns, right of the first, whose right edge is outside the box (the box `view` wide, scrolled `x`). */
export const hiddenColumns = (widths: number[], x: number, view: number): number => {
  let edge = 0, n = 0;
  for (const w of widths) { edge += w; if (edge > x + view + 1) n++; }
  return n;
};

/** A background that goes from the page's colour, transparent, to the page's colour (Bars.tsx draws its fade the same way). */
export function fadeStyle(bg: string): ViewStyle {
  const clear = /^#[0-9a-f]{6}$/i.test(bg) ? `${bg}00` : "transparent";
  const gradient = `linear-gradient(to right, ${clear}, ${bg})`;
  return Platform.OS === "web" ? webStyle({ backgroundImage: gradient })! : ({ experimental_backgroundImage: gradient } as ViewStyle);
}

function PhoneTable({ block, mt }: { block: TableOf; mt: number }) {
  const t = useTokens();
  const look = useLook();
  const where = useContext(WhereContext);
  const columns = block.align.length || block.head.length;
  // (a cell has 24 points of padding here, and a semibold header is a little wider than its characters count for)
  const widths = Array.from({ length: columns }, (_, i) => Math.min(320, Math.max(64, Math.ceil(textWidth([block.head[i], ...block.rows.map((r) => r[i])].filter(Boolean), BODY) * 1.1 + 28))));
  // How far the table reaches past the thread's text to the screen's edges: the thread's margin, as measured once the table is laid out
  // (the row that holds it may keep a little more or less than the margin, and the table does not guess).
  const { width: screen } = useWindowDimensions();
  const outer = useRef<View>(null);
  const [bleed, setBleed] = useState<{ left: number; right: number }>({ left: PHONE.margin, right: PHONE.margin });
  const reach = () => outer.current?.measureInWindow((x, _y, w) => setBleed((b) => {
    const left = Math.min(48, Math.max(0, b.left + Math.round(x * 2) / 2)), right = Math.min(48, Math.max(0, b.right + Math.round((screen - x - w) * 2) / 2));
    return left === b.left && right === b.right ? b : { left, right };
  }));
  const pinWidth = Math.min(PIN_MAX, widths[0] ?? 0) + bleed.left;
  const rest = widths.slice(1);
  const rows: { cells: Cell[]; head: boolean }[] = [...(block.head.length ? [{ cells: block.head, head: true }] : []), ...block.rows.map((cells) => ({ cells, head: false }))];
  // the heights each part of a row has on its own; the row is as high as the larger
  const [heights, setHeights] = useState<{ pin: number[]; side: number[] }>({ pin: [], side: [] });
  const report = (part: "pin" | "side", i: number, h: number) =>
    setHeights((p) => (p[part][i] === h ? p : { ...p, [part]: Object.assign([...p[part]], { [i]: h }) }));
  const high = (i: number) => Math.max(ROW, heights.pin[i] ?? 0, heights.side[i] ?? 0);
  // what the sideways box shows: its width and how far it is scrolled
  const [box, setBox] = useState(0);
  const [x, setX] = useState(0);
  const total = rest.reduce((a, b) => a + b, 0);
  const hidden = box ? hiddenColumns(rest, x, box) : 0;
  const more = box > 0 && x + box < total - 1;

  const cell = (c: Cell | undefined, i: number, head: boolean, key: string, width: number | undefined, first = false) => (
    <View key={key} testID={head ? "md-th" : "md-td"}
      style={{ width, justifyContent: "center", paddingVertical: 6, paddingLeft: first ? bleed.left : 12, paddingRight: 12, backgroundColor: head ? t.panel : undefined }}>
      <RNText numberOfLines={undefined}
        style={{ color: head ? t.muted : look.color, fontSize: head ? TYPE.secondary : BODY, lineHeight: (head ? TYPE.secondary : BODY) * 1.4, fontWeight: head ? "600" : undefined, textAlign: (block.align[i] as "left" | "center" | "right" | null) ?? "left" }}>
        {c ? <Inlines kids={c.kids} /> : null}
      </RNText>
    </View>
  );
  const line = (i: number) => ({ minHeight: high(i), borderBottomWidth: 1, borderColor: t.line2, flexDirection: "row" as const });
  return (
    <View ref={outer} testID="md-table" onLayout={reach} style={{ marginTop: mt, marginLeft: -bleed.left, marginRight: -bleed.right }}>
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderColor: t.line2 }}>
        <View testID={T1_TID.tablePin} style={{ width: pinWidth, borderRightWidth: 1, borderColor: t.line2 }}>
          {rows.map((r, i) => (
            <View key={i} testID="md-row" onLayout={(e) => report("pin", i, e.nativeEvent.layout.height)} style={line(i)}>
              {cell(r.cells[0], 0, r.head, "0", pinWidth - 1, true)}
            </View>
          ))}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <ScrollView horizontal testID="md-table-scroll" showsHorizontalScrollIndicator={false} scrollEventThrottle={16}
            onLayout={(e) => setBox(e.nativeEvent.layout.width)} onScroll={(e) => setX(e.nativeEvent.contentOffset.x)}>
            <View>
              {rows.map((r, i) => (
                <View key={i} testID="md-row" onLayout={(e) => report("side", i, e.nativeEvent.layout.height)} style={[line(i), { alignItems: "stretch" }]}>
                  {rest.map((w, j) => cell(r.cells[j + 1], j + 1, r.head, String(j), w))}
                </View>
              ))}
            </View>
          </ScrollView>
          {more ? <View pointerEvents="none" testID="md-table-fade" style={[{ position: "absolute", top: 0, right: 0, bottom: 0, width: FADE }, fadeStyle(t.bg)]} /> : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingLeft: bleed.left, paddingRight: bleed.right, minHeight: PHONE.target }}>
        {hidden ? (
          <RNText testID={T1_TID.tableHint} style={{ color: t.muted, fontSize: TYPE.secondary }}>
            {`Swipe for ${hidden} more column${hidden === 1 ? "" : "s"} ›`}
          </RNText>
        ) : <View />}
        <Pressable testID={T1_TID.tableOpen} accessibilityRole="button" accessibilityLabel="Open full table"
          onPress={() => pushScreen("table", { block, chat: where.chat })}
          style={{ minHeight: PHONE.target, justifyContent: "center", paddingLeft: 12 }}>
          <RNText style={{ color: t.accent, fontSize: TYPE.busy }}>Open full table</RNText>
        </Pressable>
      </View>
    </View>
  );
}
