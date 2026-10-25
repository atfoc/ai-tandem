// The parts Settings > Voice is made of (VC-13): a section as a rounded card, a row with its label, the two-way choice (Auto-send / Tap to
// send), a picker that opens a menu, and a switch. The sentences are voice's (`voice/words.ts`); the components are the app's (Overlay, Menu,
// Button, the foot's switch look).
import { useRef, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Chevron } from "../../ui/icons.tsx";
import { Menu, MenuItem } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { SwitchLook } from "../../ui/Switch.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";

/** One section of the page: a rounded card with its title (and, under it, a line of small print). */
export function Section({ title, note, testID, children }: { title: string; note?: string; testID: string; children: ReactNode }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid(testID)} style={[styles.card, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Text weight="600" accessibilityRole="header">{title}</Text>
      {note ? <Text size={12} tone="muted" style={styles.note}>{note}</Text> : null}
      <View style={styles.cardBody}>{children}</View>
    </View>
  );
}

/** A label on the left and its control on the right; they stack when the row is narrow. `wide`: the control (a slider) always takes the row's
 *  whole width, under the label. */
export function Row({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <View style={styles.row}>
      <Text size={12.5} style={styles.rowLabel}>{label}</Text>
      <View style={wide ? styles.rowWide : styles.rowControl}>{children}</View>
    </View>
  );
}

export type Option<T> = { value: T; label: string };

/** Two or three choices side by side, one on (a radio group). */
export function Choice<T extends string | boolean>({ label, value, options, onChange, testID }: { label: string; value: T; options: Option<T>[]; onChange(v: T): void; testID: string }) {
  const { tokens: t } = useTheme();
  return (
    <View {...tid(testID)} role="radiogroup" aria-label={label} style={[styles.choice, { borderColor: t.line2, backgroundColor: t.bg }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable key={String(o.value)} {...tid(`${testID}-${String(o.value)}`, { value: String(o.value) })} role="radio" aria-checked={on} accessibilityState={{ checked: on }}
            accessibilityLabel={o.label} onPress={() => onChange(o.value)}
            style={[styles.choiceItem, on && { backgroundColor: t.accentFill }, webStyle({ cursor: "pointer" })]}>
            <Text size={12.5} tone={on ? "onAccent" : "text"} weight={on ? "600" : undefined} numberOfLines={1}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A button that shows the choice and opens a menu of them (a popover, a sheet on the phone). */
export function Picker<T extends string | number | null>({ label, value, options, shown, onChange, testID }: {
  label: string; value: T; options: Option<T>[]; shown: string; onChange(v: T): void; testID: string;
}) {
  const { tokens: t } = useTheme();
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  return (
    <View ref={anchor} collapsable={false} style={styles.picker}>
      <Pressable {...tid(testID, { open, value: value === null ? "" : String(value) })} accessibilityRole="button" accessibilityLabel={`${label}: ${shown}`}
        aria-haspopup="menu" aria-expanded={open} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)}
        style={[styles.pick, { borderColor: t.line2, backgroundColor: t.bg }, webStyle({ cursor: "pointer" })]}>
        <Text size={12.5} numberOfLines={1} style={styles.pickText}>{shown}</Text>
        <Text size={9} tone="muted">▾</Text>
      </Pressable>
      {open && (
        <Overlay open onClose={() => setOpen(false)} label={label} kind="popover" anchor={anchor} align="right">
          <Menu label={label} minWidth={170}>
            {options.map((o) => {
              const on = o.value === value;
              return (
                <MenuItem key={String(o.value)} choice selected={on} autoFocus={on} dataSet={{ value: o.value === null ? "" : String(o.value) }} label={o.label}
                  trailing={on ? <Text tone="accent">✓</Text> : null} onPress={() => { onChange(o.value); setOpen(false); }} />
              );
            })}
          </Menu>
        </Overlay>
      )}
    </View>
  );
}

/** A labelled switch (the foot's look). */
export function SwitchRow({ label, on, onChange, testID }: { label: string; on: boolean; onChange(v: boolean): void; testID: string }) {
  return (
    <Pressable {...tid(testID, { on })} role="switch" aria-checked={on} accessibilityState={{ checked: on }} aria-label={label} onPress={() => onChange(!on)}
      style={[styles.switch, webStyle({ cursor: "pointer" })]}>
      <SwitchLook on={on} testID={`${testID}-track`} knobTestID={`${testID}-knob`} />
      <Text size={12.5} style={styles.rowLabel}>{label}</Text>
    </Pressable>
  );
}

/** The chevron of a disclosure: right when closed, down when open. */
export function Disclosure({ open, color }: { open: boolean; color: string }) {
  return <View style={open ? styles.down : undefined}><Chevron color={color} /></View>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, marginTop: 12 },
  note: { marginTop: 2 },
  cardBody: { marginTop: 8, gap: 8 },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", columnGap: 12, rowGap: 6, minHeight: 28 },
  rowLabel: { flexShrink: 1 },
  rowControl: { flexShrink: 0, maxWidth: "100%" },
  rowWide: { flexBasis: "100%" },
  choice: { flexDirection: "row", borderWidth: 1, borderRadius: 8, padding: 2, alignSelf: "flex-start", maxWidth: "100%" },
  choiceItem: { flexShrink: 1, paddingVertical: 4, paddingHorizontal: 12, borderRadius: 6 },
  picker: { alignSelf: "flex-start" },
  pick: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 130, maxWidth: 220, paddingVertical: 4, paddingHorizontal: 10, borderWidth: 1, borderRadius: 6, justifyContent: "space-between" },
  pickText: { flexShrink: 1 },
  switch: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-start", minHeight: 28 },
  down: { transform: [{ rotate: "90deg" }] },
});
