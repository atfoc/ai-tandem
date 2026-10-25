// The parts of the add flow's P3 (goal 3.8.3, mockups dl-04c to dl-04e): a card of rows with a caption over each value, the notices (green,
// blue), and the full-width buttons. The card is the kit's group drawn here, because the kit's `Cell` has no editable value or caption over a
// mono line. Fields are 17 pt with 44 pt targets (metrics.ts). Everything another server said is drawn as `Text`.
import { Children, useRef, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View, type TextInputProps } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { MONO } from "../../../ui/fonts.ts";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { SecretInput } from "../../../ui/SecretInput.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { webStyle } from "../../../ui/webstyle.ts";
import { faint } from "../facts/parts.tsx";
import { S2_TID } from "../ids.ts";

/** A group: a muted upper-case caption, a card of rows with a hairline between them, a footer under it. */
export function Card({ title, footer, children, testID }: { title?: string; footer?: ReactNode; children: ReactNode; testID?: string }) {
  const t = useTokens(), rows = Children.toArray(children);
  return (
    <View {...(testID ? tid(testID) : null)} style={styles.group}>
      {title ? <Text size={TYPE.secondary} tone="muted" style={styles.caps} accessibilityRole="header">{title}</Text> : null}
      <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
        {rows.map((r, i) => (
          <View key={i}>
            {r}
            {i < rows.length - 1 ? <View pointerEvents="none" style={[styles.rule, { backgroundColor: t.line }]} /> : null}
          </View>
        ))}
      </View>
      {footer ? <Text selectable size={TYPE.secondary} tone="muted">{footer}</Text> : null}
    </View>
  );
}

/** A row's frame: 48 pt at least, the margins. */
export function Row({ children, style }: { children: ReactNode; style?: object }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

/** A caption over a value in the mono type (an address), with something at the right. */
export function FactRow({ caption, text, trailing, testID, mono = true }: { caption: string; text: string; trailing?: ReactNode; testID?: string; mono?: boolean }) {
  return (
    <Row>
      <View {...(testID ? tid(testID) : null)} style={styles.words} accessible accessibilityLabel={`${caption}, ${text}`}>
        <Text size={TYPE.secondary} tone="muted">{caption}</Text>
        <Text selectable size={TYPE.control} mono={mono} style={mono ? styles.mono : undefined} numberOfLines={2}>{text}</Text>
      </View>
      {trailing}
    </Row>
  );
}

/** A caption over a text box (17 pt, a 44 pt target): a field of the form. `field` names it for the checks (the dataSet on the web; a device has
 *  no dataSet, so its testID carries the name). */
export function FieldRow({ caption, field, secret, trailing, multiline, ...input }: { caption: string; field: string; secret?: boolean; trailing?: ReactNode } & TextInputProps) {
  const t = useTokens();
  const ref = useRef<TextInput>(null);
  const props = {
    ...input, multiline, ...tid(WEB ? S2_TID.addField : `${S2_TID.addField}-${field}`, { field }), accessibilityLabel: caption, "aria-label": caption, placeholderTextColor: t.faint,
    style: [styles.input, multiline && styles.multiline, { color: t.text }, secret || field === "address" ? styles.mono : null, webStyle({ outlineStyle: "none" }) as object],
  };
  return (
    <Pressable accessible={false} onPress={() => ref.current?.focus()} style={[styles.row, styles.fieldRow]}>
      <View style={styles.words}>
        <Text size={TYPE.secondary} tone="muted">{caption}</Text>
        {secret ? <SecretInput {...props} /> : <TextInput {...props} ref={ref} />}
      </View>
      {trailing}
    </Pressable>
  );
}
const WEB = Platform.OS === "web";

/** What a box of this form is not: a login. No content type, no autofill, no capitals or corrections. */
export const PLAIN = { autoComplete: "off", textContentType: "none", importantForAutofill: "no", autoCapitalize: "none", autoCorrect: false, spellCheck: false } as const satisfies TextInputProps;
export const SECRET = { ...PLAIN, secret: true } as const;

/** A notice in a tinted box: green (what the code filled in) or blue (what iOS will ask). */
export function Notice({ tone, children, testID, title }: { tone: "ok" | "info"; children: ReactNode; testID?: string; title?: string }) {
  const t = useTokens();
  const ink = tone === "ok" ? t.ok : t.viz1;
  return (
    <View {...(testID ? tid(testID) : null)} accessibilityRole="alert" style={[styles.notice, { backgroundColor: faint(ink), borderColor: ink }]}>
      {title ? <Text size={TYPE.secondary + 1} weight="600" style={{ color: ink }}>{title}</Text> : null}
      <Text selectable size={TYPE.secondary + 1} style={{ color: tone === "ok" ? t.ok : t.text }}>{children}</Text>
    </View>
  );
}

/** A full-width button of 50 pt: `soft` (the accent's tint, "Test connection"), `primary` (the accent's fill, "Trust and save") or `grey` ("Cancel"). */
export function Block({ label, onPress, testID, tone, disabled }: { label: string; onPress(): void; testID: string; tone: "soft" | "primary" | "grey"; disabled?: boolean }) {
  const t = useTokens();
  const fill = tone === "primary" ? t.accentFill : tone === "soft" ? t.accentSoft : t.panel;
  const ink = tone === "primary" ? "onAccent" : tone === "soft" ? "accent" : "text";
  return (
    <Pressable {...tid(testID)} disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }: { pressed: boolean }) => [styles.block, { backgroundColor: fill }, pressed && { opacity: 0.8 }, disabled && styles.off, webStyle({ cursor: disabled ? "default" : "pointer" })]}>
      <Text size={TYPE.control} tone={disabled && tone === "soft" ? "muted" : ink}>{label}</Text>
    </Pressable>
  );
}

