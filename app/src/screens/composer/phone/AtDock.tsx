// The @ suggestions of a board chat on the phone (ux-improvements goal 3.6, mockup "05" co-05c): docked full width above the composer, not over it (a
// block in the layout, pushing the composer's content up, bleeding to the screen's edges between two hairlines); 52-point rows (a 34-point tile
// with the board's icon, the name with the match in bold, the group under it), at most four, the lit one in accent-soft, no "@". The context
// row stays in view under it. A press picks, and the box keeps its focus.
import { Pressable, StyleSheet, View, type ViewProps } from "react-native";

import { BoardIcon } from "../../../ui/icons.tsx";
import { TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useControlRef } from "../../../ui/useControlRef";
import { webStyle } from "../../../ui/webstyle.ts";
import type { MentionOption } from "../Mention.tsx";
import { PHONE_IDS } from "./ids.ts";

// (react-native's Role list has no listbox; react-native-web draws any role it is given)
const LISTBOX = "listbox" as unknown as NonNullable<ViewProps["role"]>;

export type AtDockProps = {
  options: MentionOption[];
  /** The lit row. */
  at: number;
  /** What follows the "@" (the match drawn in bold). */
  query: string;
  onPick(o: MentionOption): void;
};

/** The composer's side padding (Composer.tsx `styles.composer`): the dock bleeds through it to the screen's edges. */
const SIDE = 12;
const ROW = 52;
const MAX = 4;

/** The name with the part that matches `query` (the first, whatever the case) in bold. */
export function matchParts(name: string, query: string): { before: string; match: string; after: string } {
  const i = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  return i < 0 ? { before: name, match: "", after: "" } : { before: name.slice(0, i), match: name.slice(i, i + query.length), after: name.slice(i + query.length) };
}

export function AtDock({ options, at, query, onPick }: AtDockProps) {
  const { tokens: t } = useTheme();
  // At most four rows: the window follows the lit one.
  const from = Math.min(Math.max(0, at - (MAX - 1)), Math.max(0, options.length - MAX));
  return (
    <View {...tid(PHONE_IDS.atDock)} role={LISTBOX} aria-label="Boards"
      style={[styles.dock, { backgroundColor: t.bg, borderColor: t.line }]}>
      {options.slice(from, from + MAX).map((o, k) => <Row key={o.board.id} o={o} query={query} on={from + k === at} onPick={() => onPick(o)} />)}
    </View>
  );
}

function Row({ o, query, on, onPick }: { o: MentionOption; query: string; on: boolean; onPick(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined, false, true); // a press leaves the focus in the box
  const { before, match, after } = matchParts(o.board.name, query);
  return (
    <Pressable ref={ref} {...tid("mention-item", { board: o.board.id, on })} role="option" aria-selected={on} accessibilityLabel={o.board.name} onPress={onPick}
      style={[styles.row, { backgroundColor: on ? t.accentSoft : "transparent" }, webStyle({ cursor: "pointer" })]}>
      <View style={[styles.tile, { backgroundColor: t.panel, borderColor: t.line }]}><BoardIcon size={18} color={t.muted} /></View>
      <View style={styles.words}>
        <Text size={TYPE.control} numberOfLines={1}>{before}{match ? <Text size={TYPE.control} weight="700">{match}</Text> : null}{after}</Text>
        {o.group ? <Text size={TYPE.secondary} tone="muted" numberOfLines={1}>{o.group}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  dock: { marginHorizontal: -SIDE, marginBottom: 4, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { height: ROW, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16 },
  tile: { width: 34, height: 34, borderRadius: 8, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  words: { flexShrink: 1, minWidth: 0 },
});
