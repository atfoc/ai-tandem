// The count of the draft's quotes above the box ("❝ 2 comments ▾") and the list it opens (the old page's Quotes.tsx's count and QuoteList; C-QT-13,
// C-QT-14, C-QT-15, C-QT-17). A press on a quote of the list shows where it is from and opens its comment field; the × removes it.
// Without `onRemove` the quotes are to be read only: a press shows the passage, and no quote has a remove control.
import { useRef } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { preview, quoteKey } from "@aiwb/core/logic/quotes.ts";
import type { Reference } from "@aiwb/core/types.ts";

import { alpha } from "../chat/colour.ts";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { usePointer } from "../../ui/usePointer";
import { webStyle } from "../../ui/webstyle.ts";
import { chipWord, countTitle, countWord, listHint, NARROW_COUNT } from "./model.ts";

/** The phone's chip: 34 pt high, 15 pt text (goal 3.6, mockup co-05a). */
const CHIP_HEIGHT = 34;
const CHIP_TEXT = 15;

export function QuoteCount({ quotes, open, width, onOpen, onClose, onPick, onRemove }: {
  quotes: Reference[]; open: boolean;
  /** The width of the composer's row: below `NARROW_COUNT` the word is left out. */
  width: number;
  onOpen(): void; onClose(): void; onPick(q: Reference): void; onRemove?: (q: Reference) => void;
}) {
  const { tokens: t } = useTheme();
  const phone = usePhone();
  const n = quotes.length, anchor = useRef<View>(null);
  const word = width <= 0 || width > NARROW_COUNT;
  // the phone's chip of the context row: a press opens the sheet "Quoted in this message" (QuotesSheet, drawn by useQuotes), not the list
  if (phone) return <PhoneChip n={n} open={open} onOpen={onOpen} onClose={onClose} />;
  return (
    <View style={styles.wrap}>
      <Pressable ref={anchor} {...tid("qcount", { n, stack: n > 1, on: open })} role="button" accessibilityLabel={countTitle(n)} accessibilityState={{ expanded: open }}
        onPress={() => (open ? onClose() : onOpen())}
        style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.count, { borderColor: hovered || open ? t.accent : alpha(t.accent, 0.3), backgroundColor: t.accentSoft },
          n > 1 && { boxShadow: `2px -2px 0 -1px ${t.bg}, 2px -2px 0 0 ${alpha(t.accent, 0.3)}` }, webStyle({ cursor: "pointer" })]}>
        <Text {...tid("qcount-label")} size={11.5} weight="600" tone="accent" numberOfLines={1}>
          <Text size={14} tone="accent" style={styles.mark}>❝</Text> {n}{word ? ` ${countWord(n)}` : ""} <Text size={9} tone="accent" style={styles.chev}>▾</Text>
        </Text>
      </Pressable>
      <QuoteList open={open} anchor={anchor} quotes={quotes} onClose={onClose} onPick={onPick} onRemove={onRemove} />
    </View>
  );
}

/** The soft yellow of a quoted passage in the thread (platform/quote.web.ts `aiwb-pending`), for the chip and the sheet's cards. */
export function quoteYellow(theme: "light" | "dark"): string {
  return theme === "dark" ? "rgba(255, 204, 0, 0.14)" : "rgba(255, 214, 10, 0.2)";
}

function PhoneChip({ n, open, onOpen, onClose }: { n: number; open: boolean; onOpen(): void; onClose(): void }) {
  const { tokens: t, theme } = useTheme();
  return (
    <Pressable {...tid("qcount", { n, stack: n > 1, on: open })} role="button" accessibilityLabel={countTitle(n)} accessibilityState={{ expanded: open }}
      hitSlop={{ top: (44 - CHIP_HEIGHT) / 2, bottom: (44 - CHIP_HEIGHT) / 2 }} onPress={() => (open ? onClose() : onOpen())}
      style={[styles.chip, { borderColor: t.warn, backgroundColor: quoteYellow(theme) }, webStyle({ cursor: "pointer" })]}>
      <Text {...tid("qcount-label")} size={CHIP_TEXT} weight="500" numberOfLines={1}>
        <Text size={CHIP_TEXT} style={[styles.mark, { color: t.warnText }]}>❝</Text> {chipWord(n)}
      </Text>
    </Pressable>
  );
}

function QuoteList({ open, anchor, quotes, onClose, onPick, onRemove }: {
  open: boolean; anchor: React.RefObject<View | null>; quotes: Reference[]; onClose(): void; onPick(q: Reference): void; onRemove?: (q: Reference) => void;
}) {
  const { tokens: t } = useTheme();
  const touch = usePointer() === "touch";
  return (
    <Overlay open={open} onClose={onClose} label="Quoted in this message" kind="popover" anchor={anchor} up width={440} testID="qlist">
      <View style={styles.list}>
        <View style={[styles.head, { borderBottomColor: t.line }]}>
          <Text {...tid("qlist-head")} size={11} weight="600" tone="muted" style={styles.headWord}>Quoted in this message</Text>
          <Text {...tid("qlist-hint")} size={11} tone="muted">{listHint(!!onRemove, touch)}</Text>
        </View>
        <View style={styles.body}>
          {quotes.map((q) => (
            <Pressable key={quoteKey(q)} {...tid("qlist-item")} role="button" accessibilityLabel={onRemove ? "Show and edit" : "Show"} onPress={() => onPick(q)}
              style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.item, hovered && { backgroundColor: t.accentSoft, borderLeftColor: t.accent }, webStyle({ cursor: "pointer" })]}>
              <View style={styles.text}>
                <Text {...tid("qlist-quote")} size={12} tone="muted" numberOfLines={1}>{preview(q.quote, 120)}</Text>
                <Text {...tid("qlist-comment")} dataSet={{ none: !q.comment }} tone={q.comment ? "text" : "faint"} numberOfLines={2} style={[styles.comment, !q.comment && styles.none]}>{q.comment || "No comment"}</Text>
              </View>
              {onRemove ? (
                <Pressable {...tid("qlist-x")} role="button" accessibilityLabel="Remove" hitSlop={6} onPress={() => { onRemove(q); if (quotes.length === 1) onClose(); }}
                  style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.x, hovered && { backgroundColor: t.accentSoft }, webStyle({ cursor: "pointer" })]}>
                  <Text size={14} tone="faint">×</Text>
                </Pressable>
              ) : null}
            </Pressable>
          ))}
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row" },
  chip: { flexDirection: "row", alignItems: "center", alignSelf: "center", height: CHIP_HEIGHT, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1 },
  count: { flexDirection: "row", alignItems: "center", height: 22, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1 },
  mark: { fontFamily: "Georgia, serif" },
  chev: { opacity: 0.7 },
  list: { minWidth: 240, maxWidth: 440 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8, paddingTop: 8, paddingBottom: 6, paddingHorizontal: 12, borderBottomWidth: 1 },
  headWord: { textTransform: "uppercase", letterSpacing: 0.3 },
  body: { padding: 4 },
  item: { flexDirection: "row", alignItems: "flex-start", gap: 6, paddingVertical: 7, paddingLeft: 10, paddingRight: 6, borderRadius: 7, borderLeftWidth: 3, borderLeftColor: "transparent" },
  text: { flex: 1, minWidth: 0 },
  comment: { marginTop: 2 },
  none: { fontStyle: "italic" },
  x: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
});
