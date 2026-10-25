// The three lists of a place, one under the other (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §3): GROUPS,
// BOARDS, CHATS, each with a head (its name at the left, how many rows at the right) and its rows, and none for a list that is empty.
// Home draws it for a server's top level and the group screen for a group. It is not a scroll view: the screen around it scrolls.
// `stale` is a list kept from the last sync of a server that is away: it is drawn faded, and a press says so (`onStalePress`) instead of opening.
import { StyleSheet, View } from "react-native";

import { Text } from "../../ui/Text.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { tid } from "../../ui/tid.ts";
import { H1_TID } from "./ids.ts";
import { HomeRow } from "./HomeRow.tsx";
import type { PlaceLists, RowItem } from "./model.ts";
import { useRowActions } from "./rowactions.ts";
import { useIsTopScreen } from "./dragscreen.tsx";

export type HomeListProps = {
  lists: PlaceLists;
  /** A press on a row (open.ts `openItem` is what Home passes). */
  onOpen(item: RowItem): void;
  stale?: boolean;
  onStalePress?(item: RowItem): void;
};

const SECTIONS = [["groups", "GROUPS"], ["boards", "BOARDS"], ["chats", "CHATS"]] as const;

export function HomeList({ lists, onOpen, stale = false, onStalePress }: HomeListProps) {
  const places = useIsTopScreen() && !stale;
  return (
    <View {...tid(H1_TID.list, { stale: String(stale) })} style={stale ? styles.stale : undefined}>
      {SECTIONS.map(([section, label]) => lists[section].length === 0 ? null : (
        <View key={section}>
          <View {...tid(H1_TID.section, { section, count: lists[section].length })} accessibilityRole="header" style={styles.head}>
            <Text size={TYPE.secondary} tone="muted" style={styles.label}>{label}</Text>
            <Text size={TYPE.secondary} tone="muted">{lists[section].length}</Text>
          </View>
          {lists[section].map((item, i) => (
            <Row key={item.key} item={item} stale={stale} places={places} last={i === lists[section].length - 1}
              onPress={() => (stale ? onStalePress?.(item) : onOpen(item))} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** One row with its actions (none until package H2; a faded row has none). */
function Row({ item, stale, places, last, onPress }: { item: RowItem; stale: boolean; places: boolean; last: boolean; onPress(): void }) {
  const { swipe, onLongPress } = useRowActions(item);
  return <HomeRow item={item} last={last} onPress={onPress} swipe={stale ? undefined : swipe} onLongPress={stale ? undefined : onLongPress} places={places} />;
}

const styles = StyleSheet.create({
  stale: { opacity: 0.45 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: PHONE.margin, paddingTop: 14, paddingBottom: 6 },
  label: { letterSpacing: 0.4 },
});
