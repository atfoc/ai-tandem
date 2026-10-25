// The search field of the phone (ux-improvements goal 3.3, 3.6, 3.8): 44 pt, 17 pt text (so Safari does not zoom), a clear button,
// and an optional Cancel beside it while it has the focus or holds a word (Home's search moves to the top with Cancel). There is no
// search glyph in ui/icons.tsx, so the box has none: the placeholder says what it is.
//
// Contract of package F1 (plans/ux-improvements/PLAN.md).
import { useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View, type TextStyle } from "react-native";

import { PHONE, TYPE } from "./metrics.ts";
import { Text } from "./Text.tsx";
import { useTokens } from "./theme.tsx";
import { TID, tid } from "./tid.ts";
import { webStyle } from "./webstyle.ts";

export type SearchFieldProps = {
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
  onFocus?(): void;
  /** Shown beside the field while it is in use; a press clears and leaves. */
  onCancel?(): void;
  autoFocus?: boolean;
  testID?: string;
};

export function SearchField({ value, onChangeText, placeholder, onFocus, onCancel, autoFocus, testID = TID.searchField }: SearchFieldProps) {
  const t = useTokens();
  const input = useRef<TextInput>(null);
  const [focused, setFocused] = useState(!!autoFocus);
  // A press on Cancel takes the focus from the box before it ends; the button must not go away under the finger.
  const pressing = useRef(false);
  const showCancel = !!onCancel && (focused || value !== "");
  return (
    <View style={styles.row}>
      <View style={[styles.box, { backgroundColor: t.panel }]}>
        <TextInput {...tid(testID)} ref={input} value={value} onChangeText={onChangeText} placeholder={placeholder} autoFocus={autoFocus}
          onFocus={() => { setFocused(true); onFocus?.(); }} onBlur={() => { if (!pressing.current) setFocused(false); }}
          accessibilityLabel={placeholder} placeholderTextColor={t.faint} returnKeyType="search" autoCorrect={false}
          style={[styles.input, { color: t.text }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
        {value !== "" ? (
          <Pressable {...tid(TID.searchClear)} accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onChangeText("")}
            style={[styles.clear, webStyle({ cursor: "pointer" })]}>
            <Text size={TYPE.control} tone="muted">✕</Text>
          </Pressable>
        ) : null}
      </View>
      {showCancel ? (
        <Pressable {...tid(TID.searchCancel)} accessibilityRole="button" accessibilityLabel="Cancel"
          onPressIn={() => { pressing.current = true; }} onPressOut={() => { pressing.current = false; }}
          onPress={() => { pressing.current = false; onChangeText(""); input.current?.blur(); setFocused(false); onCancel?.(); }}
          style={[styles.cancel, webStyle({ cursor: "pointer" })]}>
          <Text size={TYPE.control} tone="accent">Cancel</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginHorizontal: PHONE.margin },
  box: { flex: 1, flexDirection: "row", alignItems: "center", minHeight: PHONE.target, borderRadius: 10, paddingLeft: 12 },
  input: { flex: 1, minHeight: PHONE.target, fontSize: TYPE.control, paddingVertical: 0 },
  clear: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center" },
  cancel: { minHeight: PHONE.target, minWidth: PHONE.target, paddingLeft: 12, justifyContent: "center" },
});
