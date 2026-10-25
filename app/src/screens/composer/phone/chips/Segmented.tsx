// A segmented control of the phone's pickers (ux-improvements goal 3.6, mockup "03 The pickers" co-03a effort, co-03c depth and running at
// once): one value of a few, side by side in a 44-point track; the chosen segment is raised on the track. Each segment's target is the
// track's full height. Disabled (depth Off greys running at once): faded, and it takes no press. A radio group for a screen reader.
import { Pressable, StyleSheet, View } from "react-native";

import { PHONE } from "../../../../ui/metrics.ts";
import { Text } from "../../../../ui/Text.tsx";
import { useTheme } from "../../../../ui/theme.tsx";
import { tid, type DataSet } from "../../../../ui/tid.ts";
import { webStyle } from "../../../../ui/webstyle.ts";
import { C2_IDS } from "./ids.ts";

export type Segment<T extends string | number> = { value: T; label: string; accessibilityLabel?: string };

export type SegmentedProps<T extends string | number> = {
  /** The group's name for a screen reader ("Effort", "Depth", "Running at once"). */
  label: string;
  options: Segment<T>[];
  value: T | null;
  onChange(value: T): void;
  disabled?: boolean;
  testID?: string;
  data?: DataSet;
  /** testID of each segment (dataSet `value`, `on` and `segData`). */
  segmentTestID?: string;
  segData?: DataSet;
};

export function Segmented<T extends string | number>(p: SegmentedProps<T>) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid(p.testID ?? C2_IDS.segmented, { disabled: !!p.disabled, ...p.data })} role="radiogroup" aria-label={p.label}
      aria-disabled={p.disabled || undefined} style={[styles.track, { backgroundColor: t.hover2, borderColor: t.line }, p.disabled && styles.off]}>
      {p.options.map((o) => {
        const on = o.value === p.value;
        return (
          <Pressable key={String(o.value)} {...tid(p.segmentTestID ?? C2_IDS.segment, { value: String(o.value), on, ...p.segData })} role="radio"
            aria-checked={on} accessibilityLabel={o.accessibilityLabel ?? o.label} accessibilityState={{ checked: on, disabled: !!p.disabled }}
            disabled={p.disabled} onPress={() => { if (!on) p.onChange(o.value); }}
            style={[styles.segment, webStyle({ cursor: p.disabled ? "default" : "pointer" })]}>
            <View style={[styles.face, on && { backgroundColor: t.bg, borderColor: t.line2 }]}>
              <Text size={15} weight={on ? "600" : "400"} numberOfLines={1}>{o.label}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: "row", height: PHONE.target + 2 * StyleSheet.hairlineWidth, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignSelf: "stretch" }, // (inside its border, each segment is 44 pt)
  segment: { flex: 1, minWidth: 0, height: "100%", padding: 3 },
  face: { flex: 1, alignItems: "center", justifyContent: "center", borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: "transparent", paddingHorizontal: 4 },
  off: { opacity: 0.4 },
});
