// The text field of a prompt in the library's editors (Editor.tsx on the wide layouts and the iPad, phone/PromptEditor.tsx on the phone):
// the composer's own box (platform/chipinput ChipInput), so that a prompt's text edits as a chat's message does. Tab indents with a tab or
// with spaces as Settings > Composer says (state/editing.ts), Enter keeps the indent of the line and continues a markdown list, Backspace
// in an indent of spaces goes back a tab stop, and a tab is drawn as wide as the setting says. The box holds plain text (`noChips`): a
// reference tag in a prompt stays text, and nothing is inserted into it by ⌘P. As the TextInput it replaced, it is called "Text" to a screen
// reader (`label`; the testID stays the device checks' handle) and gets no autocorrect, spelling marks or capitals (`plain`: a prompt is
// often code). Its keys are its own: `onKey` takes none, so ⌘↵ / Ctrl+↵
// reaches the editor's save through the keys port (on web a capture listener on the window, which sees the key before the box does).
//
// The box is not a controlled field: it is set() and reports its text (and every move of its caret) through onChange. PromptText makes it
// behave as a controlled TextInput, so that the editors keep what is typed in their own state as before (textsync.ts): `onChangeText` is
// called for a change the person made, never for a set() or a caret that moved; when `value` is not what the box holds (the first render,
// another prompt, Revert / Cancel / Discard, a second window's change) the box is set to it. A value that is what was just typed, or what
// a save made of it, leaves the box alone, with its caret and its undo.
//
// The focus events of the box bubble to a View around it (on web and on native), where the editors watch them, as the composer does.
// The handle gives the focus and indents at the caret: the key row or the bar over a soft keyboard, which has no Tab (native only; the web
// box takes Tab itself).
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { ChipInput } from "../../platform/chipinput/ChipInput";
import type { ChipInputHandle, ChipInputProps } from "../../platform/chipinput/types.ts";
import { useEditingSettings } from "../../state/editing.ts";
import { textSync } from "./textsync.ts";

export type PromptTextHandle = {
  /** Tab at the caret or over the selection, as Settings > Composer says (iOS, Android); nothing while read-only. */
  indent(): void;
  focus(): void;
};

export type PromptTextProps = {
  value: string;
  /** A change the person made (never one `value` caused). */
  onChangeText(v: string): void;
  /** Shown, selectable, and not editable (the library's server is not connected). */
  readOnly: boolean;
  testID: string;
  look: ChipInputProps["look"];
  /** iOS: the nativeID of the bar over the keyboard. */
  accessoryId?: string;
  placeholder?: string;
};

export const PromptText = forwardRef<PromptTextHandle, PromptTextProps>(function PromptText(p, ref) {
  const editing = useEditingSettings();
  const input = useRef<ChipInputHandle>(null);
  const sync = useRef(textSync()).current;
  const tell = useRef(p.onChangeText);
  tell.current = p.onChangeText;
  // (a layout effect: the box holds the value before it is first drawn, and the box's handle is there already, a child's ref being set first)
  useLayoutEffect(() => { if (sync.toBox(p.value)) input.current?.set(p.value); }, [p.value]);
  useImperativeHandle(ref, () => ({ indent: () => input.current?.indent?.(), focus: () => input.current?.focus() }), []);
  return (
    <ChipInput ref={input} noChips editing={editing} locked={p.readOnly} readOnly={p.readOnly} placeholder={p.placeholder ?? ""} onKey={() => false}
      onChange={(v) => { if (sync.fromBox(v)) tell.current(v); }} testID={p.testID} label="Text" plain look={p.look} accessoryId={p.accessoryId} />
  );
});
