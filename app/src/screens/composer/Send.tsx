// Send and Stop (the old page's styles.css .send): 28-point squares that never shrink and never leave the toolbar's row. Send is the arrow "↑"
// (a spinner while a message is on its way), off with a title that says why; Stop is a filled square on the text colour.
// `touch` (the phone, ux-improvements goal 3.6): a 36-point disc in a 44-point target, as the phone's primary button (Talk | Send | Stop) is drawn;
// `soft`: Send waits for something (an image being uploaded) and is lit softly, not greyed. `PrimaryDisc` is that disc for other content (Talk's
// waveform).
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { PHONE } from "../../ui/metrics.ts";

import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useMeasuring } from "./measure.tsx";
import { useMergedRef } from "./Chip.tsx";

export function SendButton({ title, disabled, spin, soft, size, onPress }: { title: string; disabled?: boolean; spin?: boolean; soft?: boolean; size?: "touch"; onPress?: () => void }) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useMergedRef(size === "touch" ? undefined : title); // (no hover title on the phone: goal 3.1.3)
  if (size === "touch") return (
    <Pressable ref={ref} {...tid("send", { sending: !!spin, soft: !!soft })} role="button" accessibilityLabel={title} disabled={disabled}
      accessibilityState={{ disabled: !!disabled, busy: !!spin }} onPress={onPress} style={[styles.target, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      <View style={[styles.disc, { backgroundColor: soft ? t.accentSoft : disabled ? t.line2 : t.accentFill }]}>
        {spin ? <ActivityIndicator size="small" color={t.muted} /> : <Text size={19} weight="700" style={{ color: soft ? t.accent : disabled ? t.faint : t.onAccent }}>↑</Text>}
      </View>
    </Pressable>
  );
  return (
    <Pressable ref={ref} {...(measuring ? {} : tid("send", { sending: !!spin }))} role="button" accessibilityLabel={title} disabled={disabled}
      accessibilityState={{ disabled: !!disabled, busy: !!spin }} onPress={onPress}
      style={[styles.btn, { backgroundColor: disabled ? t.line2 : t.accentFill }, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      {spin ? <ActivityIndicator size="small" color={t.muted} /> : <Text size={15} weight="700" style={{ color: disabled ? t.faint : t.onAccent }}>↑</Text>}
    </Pressable>
  );
}

export function StopButton({ title, size, onPress }: { title: string; size?: "touch"; onPress(): void }) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useMergedRef(size === "touch" ? undefined : title); // (no hover title on the phone: goal 3.1.3)
  if (size === "touch") return (
    <Pressable ref={ref} {...tid("stop")} role="button" accessibilityLabel={title} onPress={onPress} style={[styles.target, webStyle({ cursor: "pointer" })]}>
      <View style={[styles.disc, { backgroundColor: t.text }]}><View style={[styles.squareTouch, { backgroundColor: t.bg }]} /></View>
    </Pressable>
  );
  return (
    <Pressable ref={ref} {...(measuring ? {} : tid("stop"))} role="button" accessibilityLabel={title} onPress={onPress}
      style={[styles.btn, { backgroundColor: t.text }, webStyle({ cursor: "pointer" })]}>
      <View style={[styles.square, { backgroundColor: t.bg }]} />
    </Pressable>
  );
}

/** The phone's primary disc around any content, in its 44-point target (Talk's waveform). The press and the label are the caller's. */
export function PrimaryDisc({ on, disabled, children }: { on?: boolean; disabled?: boolean; children: ReactNode }) {
  const { tokens: t } = useTheme();
  return <View style={[styles.disc, { backgroundColor: disabled ? t.line2 : on ? t.text : t.accentFill }]}>{children}</View>;
}

const DISC = 36;

const styles = StyleSheet.create({
  target: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  disc: { width: DISC, height: DISC, borderRadius: DISC / 2, alignItems: "center", justifyContent: "center" },
  squareTouch: { width: 11, height: 11, borderRadius: 2 },
  btn: { width: 28, height: 28, borderRadius: 7, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  square: { width: 9, height: 9, borderRadius: 2 },
});
