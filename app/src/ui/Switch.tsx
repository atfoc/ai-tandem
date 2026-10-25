// The look of a switch (the sidebar foot's "Show archived", Settings > Voice's "Skip code blocks"): a 26 × 15 track and a knob that slides
// to the right when it is on; on the phone, `size="touch"` is the system's 51 × 31. `SwitchLook` draws the track only; the control that holds it
// (a Pressable with role "switch") is the caller's. `Switch` is that control for the phone's screens: the look in a Pressable of at least
// 44 pt, with the role, the state and the label a screen reader needs.
import { Pressable, StyleSheet, View } from "react-native";

import { PHONE } from "./metrics.ts";
import { useTokens } from "./theme.tsx";
import { tid, TID } from "./tid.ts";
import { webStyle } from "./webstyle.ts";

export type SwitchSize = "sm" | "touch";

/** The track and knob sizes: the knob slides by the track's width less the knob's and twice the inset. */
const LOOK = {
  sm: { width: 26, height: 15, knob: 11, inset: 2, slide: 11 },
  touch: { width: 51, height: 31, knob: 27, inset: 2, slide: 20 },
} as const;

export function SwitchLook({ on, testID, knobTestID, size = "sm" }: { on: boolean; testID: string; knobTestID: string; size?: SwitchSize }) {
  const t = useTokens();
  const m = LOOK[size];
  return (
    <View {...tid(testID, { on })} style={[styles.track, { width: m.width, height: m.height, borderRadius: m.height / 2 + 0.5, backgroundColor: on ? t.accentFill : t.line2 }]}>
      <View {...tid(knobTestID)}
        style={[styles.knob, { top: m.inset, left: m.inset, width: m.knob, height: m.knob, borderRadius: m.knob / 2 + 0.5, backgroundColor: on ? t.knobOn : t.knob }, on && { transform: [{ translateX: m.slide }] }]} />
    </View>
  );
}

export type SwitchProps = {
  on: boolean;
  onChange(next: boolean): void;
  /** What it switches, for a screen reader. */
  label: string;
  size?: SwitchSize;
  disabled?: boolean;
  testID?: string;
  knobTestID?: string;
};

export function Switch({ on, onChange, label, size = "sm", disabled, testID = TID.switch, knobTestID = TID.switchKnob }: SwitchProps) {
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on, disabled: !!disabled }} aria-checked={on}
      accessibilityLabel={label} disabled={disabled} onPress={() => onChange(!on)}
      style={[size === "touch" && styles.touch, disabled && styles.disabled, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      <SwitchLook on={on} testID={testID} knobTestID={knobTestID} size={size} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { flexShrink: 0 },
  knob: { position: "absolute" },
  touch: { minWidth: PHONE.target, minHeight: PHONE.target, alignItems: "center", justifyContent: "center" },
  disabled: { opacity: 0.6 },
});
