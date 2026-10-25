// The small parts the library's phone sheets share (package S4, chunk 2): the glyphs of the move picker's rows, a labelled one-line field in a card, the line that says what is
// wrong with a name, and the Group row's value line.
import type { ReactNode, Ref } from "react";
import { Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { DisclosureChevron, Folder } from "../../../ui/icons.tsx";
import { webStyle } from "../../../ui/webstyle.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { S4_TID } from "./ids.ts";
import { INDENT } from "./sheetlogic.ts";

/** The glyph of a place in the move picker: the stack of a server's top level, a folder (set in by its depth) for a group. */
export function PlaceGlyph({ top, depth, dim }: { top: boolean; depth: number; dim?: boolean }) {
  const t = useTokens(), colour = dim ? t.faint : t.muted;
  if (top) {
    return (
      <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={colour} strokeWidth={1.5} strokeLinejoin="round">
        <Rect x="2" y="2.5" width="12" height="4.5" rx="1" /><Rect x="2" y="9" width="12" height="4.5" rx="1" /><Path d="M4.5 4.75h.01M4.5 11.25h.01" strokeLinecap="round" />
      </Svg>
    );
  }
  return <View style={{ marginLeft: depth * INDENT }}><Folder size={16} color={colour} /></View>;
}

/** A card holding one labelled field: the label (13 pt) above the field (17 pt). */
export function NameCard({ label, children, last }: { label: string; children: ReactNode; last?: boolean }) {
  const t = useTokens();
  return (
    <View style={[styles.field, { borderBottomColor: last ? "transparent" : t.line }]}>
      <Text size={TYPE.secondary} tone="muted">{label}</Text>
      {children}
    </View>
  );
}

/** What is wrong with a name, under its card, in 13 pt danger. Nothing is drawn for no problem. */
export function Problem({ id, text }: { id: string; text: string }) {
  return text ? <Text {...tid(id)} size={TYPE.secondary} tone="danger" accessibilityRole="alert" style={styles.problem}>{text}</Text> : null;
}

/** The one-line name field of the editor and the group form. */
export function NameInput(p: { testID: string; value: string; onChangeText(v: string): void; readOnly?: boolean; label?: string; placeholder?: string; autoFocus?: boolean; onFocus?(): void; onBlur?(): void; accessoryId?: string; inputRef?: Ref<TextInput> }) {
  const t = useTokens();
  return (
    <TextInput ref={p.inputRef} testID={p.testID} accessibilityLabel={p.label ?? "Name"} value={p.value} onChangeText={p.onChangeText} editable={!p.readOnly}
      placeholder={p.placeholder} placeholderTextColor={t.faint} autoFocus={p.autoFocus} autoCorrect={false} autoCapitalize="sentences" returnKeyType="done" submitBehavior="blurAndSubmit"
      onFocus={p.onFocus} onBlur={p.onBlur} inputAccessoryViewID={p.accessoryId}
      style={[styles.input, { color: t.text }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
  );
}

/** The bar's height; Done is 44 pt inside it. */
export const BAR_HEIGHT = 46;

const styles = StyleSheet.create({
  row: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingVertical: 6 },
  value: { flex: 1, textAlign: "right" },
  off: { opacity: 0.5 },
  bar: { height: BAR_HEIGHT, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: PHONE.margin, borderTopWidth: StyleSheet.hairlineWidth },
  barState: { flexShrink: 1 },
  done: { minWidth: PHONE.target, height: PHONE.target, alignItems: "flex-end", justifyContent: "center", marginLeft: "auto" },
  field: { paddingHorizontal: 16, paddingTop: 4, paddingBottom: 0, gap: 0, borderBottomWidth: StyleSheet.hairlineWidth },
  input: { fontSize: TYPE.control, minHeight: PHONE.target, paddingVertical: 2, paddingHorizontal: 0 },
  problem: { marginTop: -12, marginBottom: 16, marginHorizontal: 20 },
});

/** The bar over the keyboard (06b): at the left "Edited · not saved" while there are unsaved changes, at the right a 44 pt Done that takes the focus away. */
export function KeyboardBar({ dirty, onDone }: { dirty: boolean; onDone(): void }) {
  const t = useTokens();
  return (
    <View {...tid(S4_TID.editorBar)} style={[styles.bar, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Text {...tid(S4_TID.editorBarState)} size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.barState}>{dirty ? "Edited · not saved" : ""}</Text>
      <Pressable {...tid(S4_TID.editorBarDone)} accessibilityRole="button" accessibilityLabel="Done" onPress={onDone} style={styles.done}>
        <Text size={TYPE.control} tone="accent" weight="600">Done</Text>
      </Pressable>
    </View>
  );
}

/** The Group row of the editor and the group form: a Cell's look (label 17, its value at the right, a chevron), but a path too long for one line goes on a second, so the group's own name is always read. */
export function GroupRow({ testID, label, value, onPress, disabled, last }: { testID: string; label: string; value: string; onPress(): void; disabled?: boolean; last?: boolean }) {
  const t = useTokens();
  return (
    <Pressable {...tid(testID)} accessibilityRole="button" accessibilityLabel={`${label}, ${value}`} accessibilityState={{ disabled: !!disabled }} aria-disabled={disabled || undefined}
      disabled={disabled} onPress={onPress} style={({ pressed }: { pressed: boolean }) => [styles.row, pressed && { backgroundColor: t.hover2 }, disabled && styles.off, last && { borderBottomWidth: 0 }]}>
      <Text size={TYPE.control}>{label}</Text>
      <Text size={TYPE.control} tone="muted" numberOfLines={2} style={styles.value}>{value}</Text>
      <DisclosureChevron color={t.faint} />
    </Pressable>
  );
}
