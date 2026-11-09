// The chip input on iOS and Android (AD-61 (a), package K2, from the composer spike): a controlled multiline TextInput whose
// text is given as children, no `value`: each plain run a Text, each chip a nested Text with a background showing its label
// between two no-break spaces; the `selection` prop moves the caret. The document beside it is chipdoc.ts, the state and
// the handlers are ChipDocInput.tsx; the contract is types.ts. No library: react-native-enriched is not used.
// The prompt library's text field is this box with `noChips` (plain text, no chips), its `look` (a style over the field's), `label` (its
// accessibility label, "Text", where the composer's is its testID), `plain` (no autocorrect, spelling or capitals) and, on iOS,
// `accessoryId` (the InputAccessoryView over the keyboard).
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
//  - With `editing` and spaces for indent, Backspace in the indent takes back to the previous tab stop (chipdoc.ts backspaceChange):
//    the field has deleted one space already, so a change that is exactly one space taken away right before the caret, the line
//    before it all indent, is answered with the document of backspaceEdit on the text before the change. The same caveats as
//    Enter: a controlled field, one frame may show the single space gone first, on Android an answer after the next keystroke is
//    dropped (only the one space goes then). The caret the field reported before the change places the delete; without it, a
//    space inside a run of spaces cannot be placed and only that one space goes. In "tab" mode the field's own Backspace takes
//    the "\t".
//  - Tab: a hardware Tab comes through the keys port while the box has the focus (takeTab, the aiwb-keys module) and indents
//    (handle.indent, chipdoc.ts indentChange); the soft keyboard has no Tab, so the composer shows a key row with Indent above it
//    (screens/composer/EditKeys.tsx). Shift+Tab is taken too while the box has the focus (so the focus stays) and edits nothing:
//    an indent is taken away by deleting it.
//  - The hanging indent (ChipInputProps.tabWidth, which defaults to `editing`'s): a line that wraps goes on at its own indent, where its
//    text starts after its leading spaces and tabs, and a tab is drawn `tabWidth` columns wide (before, iOS drew a tab to a 28 pt stop,
//    Android to 20 px). The local module aiwb-indent puts it on the platform's text view (app/modules/aiwb-indent; the field's side is
//    hang.ts): attached at the TextInput's onLayout, once the view exists. React Native measures the box without it, so while it is on
//    the box's height is the text's height as the module drew it, kept between the variant's minimum and maximum; one frame may show
//    the old height. An indent is at most half the text's width. Only spaces and tabs count: a list's "- " is text, so a list item's
//    continuation lines start under its "-". Where the platform cannot (iOS with a text view on TextKit 1) and in a build without the
//    module, lines wrap to the left edge as before. Unit-tested over the module's fake (app/test/hangindent.test.ts); checked by hand
//    on the iPhone simulator and the Android emulator (typing, tab widths, Enter, the key row's Indent (and its Outdent key, since
//    removed), a chip, the height; the list is in the module's README). Not verified: a real device, IME composition, dictation,
//    autocorrect replacing a word next to an indent.
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
//  - Checked on the simulator and the emulator: the flow in the real composer of a board chat and on the dev gallery, the hardware keys (XCUITest on
//    iOS, adb key events on Android), and on Android Gboard's own typing next to a chip with a suggestion picked. Not
//    verified (by hand, goal 7.5): IME composition of Japanese, Chinese, Korean and dictation; autocorrect replacing a word
//    next to a chip (unit-tested in applyChange; neither keyboard corrected a misspelling in the runs); undo/redo (shake,
//    ⌘Z); dragging the selection handles across a chip; fast typing on a real device (the runs tap keys about twice a
//    second). Each is a place where a field that has its text re-set can fight the platform. The Enter of `editing` with the soft
//    keyboard (the tab kept, the list continued) and the key row (its presses keep the keyboard and the caret) passed on the iPhone
//    simulator. Not verified on a device: Android, a hardware Enter, the hardware Tab through
//    the keys port, and how often the frame of the bare line break shows.
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { findNodeHandle, Platform, StyleSheet, Text, TextInput, type NativeSyntheticEvent, type TextInputKeyPressEventData, type TextInputSelectionChangeEventData } from "react-native";

import { MONO } from "../../ui/fonts.ts";
import { TYPE } from "../../ui/metrics.ts";
import { BASE_SIZE } from "../../ui/Text.tsx";
import { reportRaw, reportState } from "../../dev/chipreport.ts";
import { useTokens } from "../../ui/theme.tsx";
import { onKey, takeTab } from "../keys.native.ts";
import AiwbIndent from "../../../modules/aiwb-indent/src/AiwbIndentModule.ts";
import { clampHeight, hangOver, type Hang } from "./hang.ts";
import { ChipDocInput, type FieldHandle, type FieldProps } from "./ChipDocInput.tsx";
import type { ChipInputHandle, ChipInputProps } from "./types.ts";

export type { ChipInputHandle, ChipInputProps } from "./types.ts";

const LINE = Math.round(BASE_SIZE * 1.45);
const PHONE_LINE = Math.round(TYPE.control * 1.45);

