// The chips of Home's servers (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §2 "Chip look"), drawn with two entries or
// more: one chip a server, a dot in the tone of its state word and its name; the selected one filled. A press chooses the server, a long press
// opens its sheet. A chip is 36 pt with a 44 pt target; they scroll sideways when they do not fit.
import { ScrollView, Pressable, StyleSheet, View } from "react-native";

import type { ServerView } from "@aiwb/core/logic/servers.ts";

import { haptic } from "../../platform/haptics";
import { LONG_PRESS_MS, PHONE, TYPE } from "../../ui/metrics.ts";
import { toneOf, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { setHomeServer } from "../shell/homeplace.ts";
import { H1_TID } from "./ids.ts";
import { openServerSheet } from "./serverseam.ts";

const DOT = 8;
const SLOP = (PHONE.target - PHONE.chip) / 2;

export function ServerChips({ entries, selected }: { entries: readonly ServerView[]; selected: string | null }) {
  return (
    <View style={styles.wrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} {...tid(H1_TID.chips)} contentContainerStyle={styles.row}>
        {entries.map((v) => <Chip key={v.id} view={v} selected={v.id === selected} />)}
      </ScrollView>
    </View>
  );
}

function Chip({ view, selected }: { view: ServerView; selected: boolean }) {
  const t = useTokens(), word = useServerWord(view);
  return (
    <Pressable {...tid(H1_TID.chip, { server: view.id, word: word.key, selected: String(selected) })}
      accessibilityRole="button" accessibilityLabel={`${view.name}, ${word.text}`} accessibilityState={{ selected }}
      hitSlop={SLOP} delayLongPress={LONG_PRESS_MS}
      onPress={() => setHomeServer(view.id)}
      onLongPress={() => { haptic("select"); openServerSheet(view.id); }}
      style={[styles.chip, { borderColor: t.line, backgroundColor: selected ? t.text : t.bg }]}>
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: toneOf(t, word.tone) }]} />
      <Text size={TYPE.busy} numberOfLines={1} style={{ color: selected ? t.bg : t.text }}>{view.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingVertical: SLOP },
  row: { paddingHorizontal: PHONE.margin, gap: 8, alignItems: "center" },
  chip: { height: PHONE.chip, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1, maxWidth: 240 },
  dot: { width: DOT, height: DOT, borderRadius: DOT / 2 },
});
