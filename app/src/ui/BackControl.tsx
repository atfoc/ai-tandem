// The one back control (ux-improvements goal 3.1.2): an accent chevron in a 44 × 44 target, with the name of the screen it goes
// back to on a place screen ("‹ Home", "‹ Settings") and alone on a content screen. Holding it opens the stack sheet (the screens
// under this one; a pick goes back several levels at once). It draws; what a press and a hold do is the stack's
// (screens/shell/screens.ts `NavBack` wires it to `goBack` and `stackEntries`).
//
// Contract of package F2 (plans/ux-improvements/PLAN.md). STUB: the look; the hold sheet is F2's.
import { Pressable, StyleSheet, View } from "react-native";

import { Chevron } from "./icons.tsx";
import { PHONE, TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

export type BackControlProps = {
  /** The previous screen's name on a place screen; none on a content screen. */
  label?: string;
  onPress(): void;
  /** Holding it: the stack sheet. */
  onHold?(): void;
  testID?: string;
};

export function BackControl({ label, onPress, onHold, testID = TID.navBack }: BackControlProps) {
  const t = useTokens();
  return (
    <Pressable {...tid(testID)} accessibilityRole="button" accessibilityLabel={label ? `Back to ${label}` : "Back"}
      onPress={onPress} onLongPress={onHold} delayLongPress={500} style={styles.back}>
      <View style={styles.flip}><Chevron size={14} color={t.accent} /></View>
      {label ? <Text size={TYPE.control} tone="accent" numberOfLines={1} style={styles.label}>{label}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: { minWidth: PHONE.target, minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 8, flexShrink: 1 },
  flip: { transform: [{ rotate: "180deg" }] },
  label: { flexShrink: 1, maxWidth: 140 },
});
