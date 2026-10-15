// The field a message's label is typed into, in the thread and in the tree popup (the old page's fork/LabelInput.tsx; B-LB-01): one line, 200
// characters at most, the placeholder says that an empty label removes it. Enter and leaving the field give the value, Esc gives null.
import { useRef, useState } from "react";
import { StyleSheet, TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextStyle } from "react-native";

import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useEscLayer } from "../../ui/useEscLayer";
import { webStyle } from "../../ui/webstyle.ts";

export const LABEL_PLACEHOLDER = "Label (empty removes it)";
export const LABEL_MAX = 200;

export function LabelInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const t = useTokens();
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => { if (!done.current) { done.current = true; onDone(x); } };
  useEscLayer(true, () => finish(null)); // (web: in the order of the overlays: the tree popup it lies in is under it, so one Esc ends the field and the popup stays)
  const key = (e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    if (e.nativeEvent.key === "Escape") finish(null);
  };
  return (
    <TextInput autoFocus {...tid("fk-label-input")} value={v} maxLength={LABEL_MAX} placeholder={LABEL_PLACEHOLDER} placeholderTextColor={t.faint}
      accessibilityLabel="Label" returnKeyType="done" blurOnSubmit onChangeText={setV}
      onBlur={() => finish(v)} onSubmitEditing={() => finish(v)} onKeyPress={key}
      style={[styles.input, { color: t.text, backgroundColor: t.bg, borderColor: t.accent }, webStyle({ outlineStyle: "none" }) as TextStyle | undefined]} />
  );
}

const styles = StyleSheet.create({
  input: { flex: 1, minWidth: 0, fontSize: 12, borderWidth: 1, borderRadius: 5, paddingVertical: 1, paddingHorizontal: 6 },
});
