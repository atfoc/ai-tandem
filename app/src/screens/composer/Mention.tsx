// The @ list of a board chat (the old page's Composer.tsx `.mention-pop`): up to six boards of the chat's server whose name contains what follows the
// "@", each with its group's path beside it. A press on an option picks it and the box keeps the focus. It hangs above the box.
import { Pressable, StyleSheet, View, type ViewProps } from "react-native";

import type { Board } from "@aiwb/core/types.ts";

import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";

// (react-native's Role list has no listbox; react-native-web draws any role it is given)
const LISTBOX = "listbox" as unknown as NonNullable<ViewProps["role"]>;

export type MentionOption = { board: Board; group: string };

export function MentionList({ options, at, onPick }: { options: MentionOption[]; at: number; onPick(o: MentionOption): void }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("mention-pop")} role={LISTBOX} aria-label="Boards" style={[styles.pop, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowMd }]}>
      {options.map((o, i) => <Item key={o.board.id} o={o} on={i === at} onPick={() => onPick(o)} />)}
    </View>
  );
}

function Item({ o, on, onPick }: { o: MentionOption; on: boolean; onPick(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined, false, true); // a press leaves the focus in the box
  return (
    <Pressable ref={ref} {...tid("mention-item", { board: o.board.id })} role="option" aria-selected={on} accessibilityLabel={`@${o.board.name}`} onPress={onPick}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.item, { backgroundColor: on || hovered ? t.accentSoft : "transparent" }, webStyle({ cursor: "pointer" })]}>
      <Text numberOfLines={1} style={styles.name}>@{o.board.name}</Text>
      {o.group ? <Text size={11} tone="faint" numberOfLines={1} style={styles.hint}>{o.group}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pop: { position: "absolute", left: 6, bottom: "100%", marginBottom: 4, minWidth: 180, borderWidth: 1, borderRadius: 8, padding: 4, zIndex: 20 },
  item: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 5, minHeight: 30 },
  name: { flexShrink: 1 },
  hint: { flexShrink: 1 },
});