/** The field's height from its least to its most, per variant (the StyleSheet's minHeight / maxHeight, and the bounds of the height
 *  the hanging indent sets from the drawn text): three lines to six, the phone's one to six, each with the 3 + 3 of the padding. */
export const FIELD_HEIGHT = { min: 3 * LINE + 6, max: 6 * LINE + 6 };
export const PHONE_FIELD_HEIGHT = { min: PHONE_LINE + 6, max: 6 * PHONE_LINE + 6 };

/** The hanging indent's controllers over the native module (null in a build without it: hang.ts then does nothing). */
const newHang = hangOver(AiwbIndent);

/** The native field: the runs as the TextInput's children. `phone`: the phone's box (17 pt, one line high to six, then it scrolls inside). */
const makeField = (phone: boolean) => forwardRef<FieldHandle, FieldProps>(function NativeField(
  { runs, selection, rev, onText, onSelection, onKeyPress, onFocusChange, placeholder, editable, readOnly, plain, testID, label, look, accessoryId, tabWidth = 0 },
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
  // The hanging indent (hang.ts): the controller is made in the mount effect, so React's StrictMode, which runs the effect twice,
  // gets a new one after the first's dispose; the last tag the layout gave is handed to it. While the indent is on and the module
  // has drawn the text, the box is as high as the drawn text (React Native's measure leaves the indent out).
  const hang = useRef<Hang | null>(null);
  const tag = useRef<number | null>(null);
  const width = useRef(tabWidth);
  width.current = tabWidth;
  const [drawn, setDrawn] = useState<number | null>(null);
  useEffect(() => {
    const h = newHang(setDrawn);
    hang.current = h;
    h.width(width.current);
    if (tag.current !== null) h.layout(tag.current);
    return () => { h.dispose(); if (hang.current === h) hang.current = null; };
  }, []);
  useEffect(() => { hang.current?.width(tabWidth); }, [tabWidth]);
  // (the bounds are the field's own as `look` changes them: its least height, and none at the top for a box that grows with its
  // parent, where the height is the flex basis it grows or shrinks from)
  const bounds = phone ? PHONE_FIELD_HEIGHT : FIELD_HEIGHT;
  const least = look?.minHeight ?? bounds.min, most = look?.grow ? Infinity : bounds.max;
  const hung = drawn !== null && tabWidth > 0 ? { height: clampHeight(drawn, least, most) } : null;
  return (
    <TextInput
      ref={input}
      testID={testID}
      accessibilityLabel={label ?? testID}
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
      onLayout={() => { tag.current = findNodeHandle(input.current); hang.current?.layout(tag.current); }}
      {...(plain ? { autoCorrect: false, spellCheck: false, autoCapitalize: "none" as const } : {})}
      inputAccessoryViewID={accessoryId}
      style={[styles.field, phone && styles.phone, look && lookStyle(look), { color: t.text }, hung]}
    >
      {runs.map((r, i) => (
        <Text key={i} style={[r.chip ? [styles.chip, { color: t.accent, backgroundColor: t.accentSoft }] : null, nudge]}>{r.text}</Text>
      ))}
    </TextInput>
  );
});

/** ChipInputProps.look as a style over the field's (a later `maxHeight: undefined` clears the field's own: flattenStyle and the
 *  renderer's attribute payload both drop a key a later style sets to undefined). */
function lookStyle(look: NonNullable<FieldProps["look"]>) {
  return {
    ...(look.mono ? { fontFamily: MONO } : null),
    ...(look.fontSize ? { fontSize: look.fontSize, lineHeight: Math.round(look.fontSize * 1.45) } : null),
    ...(look.minHeight !== undefined ? { minHeight: look.minHeight } : null),
    ...(look.grow ? { flexGrow: 1, flexShrink: 1, maxHeight: undefined } : null),
  };
}

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
    indent: () => inner.current?.indent?.(),
  }), []);
  // A hardware Tab indents while the box has the focus and edits like code, and Shift+Tab is swallowed (no edit): the keys port takes
  // them from the system (which would move the focus) and gives them back when the box loses the focus. Under a dialog the composer gives
  // no `editing` (screens/composer/underdialog.ts), so a Tab never indents a box hidden under one.
  const tabs = focused && !!props.editing && !props.locked && !props.readOnly;
  useEffect(() => {
    if (!tabs) return;
    const give = takeTab();
    const off = onKey((e) => {
      if (e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); if (!e.shiftKey) inner.current?.indent?.(); }
    });
    return () => { off(); give(); };
  }, [tabs]);
  return <ChipDocInput {...props} ref={inner} Field={props.size === "phone" ? PhoneField : NativeField} onState={reportState} onRaw={reportRaw}
    onFocusChange={setFocused} />;
});

const styles = StyleSheet.create({
  field: { fontSize: BASE_SIZE, lineHeight: LINE, paddingVertical: 3, paddingHorizontal: 0, minHeight: FIELD_HEIGHT.min, maxHeight: FIELD_HEIGHT.max, textAlignVertical: "top" },
  phone: { fontSize: TYPE.control, lineHeight: PHONE_LINE, minHeight: PHONE_FIELD_HEIGHT.min, maxHeight: PHONE_FIELD_HEIGHT.max },
  chip: { fontWeight: "600" },
});
