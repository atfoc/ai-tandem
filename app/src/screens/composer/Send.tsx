// Send and Stop (the old page's styles.css .send): 28-point squares that never shrink and never leave the toolbar's row. Send is the arrow "↑"
// (a spinner while a message is on its way), off with a title that says why; Stop is a filled square on the text colour.
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useMeasuring } from "./measure.tsx";
import { useMergedRef } from "./Chip.tsx";

export function SendButton({ title, disabled, spin, onPress }: { title: string; disabled?: boolean; spin?: boolean; onPress?: () => void }) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useMergedRef(title);
  return (
    <Pressable ref={ref} {...(measuring ? {} : tid("send", { sending: !!spin }))} role="button" accessibilityLabel={title} disabled={disabled}
      accessibilityState={{ disabled: !!disabled, busy: !!spin }} onPress={onPress}
      style={[styles.btn, { backgroundColor: disabled ? t.line2 : t.accentFill }, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      {spin ? <ActivityIndicator size="small" color={t.muted} /> : <Text size={15} weight="700" style={{ color: disabled ? t.faint : t.onAccent }}>↑</Text>}
    </Pressable>
  );
}

export function StopButton({ title, onPress }: { title: string; onPress(): void }) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useMergedRef(title);
  return (
    <Pressable ref={ref} {...(measuring ? {} : tid("stop"))} role="button" accessibilityLabel={title} onPress={onPress}
      style={[styles.btn, { backgroundColor: t.text }, webStyle({ cursor: "pointer" })]}>
      <View style={[styles.square, { backgroundColor: t.bg }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { width: 28, height: 28, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  square: { width: 9, height: 9, borderRadius: 2 },
});
