// The references of the phone's message as chips (B2, b2-design §4), drawn in the context row right after the board chip: one 34-point chip
// each, accent-soft ground, an icon, the words of reflabels.ts on one line and a × (a 44-point target) that takes it out of the message.
import { Pressable, StyleSheet, View } from "react-native";

import type { Ref } from "@aiwb/core/logic/refs.ts";

import { PHONE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { CloseIcon, PointIcon, SelectionIcon } from "../composer/phone/icons.tsx";
import { pointChipText, selectionChipText } from "./reflabels.ts";

const CHIP = 34;

export type RefChipsProps = {
  refs: Ref[];
  onRemove(i: number): void;
  /** The box takes no change: the chips stay, with no ×. */
  readOnly?: boolean;
};

export function RefChips({ refs, onRemove, readOnly }: RefChipsProps) {
  return <>{refs.map((r, i) => <RefChip key={i} r={r} i={i} readOnly={readOnly} onRemove={() => onRemove(i)} />)}</>;
}

function RefChip({ r, i, readOnly, onRemove }: { r: Ref; i: number; readOnly?: boolean; onRemove(): void }) {
  const { tokens: t } = useTheme();
  const ref = useControlRef(undefined, false, true);
  const point = r.kind === "point";
  const text = point ? pointChipText(r) : selectionChipText(r);
  const Icon = point ? PointIcon : SelectionIcon;
  return (
    <View {...tid("ctx-chip", { kind: r.kind, i })} accessibilityLabel={text} style={[styles.chip, readOnly && styles.last, { backgroundColor: t.accentSoft }]}>
      <Icon size={16} color={t.accent} />
      <Text size={15} weight="600" tone="accent" numberOfLines={1} style={styles.name}>{text}</Text>
      {readOnly ? null : (
        <Pressable ref={ref} {...tid("ctx-chip-remove")} role="button" accessibilityLabel={point ? "Remove the point from the message" : "Remove the selection from the message"}
          onPress={onRemove} hitSlop={{ top: (PHONE.target - CHIP) / 2, bottom: (PHONE.target - CHIP) / 2, left: 10, right: 10 }}
          style={[styles.remove, webStyle({ cursor: "pointer" })]}>
          <CloseIcon size={12} color={t.accent} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { height: CHIP, flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 8, paddingLeft: 10, paddingRight: 4, flexShrink: 0, maxWidth: 260 },
  last: { paddingRight: 10 },
  name: { flexShrink: 1 },
  remove: { width: 24, height: CHIP, alignItems: "center", justifyContent: "center" },
});
