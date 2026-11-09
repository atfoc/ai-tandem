// The small parts of Settings › Claude accounts: a chip (a small rounded pill in a tone of the theme: green ok, grey muted, amber warn,
// red danger, the words core's), a row of chips that wraps, a labelled text field in the app's form style, and the sizes that differ
// between the phone (17 pt controls, 44 pt targets: ux-improvements goal 3.1.1) and the wide layouts (today's 13 px dialogs).
import { useState, type ReactNode } from "react";
import { Platform, StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import type { Chip as ChipWords, ChipTone } from "@aiwb/core/logic/aliases.ts";

import { Button, type ButtonProps } from "../../../ui/Button.tsx";
import { TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid, type DataSet } from "../../../ui/tid.ts";
import type { Tokens } from "../../../ui/tokens.ts";
import { usePhone } from "../../../ui/useLayout.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { ACCOUNTS_TID } from "./ids.ts";

/** The sizes of the layout: the name, the lines, a button's size. */
export function useSizes() {
  const phone = usePhone();
  return { phone, name: phone ? TYPE.control : 13, line: phone ? TYPE.secondary : 12, button: (phone ? "touch" : "sm") as ButtonProps["size"] };
}

const ink = (t: Tokens, tone: ChipTone) => (tone === "ok" ? t.okText : tone === "warn" ? t.warnText : tone === "danger" ? t.danger : t.muted);
const edge = (t: Tokens, tone: ChipTone) => (tone === "ok" ? t.ok : tone === "warn" ? t.warn : tone === "danger" ? t.danger : t.line2);
const fill = (t: Tokens, tone: ChipTone) => (tone === "warn" ? t.warnSoft : tone === "danger" ? t.dangerSoft : "transparent");

/** A chip: its words in its tone, in a pill. `id` names it for a check (login, running, stopped, docker, restart, default, pending). */
export function Chip({ chip, id, testID = ACCOUNTS_TID.chip }: { chip: ChipWords; id: string; testID?: string }) {
  const t = useTokens(), { phone } = useSizes();
  return (
    <View {...tid(testID, { chip: id, tone: chip.tone })} accessible accessibilityLabel={chip.text}
      style={[styles.chip, { borderColor: edge(t, chip.tone), backgroundColor: fill(t, chip.tone) }]}>
      <Text size={phone ? TYPE.secondary : 11.5} style={{ color: ink(t, chip.tone) }} numberOfLines={2}>{chip.text}</Text>
    </View>
  );
}

/** Chips side by side, wrapping onto the next line where the row is narrow. */
export const Chips = ({ children }: { children: ReactNode }) => <View style={styles.chips}>{children}</View>;

/** Buttons side by side, wrapping. */
export const Actions = ({ children }: { children: ReactNode }) => <View style={styles.actions}>{children}</View>;

/** A labelled text field in the app's form style (the Servers form's): the label above, the box, a hint under it. */
export function Field({ label, hint, testID, data, ...input }: { label: string; hint?: string; testID: string; data?: DataSet } & TextInputProps) {
  const t = useTokens(), { phone } = useSizes();
  const [focus, setFocus] = useState(false);
  return (
    <View style={styles.field}>
      <Text size={phone ? TYPE.secondary : 12} tone="muted">{label}</Text>
      <TextInput {...input} {...tid(testID, data)} accessibilityLabel={label} aria-label={label} placeholderTextColor={t.faint}
        autoComplete="off" autoCorrect={false} spellCheck={false}
        onFocus={(e) => { setFocus(true); input.onFocus?.(e); }} onBlur={(e) => { setFocus(false); input.onBlur?.(e); }}
        style={[styles.input, phone && styles.inputPhone, { color: t.text, backgroundColor: t.bg, borderColor: focus ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as object]} />
      {hint ? <Text size={phone ? TYPE.secondary : 12} tone="muted">{hint}</Text> : null}
    </View>
  );
}

/** A line of muted small print. */
export function Line({ children, testID, tone = "muted", data }: { children: ReactNode; testID?: string; tone?: "muted" | "warn" | "danger"; data?: DataSet }) {
  const t = useTokens(), { line } = useSizes();
  return <Text {...(testID ? tid(testID, data) : {})} selectable size={line} style={{ color: tone === "warn" ? t.warnText : tone === "danger" ? t.danger : t.muted }}>{children}</Text>;
}

/** A button of an account: the layout's size; on the phone no hover title (goal 3.1.3: the reason is in the row's words). */
export function ActionButton({ title, ...p }: ButtonProps) {
  const { phone, button } = useSizes();
  return <Button size={button} {...p} {...(!phone && title ? { title } : {})} {...(phone && title && p.disabled ? { accessibilityLabel: `${p.label}, ${title}` } : {})} />;
}

const styles = StyleSheet.create({
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: Platform.OS === "web" ? 1 : 2, maxWidth: "100%" },
  chips: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 4 },
  actions: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, marginTop: 8 },
  field: { marginTop: 10, gap: 3 },
  input: { fontSize: 13, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  inputPhone: { fontSize: TYPE.control, minHeight: 44, borderRadius: 10, paddingHorizontal: 12 },
});
