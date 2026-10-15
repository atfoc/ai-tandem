// The small parts the Servers dialog is made of (the old page's Servers.tsx and servers.css): a line of the muted type, a fingerprint, a test's
// answer, a text field and a check box. Everything another server said is drawn as `Text`: never as markup.
import { useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import { SecretInput } from "../../ui/SecretInput.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { MONO } from "../../ui/fonts.ts";
import { webStyle } from "../../ui/webstyle.ts";

export const said = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const texts = (xs: unknown): string[] => (Array.isArray(xs) ? xs.map(String) : []);

/** A line of a row or a block (.servers-line): 12 px, muted, wrapping anywhere, selectable. */
export function Line({ children, testID = "servers-line", mono }: { children: ReactNode; testID?: string; mono?: boolean }) {
  return <Text {...tid(testID)} selectable size={mono ? 11 : 12} mono={mono} tone="muted" style={styles.line}>{children}</Text>;
}

/** A fingerprint inside a line (.servers-fp): monospace, the text's own colour, broken anywhere. */
export function Fp({ children }: { children: string }) {
  return <Text {...tid("servers-fp")} selectable size={11} mono style={styles.fp}>{children}</Text>;
}

/** A line with a label and a fingerprint after it ("Accepted before AB:…"). */
export function FpLine({ label, fp }: { label: string; fp: string }) {
  return <Line>{label} <Fp>{fp}</Fp></Line>;
}

/** A test's answer, as plain text. step = the line of the step a failed test stopped at; accept = the fingerprint to compare;
 *  pinned = the one held so far. */
export function Result({ ok, message, step, detail, version, agents, accept, pinned }: {
  ok: boolean; message?: string; step?: string; detail?: string; version?: string; agents?: unknown; accept?: string; pinned?: string;
}) {
  const { tokens: t } = useTheme();
  const list = texts(agents);
  if (!message && !detail && !accept) return null;
  return (
    <View {...tid("servers-result", { ok })} role="status" style={[styles.result, { backgroundColor: t.panel, borderColor: t.line }]}>
      {message ? <Text {...tid("servers-result-msg")} selectable size={12} weight="600" tone={ok ? "ok" : "danger"}>{message}</Text> : null}
      {step ? <Line testID="servers-step">{step}</Line> : null}
      {detail ? <Line>{detail}</Line> : null}
      {version ? <Line>Version {version}</Line> : null}
      {list.length > 0 ? <Line>Agents: {list.join(", ")}</Line> : null}
      {pinned ? <FpLine label="Accepted before" fp={pinned} /> : null}
      {accept ? <FpLine label={pinned ? "Presented now" : "Fingerprint"} fp={accept} /> : null}
    </View>
  );
}

/** What no box of the Servers form is: a login. A name or an address next to a secret box must not look like a user name to the system (iOS
 *  offers to save a password for a user name and a secret box; Android's autofill service offers too): no content type, no autofill. */
export const PLAIN_INPUT = { autoComplete: "off", textContentType: "none", importantForAutofill: "no" } as const satisfies TextInputProps;

/** The secret box (`Field`'s `secret`): hidden as typed (ui/SecretInput.tsx: on iOS a box of our own, since there every hidden box is offered to the
 *  keychain as a password), and with autofill off for Android's autofill service and the web's password managers. */
export const SECRET_INPUT = {
  secret: true, autoComplete: "off", textContentType: "none", importantForAutofill: "no",
  autoCapitalize: "none", autoCorrect: false, spellCheck: false,
} as const satisfies TextInputProps & { secret: boolean };

/** A labelled text field (.servers-field). `field` names it for the checks (`dataSet` on the web, where the testID is the one name `servers-input`; a
 *  device has no `dataSet`, and Maestro tells the boxes apart by testID alone, so there it is `servers-input-<field>`: name, address, secret, code). */
export function Field({ label, field, secret, ...input }: { label: string; field: string; secret?: boolean } & TextInputProps) {
  const { tokens: t } = useTheme();
  const [focus, setFocus] = useState(false);
  const Input = secret ? SecretInput : TextInput;
  return (
    <View style={styles.field}>
      <Text size={12} tone="muted">{label}</Text>
      <Input {...input} {...tid(Platform.OS === "web" ? "servers-input" : `servers-input-${field}`, { field })} accessibilityLabel={label} aria-label={label}
        placeholderTextColor={t.faint} onFocus={(e) => { setFocus(true); input.onFocus?.(e); }} onBlur={(e) => { setFocus(false); input.onBlur?.(e); }}
        style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: focus ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as object]} />
    </View>
  );
}

/** A check box with its words (.servers-check): a role of `checkbox` and its state, `aria-checked`. */
export function Check({ label, value, onChange, testID }: { label: string; value: boolean; onChange(v: boolean): void; testID: string }) {
  const { tokens: t } = useTheme();
  return (
    <Pressable {...tid(testID)} role="checkbox" aria-checked={value} accessibilityState={{ checked: value }} accessibilityLabel={label}
      onPress={() => onChange(!value)} style={[styles.check, webStyle({ cursor: "pointer" })]}>
      <View style={[styles.box, { borderColor: value ? t.accentFill : t.line2, backgroundColor: value ? t.accentFill : t.bg }]}>
        {value ? <Text size={10} tone="onAccent" style={styles.tick}>✓</Text> : null}
      </View>
      <Text size={12}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: { marginTop: 3 },
  fp: { fontFamily: MONO },
  result: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1 },
  field: { marginTop: 10 },
  input: { marginTop: 3, fontSize: 13, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  check: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10, alignSelf: "flex-start" },
  box: { width: 14, height: 14, borderWidth: 1, borderRadius: 3, alignItems: "center", justifyContent: "center" },
  tick: { lineHeight: 12 },
});
