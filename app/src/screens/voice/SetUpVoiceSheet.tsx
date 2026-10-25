// "Set up voice" (ux-improvements goal 3.7.2, v1-design §3): on the phone every voice problem is this one sheet, whatever control raised it.
// A round accent-soft badge with Talk's wave, the title, the body, a muted note, one block primary and "Not now". Closing it any way
// (grabber, swipe, backdrop, Android back) is "Not now". The primary dismisses the problem, then acts. No key field here: the key is typed in Settings.
import { StyleSheet, View } from "react-native";

import { PROBLEM_DISMISS } from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { WaveIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { TID, tid } from "../../ui/tid.ts";
import type { SetupWords } from "./setupwords.ts";

const BADGE = 60;

export type SetUpVoiceSheetProps = {
  kind: string;
  words: SetupWords;
  /** What the primary does after the sheet is dismissed; null = no primary (the problem has no action here). */
  act: (() => void) | null;
  onDismiss(): void;
};

export function SetUpVoiceSheet({ kind, words, act, onDismiss }: SetUpVoiceSheetProps) {
  const t = useTokens();
  return (
    <Sheet open detent="fit" label={words.title} testID="setup-voice" onClose={onDismiss}>
      <View {...tid("voice-problem", { kind })} style={styles.body}>
        {/* (the head of this sheet is the badge over its title, as co-06a draws it: named as the head for the rule that every sheet says its subject there) */}
        <View {...tid(TID.sheetHead)} style={styles.head}>
          <View style={[styles.badge, { backgroundColor: t.accentSoft }]}><WaveIcon size={26} color={t.accent} /></View>
          <Text {...tid(TID.sheetTitle)} size={TYPE.h2} weight="600" accessibilityRole="header" style={styles.centred}>{words.title}</Text>
        </View>
        <Text {...tid("voice-problem-text")} size={TYPE.control} style={styles.centred}>{words.body}</Text>
        {words.note ? <Text size={TYPE.secondary} tone="muted" style={styles.centred}>{words.note}</Text> : null}
        <View style={styles.actions}>
          {act ? <Button size="block" tone="primary" label={words.action} testID="voice-problem-act" onPress={() => { onDismiss(); act(); }} /> : null}
          <Button size="touch" tone="ghost" label={PROBLEM_DISMISS} testID="voice-problem-dismiss" onPress={onDismiss} style={styles.notNow}>
            {/* (a text button in the accent, as co-06a draws it) */}
            <Text size={TYPE.control} tone="accent">{PROBLEM_DISMISS}</Text>
          </Button>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: "center", paddingHorizontal: PHONE.margin - 8, paddingTop: 8, paddingBottom: 4, gap: 10 },
  head: { alignItems: "center", gap: 10 },
  badge: { width: BADGE, height: BADGE, borderRadius: BADGE / 2, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  centred: { textAlign: "center" },
  actions: { alignSelf: "stretch", gap: 6, marginTop: 8 },
  notNow: { alignSelf: "stretch", alignItems: "center" },
});
