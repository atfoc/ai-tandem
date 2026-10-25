// A row of Home or a group's screen (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §3): a 36 pt tile with the
// thing's icon, its name (two lines, never cut to one), a sub-line (a count, a state word in its colour, the model), and at the right a
// group's count of chats that need you, a dot on the tile for a board or chat that does, and a chevron for a group and a board.
// Everything it says comes from model.ts's RowItem; what a swipe, a long press and the sheet do is rowactions.ts's (H2).
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { agentClass, AgentGlyph, BoardIcon, DisclosureChevron, GroupIcon } from "../../ui/icons.tsx";
import { LONG_PRESS_MS, PHONE, TYPE } from "../../ui/metrics.ts";
import { wordColour } from "../../ui/StateWord.tsx";
import { SwipeRow, type SwipeAction } from "../../ui/SwipeRow.tsx";
import { pressUnlessSwiped } from "../../ui/swipeopen.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePointer } from "../../ui/usePointer";
import { haptic } from "../../platform/haptics";
import { useStore } from "../../state/useStore.ts";
import { useDragGesture, useIsDragged, usePlace } from "../sidebar/drag.tsx";
import { pressBlocked } from "../sidebar/pressguard.ts";
import type { Dragged } from "../sidebar/dragsession.ts";
import { H1_TID } from "./ids.ts";
import type { RowItem } from "./model.ts";

/** The icon tile's side, the dot's and the least width of the count badge, in points. */
const TILE = 36, DOT = 8, BADGE = 20;
const ICON = 20;

export type HomeRowProps = {
  item: RowItem;
  onPress(): void;
  swipe?: SwipeAction[];
  /** The buttons a right swipe shows at the left end (Archived's Unarchive). */
  left?: SwipeAction[];
  /** A row of Settings › Archived: its dataSet says so. */
  archived?: boolean;
  onLongPress?(): void;
  /** The row of a list that is drawn faded (the server is away). */
  dim?: boolean;
  /** The last row of its section: no separator under it. */
  last?: boolean;
  /** The row's list takes part in drags (it is on top, not faded): a group row takes a drop, as the sidebar's group box does. */
  places?: boolean;
};

/** What a held finger drags from a row, as the sidebar makes it: a board or chat by "board:<key>" / "chat:<key>", a group by its id. */
export const draggedOf = (item: RowItem): Dragged => item.kind === "group"
  ? { kind: "group", id: item.key, title: item.name, server: item.server }
  : { kind: "row", key: `${item.kind}:${item.key}`, title: item.name, server: item.server };

/** Moving a held finger this far (points) after the hold starts a drag; a release before that opens the row's sheet. */
const MOVE_FIRST = 10;

/** What a screen reader says of a row: "Checkout, 2 boards · 1 group, 3 need you". */
export function rowLabel(item: RowItem): string {
  const a = item.attention;
  return [item.name, item.sub, a.kind === "count" ? `${a.n} need you` : a.kind === "dot" ? "needs you" : ""].filter(Boolean).join(", ");
}

export function HomeRow({ item, onPress, swipe, left, archived, onLongPress, dim, last, places }: HomeRowProps) {
  const t = useTokens(), a = item.attention;
  const touch = usePointer() === "touch";
  const dragKey = item.kind === "group" ? "group:" + item.key : `${item.kind}:${item.key}`;
  const dragged = useIsDragged(dragKey);
  const lit = useStore((s) => !!places && item.kind === "group" && s.dropAt.zone === item.key);
  const place = usePlace("zone", item.key);
  const gesture = useDragGesture(!!onLongPress && !archived, () => draggedOf(item), { holdMs: LONG_PRESS_MS, moveFirst: MOVE_FIRST, onHold: () => haptic("select"), onHoldRelease: onLongPress });
  const soft = (t as Record<string, string>)[agentClass(item.agent ?? "") + "Soft"] ?? t.panel;
  const row = (
    <Pressable {...tid(H1_TID.row, { kind: item.kind, key: item.key, server: item.server, attention: a.kind, count: a.kind === "count" ? a.n : "", archived: archived ? "true" : undefined })}
      accessibilityRole="button" accessibilityLabel={rowLabel(item)}
      onPress={() => { if (!pressBlocked()) pressUnlessSwiped(onPress); }} delayLongPress={LONG_PRESS_MS}
      onLongPress={onLongPress && !touch ? () => { haptic("select"); onLongPress(); } : undefined}
      style={({ pressed }: { pressed: boolean }) => [styles.row, { backgroundColor: lit ? t.accentSoft : pressed ? t.hover2 : t.bg }, (dim || dragged) && styles.dim]}>
      <View style={styles.tileSlot}>
        <View style={[styles.tile, item.kind === "board" && { backgroundColor: t.accentSoft }, item.kind === "chat" && { backgroundColor: soft }]}>
          {item.kind === "group" ? <GroupIcon size={ICON} color={t.muted} />
            : item.kind === "board" ? <BoardIcon size={ICON} color={t.accent} />
            : <AgentGlyph agent={item.agent ?? ""} size={ICON} />}
        </View>
        {a.kind === "dot" ? <View {...tid(H1_TID.rowDot)} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: t.warn, borderColor: t.bg }]} /> : null}
      </View>
      <View style={styles.words}>
        <Text {...tid(H1_TID.rowName)} size={TYPE.control} numberOfLines={2}>{item.name}</Text>
        <Text {...tid(H1_TID.rowSub)} size={TYPE.secondary} numberOfLines={1} style={{ color: item.subTone ? wordColour(t, item.subTone) : t.muted }}>{item.sub}</Text>
      </View>
      {a.kind === "count" ? (
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.badge, { backgroundColor: t.warn }]}>
          <Text {...tid(H1_TID.rowCount)} size={TYPE.secondary} weight="600" tone="onAccent">{a.n}</Text>
        </View>
      ) : null}
      {item.kind !== "chat" ? <DisclosureChevron color={t.faint} /> : null}
      {last ? null : <View pointerEvents="none" style={[styles.separator, { backgroundColor: t.line }]} />}
    </Pressable>
  );
  // (a finger that is held first drags: the swipe's pan and the list's scroll take a move that comes before the hold; a mouse has no hold)
  const held = onLongPress && !archived ? <GestureDetector gesture={gesture} touchAction="pan-y">{row}</GestureDetector> : row;
  const swipeable = swipe?.length || left?.length ? <SwipeRow right={swipe} left={left}>{held}</SwipeRow> : held;
  if (item.kind !== "group") return swipeable;
  // (always the same wrapper, so that a row does not remount when its screen goes under another; it is a place only while `places`)
  return (
    <View ref={places ? place : undefined} collapsable={false} {...tid(H1_TID.rowPlace, { key: item.key, drop: lit || undefined })}>
      {swipeable}
      {lit ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.lit, { borderColor: t.accent }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: PHONE.listRow, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  dim: { opacity: 0.45 },
  lit: { borderWidth: 1 },
  tileSlot: { width: TILE, height: TILE },
  tile: { width: TILE, height: TILE, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  dot: { position: "absolute", top: -2, right: -2, width: DOT + 2, height: DOT + 2, borderRadius: (DOT + 2) / 2, borderWidth: 1 },
  words: { flex: 1, minWidth: 0 },
  badge: { minWidth: BADGE, height: BADGE, borderRadius: BADGE / 2, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  separator: { position: "absolute", right: 0, bottom: 0, left: PHONE.margin + TILE + 12, height: StyleSheet.hairlineWidth },
});