/** The green square with a tick that heads a passed test. */
export function TickTile() {
  const t = useTokens();
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.tick, { backgroundColor: t.ok }]}>
      <Svg width={18} height={18} viewBox="0 0 18 18" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><Path d="M4 9.5l3.4 3.4L14 5.5" /></Svg>
    </View>
  );
}

/** A caption's pencil: the field can be edited. */
export const PencilMark = ({ color }: { color: string }) => (
  <Svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round"><Path d="M11 2.5l2.5 2.5L6 12.5 3 13l.5-3z" /></Svg>
);

/** The icons of the "Choose how" rows (24 pt slots). */
export const QrMark = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round">
    <Rect x="3" y="3" width="6" height="6" rx="1" /><Rect x="13" y="3" width="6" height="6" rx="1" /><Rect x="3" y="13" width="6" height="6" rx="1" />
    <Path d="M13 13h2.5v2.5H13zM17 17h2v2h-2zM17 13h2" />
  </Svg>
);
export const ClipMark = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
    <Rect x="4.5" y="4.5" width="13" height="14.5" rx="2" /><Path d="M8 4.5V3.5h6v1M8 10h6M8 13.5h4" />
  </Svg>
);
export const TypeMark = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round">
    <Path d="M15 3.5l3.5 3.5L8 17.5 3.5 18.5 4.5 14z" />
  </Svg>
);
/** Two stacked bars: the server, in the head of "Choose how" (the sheet draws the tile around it). */
export const ServerMark = ({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4}>
    <Rect x="2.5" y="2.5" width="11" height="4.5" rx="1" /><Rect x="2.5" y="9" width="11" height="4.5" rx="1" />
    <Path d="M5 4.75h.01M5 11.25h.01" strokeWidth={1.8} strokeLinecap="round" />
  </Svg>
);
export const HelpMark =({ color }: { color: string }) => (
  <Svg width={22} height={22} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M11 19.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM8.6 8.6a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .8-1 1.5M11 15.2v.1" />
  </Svg>
);

const styles = StyleSheet.create({
  group: { gap: 6, marginHorizontal: PHONE.margin, marginBottom: 20 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  rule: { position: "absolute", left: PHONE.margin, right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  row: { minHeight: PHONE.cell + 8, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  fieldRow: { paddingVertical: 4 },
  words: { flex: 1, minWidth: 0 },
  mono: { fontFamily: MONO },
  input: { fontSize: TYPE.control, minHeight: PHONE.target, paddingVertical: 4, paddingHorizontal: 0 },
  multiline: { minHeight: 110, textAlignVertical: "top" },
  notice: { marginHorizontal: PHONE.margin, marginBottom: 20, padding: 12, borderRadius: 10, borderWidth: 1, gap: 4 },
  block: { marginHorizontal: PHONE.margin, marginBottom: 12, minHeight: PHONE.sheetRow, alignItems: "center", justifyContent: "center", borderRadius: 10, paddingHorizontal: 16 },
  off: { opacity: 0.5 },
  tick: { width: 36, height: 36, borderRadius: 8, alignItems: "center", justifyContent: "center" },
});
