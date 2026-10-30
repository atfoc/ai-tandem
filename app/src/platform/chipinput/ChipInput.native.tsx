// The chip input on iOS and Android (AD-61 (a), package K2, from the composer spike): a controlled multiline TextInput whose
// text is given as children, no `value`: each plain run a Text, each chip a nested Text with a background showing its label
// between two no-break spaces; the `selection` prop moves the caret. The document beside it is chipdoc.ts, the state and
// the handlers are ChipDocInput.tsx; the contract is types.ts. No library: react-native-enriched is not used.
//
// What the native box does not do as the web box does (AD-61; for the final report, and K3's to know):
//  - Chips are flat: a nested Text takes a background but no radius, no padding (the no-break spaces are the padding), no
//    dashed square or dot icon (C-RF-14), no hover tooltip (C-RF-05). A chip that falls across the end of a line is drawn
//    broken in two.
//  - A copy out of the box gives the chips' labels (between no-break spaces), not their tags (C-RF-18 holds on the web
//    only): a paste back into the same box gives the chips again (it knows the labels it has drawn; two references with the
//    same label stay text); a paste anywhere else gives the labels. Closing that needs a native text view or a clipboard
//    hook TextInput does not offer.
//  - onKey is given what onKeyPress reports: the characters, Enter, Backspace, with no modifier. A key the owner handles
//    has been taken by the field already: the box takes its change back (a handled Enter's new line is removed). The
//    other keys of a hardware keyboard come through the keys port (AD-73).
//  - With `editing`, Enter keeps the line's indent and goes on with a markdown list (chipdoc.ts enterChange): the field has put
//    the line break in already, so a change that is exactly one "\n" (the soft keyboard's return or a hardware Enter, which
//    React Native does not tell apart) is answered with the document of newlineEdit. A controlled field: one frame may show the
//    bare line break first; on Android an answer that comes after the next keystroke is dropped by the field, and the indent is
//    then lost (never doubled). A paste is never touched. A "\n" put in next to another, with a selection the field reported
//    late, cannot be placed and stays a bare line break. (The selection the field reported before the change is trusted when it
//    fits: a tap's selection event comes long before the next key, and without it an Enter at the end of any line but the last
//    could not keep its indent.)
//  - Tab and Shift+Tab: a hardware Tab comes through the keys port while the box has the focus (takeTab, the aiwb-keys module)
//    and indents or outdents (handle.indent, chipdoc.ts indentChange); the soft keyboard has no Tab, so the composer shows a key
//    row of Outdent and Indent above it (screens/composer/EditKeys.tsx).
//  - No image paste (onImages is web only; K4 takes images through the picker).
//  - A tap on a chip's label puts the platform's caret inside it first (iOS: at the end of the tapped word); the box then
//    moves it to the nearer edge, so a frame with the caret inside a chip is not excluded. On Android the move waits for the
//    double-tap time (NativeField.tapSnapDelay; the document has the edge at once): a sooner move made the second tap of a
//    double tap a tap of its own. On iOS a double tap on a chip is now and then taken as two taps (about one run in five of
//    the device flow; a wait there made it every run): the chip is then not selected, and a second double tap selects it.
//    A double tap selects one word of the label (UIKit and Android alike), which the box widens to the whole chip.
//  - Android: editable={false} disables the view (nothing can be selected), so a read-only box stays editable to the
//    platform with no keyboard and no caret, and refuses every change. An arrow key at either end of the text moves the
//    focus to the next view, as in any Android field.
//  - Checked on the simulator and the emulator (`node app/e2e/run.mjs composer-chips`): the flow in the real composer of a board chat and on the dev gallery, the hardware keys (XCUITest on
//    iOS, adb key events on Android), and on Android Gboard's own typing next to a chip with a suggestion picked. Not
//    verified (by hand, goal 7.5): IME composition of Japanese, Chinese, Korean and dictation; autocorrect replacing a word
//    next to a chip (unit-tested in applyChange; neither keyboard corrected a misspelling in the runs); undo/redo (shake,
//    ⌘Z); dragging the selection handles across a chip; fast typing on a real device (the runs tap keys about twice a
//    second). Each is a place where a field that has its text re-set can fight the platform. The Enter of `editing` with the soft
//    keyboard (the tab kept, the list continued) and the key row (its presses keep the keyboard and the caret) passed on the iPhone
//    simulator (`node app/e2e/run.mjs ux-editkeys`). Not verified on a device: Android, a hardware Enter, the hardware Tab through
//    the keys port, and how often the frame of the bare line break shows.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextInputSelectionChangeEventData } from "react-native";

import { TYPE } from "../../ui/metrics.ts";
import { BASE_SIZE } from "../../ui/Text.tsx";
import { reportRaw, reportState } from "../../dev/chipreport.ts";
import { useTokens } from "../../ui/theme.tsx";
import { onKey, takeTab } from "../keys.native.ts";
import { ChipDocInput, type FieldHandle, type FieldProps } from "./ChipDocInput.tsx";
import type { ChipInputHandle, ChipInputProps } from "./types.ts";

export type { ChipInputHandle, ChipInputProps } from "./types.ts";

