// P5, the pushed list screen's body (ux-improvements goal 3.1.4): grouped cards of 48 pt cells with values and chevrons. The screen
// around it (its bar with the back naming the previous screen and a centred title) is a pushed screen of the phone's stack
// (screens/shell/screens.ts) with a PlaceBar (Bars.tsx).
//
// A group is a card (radius 10, the ground `bg` on a page of `panel`, with a hairline border for the themes where the two are one
// colour). A hairline `line` separates its cells, inset to where the cell's words begin (not under a leading icon) and left out
// after the last. A cell pushes when it has an `onPress`: it then has a chevron, and its pressed state is `hover2`.
//
// Contract of package F1 (plans/ux-improvements/PLAN.md).
import { Children, createContext, useContext, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import type { WordTone } from "@aiwb/core/logic/statewords.ts";

import { DisclosureChevron } from "./icons.tsx";
import { PHONE, TYPE } from "./metrics.ts";
import { wordColour } from "./StateWord.tsx";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";

/** Whether the cell being drawn is followed by another in its card: the group tells each cell, so the last has no separator. */
const Followed = createContext(false);

export function CellGroup({ title, footer, children, testID = TID.cellGroup }: { title?: string; footer?: string; children: ReactNode; testID?: string }) {
  const t = useTokens(), cells = Children.toArray(children);
  return (
    <View {...tid(testID)} style={styles.group}>
      {title ? <Text size={TYPE.secondary} tone="muted" style={styles.caps} accessibilityRole="header">{title}</Text> : null}
      <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
        {cells.map((cell, i) => <Followed.Provider key={i} value={i < cells.length - 1}>{cell}</Followed.Provider>)}
      </View>
      {footer ? <Text size={TYPE.secondary} tone="muted">{footer}</Text> : null}
    </View>
  );
}

export type CellProps = {
  label: string;
  /** A second line under the label (a state word's text, a count). */
  sub?: string;
  subTone?: WordTone;
  /** At the right, before the chevron. */
  value?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** A pushing cell has a chevron; a cell with no onPress is a plain fact. */
  onPress?(): void;
  chevron?: boolean;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
  testID?: string;
  /** The dataSet a check reads (`{ row: "servers" }`). */
  data?: Record<string, string>;
};

export function Cell({ label, sub, subTone, value, leading, trailing, onPress, chevron = !!onPress, tone = "default", disabled, testID = TID.cell, data }: CellProps) {
  const t = useTokens(), followed = useContext(Followed);
  // where the words begin, for the separator to start there (the card's padding until the cell is measured)
  const [wordsX, setWordsX] = useState<number>(PHONE.margin);
  const spoken = [label, value, sub].filter(Boolean).join(", ");
  // A cell that does nothing itself but holds a control (a switch at the right) is neither disabled nor one element for a screen reader:
  // its control stays reachable and enabled (aria-disabled would pass to it).
  const holds = !onPress && !!trailing;
  return (
    <Pressable {...tid(testID, data)} disabled={!!disabled || (!onPress && !holds)} onPress={onPress} accessibilityRole={onPress ? "button" : undefined}
      accessible={holds ? false : undefined} accessibilityLabel={holds ? undefined : spoken} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }: { pressed: boolean }) => [styles.cell, pressed && { backgroundColor: t.hover2 }, disabled && styles.off]}>
      {leading}
      <View onLayout={(e) => setWordsX(e.nativeEvent.layout.x)} style={styles.words}>
        <Text size={TYPE.control} tone={tone === "danger" ? "danger" : tone === "accent" ? "accent" : "text"} numberOfLines={2}>{label}</Text>
        {sub ? <Text size={TYPE.secondary} style={{ color: subTone ? wordColour(t, subTone) : t.muted }}>{sub}</Text> : null}
      </View>
      {value ? <Text {...tid(TID.cellValue)} size={TYPE.control} tone="muted" numberOfLines={1} style={styles.value}>{value}</Text> : null}
      {trailing}
      {chevron ? <DisclosureChevron color={t.faint} /> : null}
      {followed ? <View {...tid(TID.cellSeparator)} pointerEvents="none" style={[styles.separator, { left: wordsX, backgroundColor: t.line }]} /> : null}
    </Pressable>
  );
}

/** A cell whose control is wider than a trailing one (a slider): the label on the first line, the control under it at the full width of the
 *  cell. The paddings, the minimum height and the separator are `Cell`'s; the cell itself is not pressable (its control is). */
export function ControlCell({ label, children, testID = TID.cell }: { label: string; children: ReactNode; testID?: string }) {
  const followed = useContext(Followed), t = useTokens();
  return (
    <View {...tid(testID)} style={styles.controlCell}>
      <Text size={TYPE.control} numberOfLines={2}>{label}</Text>
      {children}
      {followed ? <View {...tid(TID.cellSeparator)} pointerEvents="none" style={[styles.separator, { left: PHONE.margin, backgroundColor: t.line }]} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: 6, marginHorizontal: PHONE.margin, marginBottom: 20 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  cell: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingVertical: 6 },
  controlCell: { minHeight: PHONE.cell, gap: 2, paddingHorizontal: PHONE.margin, paddingTop: 10, paddingBottom: 6 },
  words: { flex: 1, minWidth: 0 },
  value: { flexShrink: 1, maxWidth: "50%" },
  separator: { position: "absolute", right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  off: { opacity: 0.5 },
});
