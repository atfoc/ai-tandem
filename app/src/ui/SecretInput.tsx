// A text box for a secret (a server's secret): hidden as it is typed, and never a password for the system. Android and the web use the platform's
// own hidden box (`secureTextEntry`) with autofill off. On iOS every hidden box is a password to the system: it offers to save what was typed in
// it, whatever `textContentType` and `autoComplete` say. So there the box is an ordinary text box that shows one bullet per character and keeps the
// real text in `value` (maskededit.ts works out what each edit did to it, and where the caret is after it). The caller's `value` and `onChangeText` are the real text.
// Copying out of the box gives the bullets, not the secret, and that stays: a hidden secret is not copied out, as from a password field (pasting in works).
// `reveal` shows the secret (the caller's eye control sets it): then the box is an ordinary text box with the real text, on every platform, and
// `mono` sets its text in the monospace family (a secret is read character by character).
import { useRef } from "react";
import { Platform, TextInput, type NativeSyntheticEvent, type TextInputProps, type TextInputSelectionChangeEventData } from "react-native";

import { MONO } from "./fonts.ts";
import { applyMaskedEditAt, BULLET, type Sel } from "./maskededit.ts";

export type SecretInputProps = TextInputProps & {
  /** Show the secret as plain text. */
  reveal?: boolean;
  /** Set the text in the monospace family. */
  mono?: boolean;
};

export function SecretInput({ value = "", onChangeText, onSelectionChange, reveal, mono, style, ...rest }: SecretInputProps) {
  const sel = useRef<Sel | null>(null);
  const look = mono ? [style, { fontFamily: MONO }] : style;
  if (reveal) return <TextInput {...rest} style={look} value={value} onChangeText={onChangeText} onSelectionChange={onSelectionChange} secureTextEntry={false} />;
  if (Platform.OS !== "ios") return <TextInput {...rest} style={look} value={value} onChangeText={onChangeText} onSelectionChange={onSelectionChange} secureTextEntry />;
  return (
    <TextInput {...rest} style={look} value={BULLET.repeat(value.length)} secureTextEntry={false} multiline={false}
      onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => { sel.current = e.nativeEvent.selection; onSelectionChange?.(e); }}
      onChangeText={(next) => {
        const edit = applyMaskedEditAt(value, next, sel.current);
        // The box's text is set from outside after each edit; React Native keeps the caret at its distance from the end of the text, which is where an
        // edit at the caret leaves it (checked on a device: typing in the middle goes on in the middle, sheets.yaml). A `selection` prop or a
        // `setSelection` of ours would only race with the next keystroke. What is ours is the selection the next edit is read against, which is the
        // caret this one left until the box reports its own: a second key before that report is read in the right place.
        sel.current = { start: edit.caret, end: edit.caret };
        onChangeText?.(edit.text);
      }} />
  );
}