const LINE = Math.round(BASE_SIZE * 1.45);
const PHONE_LINE = Math.round(TYPE.control * 1.45);

/** The native field: the runs as the TextInput's children. `phone`: the phone's box (17 pt, one line high to six, then it scrolls inside). */
const makeField = (phone: boolean) => forwardRef<FieldHandle, FieldProps>(function NativeField(
  { runs, selection, rev, onText, onSelection, onKeyPress, onFocusChange, placeholder, editable, readOnly, plain, testID },
  ref,
) {
  const t = useTokens();
  const input = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    blur: () => input.current?.blur(),
  }), []);
  // A refused edit of a field whose document is empty: there is no run to draw anew, so the field is emptied by its command
  // (after the render, when the TextInput knows the field's latest event).
  useEffect(() => { if (rev && !runs.length) input.current?.clear(); }, [rev]);
  // (the attribute that draws nothing, toggled to make React Native send runs it would take as unchanged: FieldProps.rev)
  const nudge = rev % 2 ? { textDecorationColor: "transparent" } : null;
  // A read-only box's text can still be selected and copied (C-RF-25). iOS keeps that with editable={false}; Android's
  // editable={false} disables the view (isEnabled = false), which selects nothing, so there the field stays editable to the
  // platform, with no keyboard and no caret, and the box refuses every change it reports (ChipDocInput restores it).
  const selectableReadOnly = Platform.OS === "android" && readOnly;
  return (
    <TextInput
      ref={input}
      testID={testID}
      accessibilityLabel={testID}
      multiline
      selection={selection}
      editable={editable || selectableReadOnly}
      {...(selectableReadOnly ? { showSoftInputOnFocus: false, caretHidden: true } : {})}
      placeholder={placeholder}
      placeholderTextColor={t.faint}
      onChangeText={onText}
      onSelectionChange={(e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => onSelection(e.nativeEvent.selection)}
      onKeyPress={(e: NativeSyntheticEvent<TextInputKeyPressEventData>) => onKeyPress(e.nativeEvent.key)}
      // (the events go on to the composer's handlers on the box around the field: nothing stops them)
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      {...(plain ? { autoCorrect: false, spellCheck: false, autoCapitalize: "none" as const } : {})}
      style={[styles.field, phone && styles.phone, { color: t.text }]}
    >
      {runs.map((r, i) => (
        <Text key={i} style={[r.chip ? [styles.chip, { color: t.accent, backgroundColor: t.accentSoft }] : null, nudge]}>{r.text}</Text>
      ))}
    </TextInput>
  );
});

export const NativeField = makeField(false);
const PhoneField = makeField(true);

// (Android: the first tap of a double tap inside a chip is not moved before the second; ChipDocInputProps.Field. On iOS the
// wait made UIKit miss the double tap in every run, without it now and then: there the view is moved at once.)
for (const F of [NativeField, PhoneField]) (F as typeof F & { tapSnapDelay?: number }).tapSnapDelay = Platform.OS === "android" ? 350 : 0;

export const ChipInput = forwardRef<ChipInputHandle, ChipInputProps>(function ChipInput(props, ref) {
  const inner = useRef<ChipInputHandle>(null);
  const [focused, setFocused] = useState(false);
  useImperativeHandle(ref, () => ({
    insertRef: (r, at) => inner.current?.insertRef(r, at),
    caret: () => inner.current?.caret() ?? null,
    replaceBeforeCaret: (n, s) => inner.current?.replaceBeforeCaret(n, s),
    set: (text) => inner.current?.set(text),
    openInsert: (at) => inner.current?.openInsert(at),
    select: (at) => inner.current?.select(at),
    focus: (atEnd) => inner.current?.focus(atEnd),
    indent: (outdent) => inner.current?.indent?.(outdent),
  }), []);
  // A hardware Tab and Shift+Tab indent and outdent while the box has the focus and edits like code: the keys port takes them
  // from the system (which would move the focus) and gives them back when the box loses the focus. Under a dialog the composer gives
  // no `editing` (screens/composer/underdialog.ts), so a Tab never indents a box hidden under one.
  const tabs = focused && !!props.editing && !props.locked && !props.readOnly;
  useEffect(() => {
    if (!tabs) return;
    const give = takeTab();
    const off = onKey((e) => {
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); inner.current?.indent?.(e.shiftKey); }
    });
    return () => { off(); give(); };
  }, [tabs]);
  return <ChipDocInput {...props} ref={inner} Field={props.size === "phone" ? PhoneField : NativeField} onState={reportState} onRaw={reportRaw}
    onFocusChange={setFocused} />;
});

const styles = StyleSheet.create({
  field: { fontSize: BASE_SIZE, lineHeight: LINE, paddingVertical: 3, paddingHorizontal: 0, minHeight: 3 * LINE + 6, maxHeight: 6 * LINE + 6, textAlignVertical: "top" },
  phone: { fontSize: TYPE.control, lineHeight: PHONE_LINE, minHeight: PHONE_LINE + 6, maxHeight: 6 * PHONE_LINE + 6 },
  chip: { fontWeight: "600" },
});
