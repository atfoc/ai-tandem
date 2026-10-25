// The small parts both popups are made of (the old page's Library.tsx and library.css): a prompt as a list shows it, the icons of the tree's rows, and the
// search field of either popup.
import { Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import type { Hit } from "@aiwb/core/logic/libraryview.ts";

import { PHONE, TYPE } from "../../ui/metrics.ts";
import { BASE_SIZE, Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";

/** The mark of a library whose server is not connected: a dot and the words, as the rows of both popups have it. */
export function OffMark({ size = 11 }: { size?: number }) {
  const t = useTokens();
  return (
    <View {...tid("lib-off")} style={styles.off}>
      <View style={[styles.offDot, { backgroundColor: t.warn }]} />
      <Text size={size} tone="muted" numberOfLines={1}>not connected</Text>
    </View>
  );
}

/** A prompt as a list shows it: its path, its name, and whether its server is not connected. Plain text, whatever the library says. */
export function PromptLine({ h }: { h: Hit }) {
  return (
    <>
      <Text numberOfLines={1} style={styles.line}>
        {h.path ? <Text {...tid("lib-path")} tone="muted">{h.path}/</Text> : null}
        <Text {...tid("lib-pname")}>{h.prompt.name}</Text>
      </Text>
      {h.off ? <OffMark /> : null}
    </>
  );
}

export function PromptIcon({ color }: { color?: string }) {
  const t = useTokens();
  return (
    <Svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke={color ?? t.muted} strokeWidth={1.5} strokeLinecap="round"><Path d="M3 4h10M3 8h10M3 12h6" /></Svg>
  );
}

export function ServerIcon({ color }: { color?: string }) {
  const t = useTokens();
  return (
    <Svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke={color ?? t.muted} strokeWidth={1.5}><Rect x={2} y={2.5} width={12} height={4.5} rx={1} /><Rect x={2} y={9} width={12} height={4.5} rx={1} /></Svg>
  );
}

/** The search field of a popup (`.menu-search-input`), with its clearing button when `clearable` and something is typed. `phone`: the phone's field (a 44 pt box, 17 pt text at `size`, a 44 pt clearing target). */
export function SearchField({ ref, testID, value, onChange, onKeyPress, onSubmit, controls, active, clearTestID, onClear, autoFocus, size = 12.5, phone, ...rest }: {
  ref?: React.Ref<TextInput>; testID: string; value: string; onChange: (v: string) => void; onKeyPress?: (e: { nativeEvent: { key: string }; preventDefault(): void }) => void;
  onSubmit?: () => void; controls?: string; active?: string; clearTestID?: string; onClear?: () => void; autoFocus?: boolean; size?: number; combobox?: boolean; onFocus?: () => void; onBlur?: () => void; phone?: boolean;
}) {
  const t = useTokens();
  const { combobox, ...more } = rest;
  return (
    <View style={styles.search}>
      <TextInput ref={ref} testID={testID} autoFocus={autoFocus} value={value} onChangeText={onChange} placeholder="Search prompts" placeholderTextColor={t.faint}
        accessibilityLabel="Search prompts" autoCorrect={false} autoCapitalize="none" spellCheck={false} onKeyPress={onKeyPress as never} onSubmitEditing={onSubmit}
        {...(combobox ? { role: "combobox", "aria-expanded": true, "aria-autocomplete": "list", "aria-controls": controls, "aria-activedescendant": active } as object : {})} {...more}
        style={[styles.field, phone ? [styles.fieldPhone, { backgroundColor: t.panel, borderColor: t.panel }] : { backgroundColor: t.bg, borderColor: t.line2 }, { color: t.text, fontSize: size }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
      {onClear && value ? <ClearButton testID={clearTestID ?? "lib-search-clear"} onPress={onClear} phone={phone} /> : null}
    </View>
  );
}

function ClearButton({ testID, onPress, phone }: { testID: string; onPress(): void; phone?: boolean }) {
  const ref = useControlRef("Clear search");
  const t = useTokens();
  return (
    <Pressable ref={ref} testID={testID} role="button" accessibilityLabel="Clear search" onPress={onPress} focusable={false} tabIndex={-1} style={phone ? styles.clearPhone : styles.clear}>
      <Text size={phone ? TYPE.control : 14} style={{ color: t.faint }}>{phone ? "✕" : "×"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  line: { flex: 1, minWidth: 0 },
  off: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 },
  offDot: { width: 6, height: 6, borderRadius: 3 },
  search: { flexDirection: "row", alignItems: "center", gap: 4 },
  field: { flex: 1, minWidth: 0, borderWidth: 1, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 9, lineHeight: BASE_SIZE + 2 },
  fieldPhone: { minHeight: PHONE.target, borderRadius: 10, paddingVertical: 0, paddingHorizontal: 12, lineHeight: 22 },
  clearPhone: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" },
  clear: { width: 22, height: 22, alignItems: "center", justifyContent: "center", borderRadius: 5 },
});
