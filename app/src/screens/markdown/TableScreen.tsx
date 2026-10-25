// The full table (goal 3.5): "Open full table" under a table of the thread pushes this screen. Every cell is at 16 pt, the header row and
// the first column stay where they are while the rest scrolls, a pinch zooms (the cells and their padding are laid out again, so the
// pinned row and column stay pinned), and Copy puts the table on the clipboard as Markdown. The app turns with the device; the layout
// reads the window's width, not a phone's.
import { useContext, useRef, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { chatTitle, shownView, threadOf } from "@aiwb/core/state/store.ts";

import { copyText } from "../../platform/clipboard";
import { ContentBar } from "../../ui/Bars.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { showToast } from "../../ui/Toast.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { useStore } from "../../state/useStore.ts";
import { T1_TID } from "../chat/ids.ts";
import { NavBack } from "../shell/BackButton.tsx";
import { registerScreen } from "../shell/screens.ts";
import type { Block, Cell } from "./doc.ts";
import { Inlines } from "./Inline.tsx";
import type { Look } from "./look.ts";
import { LookContext } from "./look.tsx";
import { textWidth } from "./Table.tsx";
import { tableMarkdown, tableSize } from "./tablemd.ts";

type TableOf = Extract<Block, { k: "table" }>;
export type TableParams = { block: TableOf; chat?: string };

const SIZE = 16;
const ROW = 44;
const MIN_ZOOM = 0.75;
const MAX_ZOOM = 2.5;
const clamp = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function TableScreen({ params }: { params: TableParams }) {
  const { block, chat } = params;
  const t = useTokens();
  const insets = useContext(SafeAreaInsetsContext);
  const shown = useStore((s) => (chat ? shownView(s, chat) : undefined));
  const items = useStore((s) => (chat ? threadOf(s, chat)?.items : undefined));
  const sub = shown ? chatTitle(shown, items) : undefined;
  const [zoom, setZoom] = useState(1);
  const start = useRef(1);
  const pinch = Gesture.Pinch().runOnJS(true)
    .onStart(() => { start.current = zoom; })
    .onUpdate((e) => setZoom(clamp(start.current * e.scale)));
  const copy = () => {
    copyText(tableMarkdown(block)).then(() => showToast({ text: "Table copied" }), () => showToast({ text: "Could not copy the table" }));
  };
  const side = Math.max(PHONE.margin, insets?.left ?? 0, insets?.right ?? 0);
  return (
    <View testID={T1_TID.tableScreen} style={{ flex: 1, minHeight: 0, backgroundColor: t.bg }}>
      <ContentBar back={<NavBack />} title={`Table · ${tableSize(block)}`} sub={sub}
        actions={(
          <Pressable testID={T1_TID.tableCopy} accessibilityRole="button" accessibilityLabel="Copy table as Markdown" onPress={copy}
            style={{ minWidth: PHONE.target, minHeight: PHONE.target, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 }}>
            <RNText style={{ color: t.accent, fontSize: TYPE.control }}>Copy</RNText>
          </Pressable>
        )} />
      <GestureDetector gesture={pinch}>
        <View testID="table-zoom" style={{ flexShrink: 1, flexGrow: 0, minHeight: 0, marginTop: PHONE.margin, marginLeft: side, marginRight: side }}>
          <FullTable block={block} zoom={zoom} />
        </View>
      </GestureDetector>
      <RNText style={{ color: t.muted, fontSize: TYPE.secondary, marginTop: 12, marginLeft: side, marginRight: side, paddingBottom: Math.max(PHONE.margin, insets?.bottom ?? 0) }}>
        Pinch to zoom · scrolls both ways when the table is larger than the screen
      </RNText>
    </View>
  );
}

/** The table at the zoom shown: the header row and the first column pinned. The header's cells sit in a box that follows the body's
 *  sideways scroll; the first column is in the body's vertical scroll, outside the box that scrolls sideways. */
function FullTable({ block, zoom }: { block: TableOf; zoom: number }) {
  const t = useTokens();
  const size = SIZE * zoom;
  const pad = 12 * zoom;
  const columns = block.align.length || block.head.length;
  // (the text of a semibold header is a little wider than its characters count for)
  const widths = Array.from({ length: columns }, (_, i) => Math.ceil(textWidth([block.head[i], ...block.rows.map((r) => r[i])].filter(Boolean), size) * 1.15) + 2 * pad + 4);
  const first = widths[0] ?? 0;
  const rest = widths.slice(1);
  const hasHead = block.head.length > 0;
  const headRef = useRef<ScrollView>(null);
  // the height each cell's text has on its own: a row is as high as its tallest cell, in the pinned column and the others alike
  const [natural, setNatural] = useState<Record<string, number>>({});
  const measure = (key: string, h: number) => setNatural((p) => (Math.abs((p[key] ?? 0) - h) < 0.5 ? p : { ...p, [key]: h }));
  const high = (row: number) => {
    let h = ROW * zoom;
    for (const [k, v] of Object.entries(natural)) if (k.startsWith(`${row}:`)) h = Math.max(h, v + 2 * 8 * zoom);
    return h;
  };
  const look: Look = { size, color: t.text, user: false };

  const cell = (c: Cell | undefined, row: number, col: number, head: boolean, w: number) => (
    <View key={col} testID={head ? "md-th" : "md-td"} style={{ width: w, height: high(row), justifyContent: "center", paddingHorizontal: pad, backgroundColor: head ? t.panel : undefined }}>
      <View onLayout={(e) => measure(`${row}:${col}`, e.nativeEvent.layout.height)}>
        <RNText style={{ color: head ? t.muted : t.text, fontSize: size, lineHeight: size * 1.4, fontWeight: head ? "600" : undefined, textAlign: (block.align[col] as "left" | "center" | "right" | null) ?? "left" }}>
          {c ? <Inlines kids={c.kids} /> : null}
        </RNText>
      </View>
    </View>
  );
  const rule = { borderBottomWidth: 1, borderColor: t.line2 };
  const pin = { borderRightWidth: 1, borderColor: t.line2 };
  return (
    <LookContext.Provider value={look}>
      <View testID="md-table" style={{ flexShrink: 1, minHeight: 0, borderTopWidth: 1, borderColor: t.line2 }}>
        {hasHead ? (
          <View testID="table-head" style={[{ flexDirection: "row", flexShrink: 0 }, rule]}>
            <View style={[{ width: first + 1 }, pin]}>{cell(block.head[0], 0, 0, true, first)}</View>
            <ScrollView ref={headRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false} style={{ flex: 1, backgroundColor: t.panel }}>
              <View style={{ flexDirection: "row", flexGrow: 1 }}>{rest.map((w, j) => cell(block.head[j + 1], 0, j + 1, true, w))}</View>
            </ScrollView>
          </View>
        ) : null}
        <ScrollView testID="table-body" style={{ flexGrow: 0 }} showsVerticalScrollIndicator={false}>
          <View style={{ flexDirection: "row" }}>
            <View style={[{ width: first + 1 }, pin]}>
              {block.rows.map((r, i) => <View key={i} style={rule}>{cell(r[0], i + 1, 0, false, first)}</View>)}
            </View>
            <ScrollView horizontal scrollEventThrottle={16} showsHorizontalScrollIndicator={false} style={{ flex: 1 }}
              onScroll={(e) => headRef.current?.scrollTo({ x: e.nativeEvent.contentOffset.x, animated: false })}>
              <View style={{ flexGrow: 1 }}>
                {block.rows.map((r, i) => <View key={i} style={[{ flexDirection: "row" }, rule]}>{rest.map((w, j) => cell(r[j + 1], i + 1, j + 1, false, w))}</View>)}
              </View>
            </ScrollView>
          </View>
        </ScrollView>
      </View>
    </LookContext.Provider>
  );
}

registerScreen<TableParams>("table", { kind: "content", title: () => "Table", component: TableScreen });
