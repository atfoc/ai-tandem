// The Auto-send toggle of the pill (goal 3.6): a label and the app's switch look, one control. Its value is the voice setting, which Settings
// and the speech bar read and write too (goal 4.6); this holds none.
import { Pressable, StyleSheet } from "react-native";

import { SwitchLook } from "../../../ui/Switch.tsx";
import { Text } from "../../../ui/Text.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";

export function Switch({ testID, label, on, onChange }: { testID: string; label: string; on: boolean; onChange(on: boolean): void }) {
  return (
    <Pressable {...tid(testID, { on })} role="switch" aria-checked={on} accessibilityRole="switch" accessibilityLabel={label} accessibilityState={{ checked: on }}
      onPress={() => onChange(!on)} hitSlop={6} style={[styles.row, webStyle({ cursor: "pointer" })]}>
      <SwitchLook on={on} testID={`${testID}-track`} knobTestID={`${testID}-knob`} />
      <Text size={12.5}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 7 },
});
