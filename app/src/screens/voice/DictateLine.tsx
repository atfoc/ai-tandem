// What the phone's box draws while Dictate listens (ux-improvements goal 3.7.2, mockup co-06c): the line above the text (`dictate-line`: the live
// level as five bars, "Listening…" in the accent, and "Tap the mic to end" at the right) and, under the text, the live guess in the muted colour
// (`dictate-guess`). The guess is not the box's value: the control publishes it (composer/dictation.ts) and the finished words go into the box.
import { StyleSheet, View } from "react-native";

import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { tid } from "../../ui/tid.ts";
import { useDictationGuess } from "../composer/dictation.ts";
import { useVoiceSession } from "../../voice/index.ts";
import { DICTATE_LINE_END, DICTATE_LINE_LISTENING } from "../../voice/words.ts";

const BARS = [0.5, 0.8, 1, 0.7, 0.55];
const TALL = 16;

function useDictating(chat: string, branch: string): boolean {
  return useVoiceSession((s) => s.owner !== null && s.owner.kind === "dictation" && s.owner.chat === chat && s.owner.branch === branch);
}

export function DictateLine({ chatId, branch }: { chatId: string; branch: string }) {
  const { tokens: t } = useTheme();
  const on = useDictating(chatId, branch);
  const level = useVoiceSession((s) => (s.owner?.kind === "dictation" && s.owner.chat === chatId && s.owner.branch === branch ? Math.round(s.level * 25) / 25 : 0));
  if (!on) return null;
  const grow = Math.min(1, 0.15 + Math.sqrt(level) * 1.6);
  return (
    <View {...tid("dictate-line", { level: Math.round(level * 100) })} style={styles.line}>
      <View style={styles.bars}>
        {BARS.map((b, i) => <View key={i} style={[styles.bar, { height: Math.max(4, Math.round(TALL * b * grow)), backgroundColor: t.accent }]} />)}
      </View>
      <Text size={TYPE.secondary} tone="accent">{DICTATE_LINE_LISTENING}</Text>
      <View style={styles.grow} />
      <Text size={TYPE.secondary} tone="muted" numberOfLines={1}>{DICTATE_LINE_END}</Text>
    </View>
  );
}

/** The live guess, muted, right under the text inside the box. */
export function DictateGuess({ chatId, branch }: { chatId: string; branch: string }) {
  const on = useDictating(chatId, branch);
  const guess = useDictationGuess(chatId);
  if (!on || !guess) return null;
  return <Text {...tid("dictate-guess")} size={TYPE.control} tone="muted" style={styles.guess}>{guess}</Text>;
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, paddingBottom: 6 },
  bars: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 2, height: TALL, width: 22 },
  bar: { width: 3, borderRadius: 2 },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  guess: { paddingBottom: 4 },
});
