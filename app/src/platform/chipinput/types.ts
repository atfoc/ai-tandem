// The chip input (AD-60): the composer's text box, which holds plain text with board-reference chips (⌘L, ⌘⇧L) in it. The prompt
// library's text field is the same box with no chips (`noChips`, `look`), so that a prompt's text edits as the composer's does.
// One contract, two implementations: ChipInput.web.tsx (a contenteditable, today's RefInput) and ChipInput.native.tsx
// (K2). The box's value is the message text with each reference as its inline tag (core logic/refs.ts serializeRef /
// parseRefs), so drafts, sending, the thread and the agent are unchanged.
//
// Both implementations show this, and L4-chips.mjs and the device test (V3) check it (the C-RF rows of the parity inventory):
//  - a chip is one unit for the caret, the selection, Backspace / Delete, cut, copy and paste; its tag is what a copy
//    puts on the clipboard, and a paste of tags gives chips again. The exception (AD-61): on iOS and Android a copy puts
//    the chips' labels on the clipboard, not their tags; a paste back into the same box gives the chips again, a paste
//    anywhere else the labels (ChipInput.native.tsx lists what else the native box does not do);
//  - a chip cannot be edited inside; the value always round-trips through parseRefs / serializeRef;
//  - insertRef puts a chip at the caret (in place of a selection; where the caret last was; else at the end), a space
//    before it unless white space is there, a space after it unless white space follows, the caret after that space;
//  - a caret right after a chip is not in text: beforeCaret there is "", so no @ mention is open;
//  - while `locked` or `readOnly` nothing is put in or taken out; a read-only box still shows its chips, and its text can
//    be selected and copied.
// Undo of a chip is not required (C-RF-20).
import type { Picked } from "@aiwb/core/logic/chatimage.ts";
import type { EditingSettings, TabWidth } from "@aiwb/core/logic/editing.ts";
import type { Ref } from "@aiwb/core/logic/refs.ts";

import type { KeyLike } from "../keys.types.ts";

export type { KeyLike, Picked, Ref };

export type ChipInputHandle = {
  /** Puts a reference chip at the caret (or where the caret last was, or at the end). The box gets the focus. `at`: put it in
   *  place of that span of the value instead (what `caret` told earlier, for a box that was made anew since: the phone's wait for a
   *  point, in which the composer goes away and comes back). */
  insertRef(ref: Ref, at?: { start: number; end: number } | null): void;
  /** Where the caret or the selection is in the box's value (the text with each chip as its tag), else where it last was; null
   *  when the box has had none. */
  caret(): { start: number; end: number } | null;
  /** Replaces the `n` characters before the caret with `s` (the @ mention being typed). */
  replaceBeforeCaret(n: number, s: string): void;
  /** Replaces everything with `text` (tags become chips). Reports the new value through onChange. */
  set(text: string): void;
  /** Opens the insert popup (core logic/insert.ts) for the box, as ⌘P in it does: what the popup inserts goes where the
   *  caret or the selection is now (or where the caret last was, or at the end). `at`: a span of the value to put it in instead,
   *  noted before something else took the focus (the phone's "+" sheet: the focus it gives back puts the caret at the start). */
  openInsert(at?: { start: number; end: number } | null): void;
  /** Puts the caret or the selection back at a span of the value, without taking the focus (what the phone's "+" sheet noted
   *  before its focus, given back as it closed, put the caret at the start). */
  select(at: { start: number; end: number }): void;
  /** Gives the box the focus. atEnd: the caret goes to the end of what it holds (the composer a sent move went to takes it so). */
  focus(atEnd?: boolean): void;
  /** Tab at the caret or over the selection, as `editing` says (core logic/indent.ts): the soft keyboard's key row and a hardware
   *  Tab on iOS and Android. Native only (the web box takes Tab itself); nothing without `editing`, or while locked or read-only;
   *  the focus stays where it is. There is no outdent: an indent is taken away by deleting it. */
  indent?(): void;
};

export type ChipInputProps = {
  placeholder: string;
  /** The new value, and the text of the caret's node before the caret (for @ mentions): "" when the caret is right
   *  after a chip, or is not in the text. Called after every change of the text, of the chips and of the caret. */
  onChange(value: string, beforeCaret: string): void;
  /** The composer's keys in the box (⌘Enter / Ctrl+Enter to send, Esc to stop …), after the box has taken its
   *  own (⌘P, Backspace / Delete next to a chip). True = handled: the box then does not act on the key (on web it
   *  calls preventDefault). The box never lets a key it was given go on to the page's own shortcuts. A key pressed
   *  while an input method composes text is not given. */
  onKey(e: KeyLike): boolean;
  /** Nothing can be put into the box now, and nothing taken out of it (the server of the chat is not connected): the
   *  insert popup is not opened, a reference is not inserted, no chip is removed by a key or cut, and the platform's
   *  own typing is stopped. */
  locked?: boolean;
  /** The box is read-only (the server of the chat is not connected, or no longer has it): it shows what it holds and is
   *  not editable at all, by a key, a paste, a drop or the platform's commands. Its text can still be selected and
   *  copied. */
  readOnly?: boolean;
  /** Image files were pasted, and the paste is theirs (core logic/chatimage.ts pastedImages). A box without it takes no
   *  image: its paste is the plain text. Web only: native pastes images through the picker (K4). */
  onImages?(files: Picked[]): void;
  /** The box's testID (AD-80); the chips in it are "ref-chip", each with dataSet {kind: "selection" | "point"}. */
  testID?: string;
  /** What a screen reader calls the box (the prompt library's "Text"). Unset: on iOS and Android the testID, as before (the device
   *  checks of the composer find its box by it); on web no label. */
  label?: string;
  /** No autocorrect, spelling marks or capitals from the keyboard (the prompt library's text, which is often code; the device checks'
   *  galleries too). Unset: the platform's own. */
  plain?: boolean;
  /** The box's size. Unset: today's (13 pt, three lines to six, or 40% of the window on web). "phone": 17 pt text (the placeholder too), one line
   *  high when empty, growing to six lines and then scrolling inside (ux-improvements goal 3.6). */
  size?: "phone";
  /** Code-editor editing (core logic/indent.ts), for keys `onKey` did not handle: Tab indents (a tab character or spaces, as the
   *  settings say; over several lines every line), Shift+Tab is taken and does nothing (the focus stays in the box), Backspace in an
   *  indent of spaces deletes back to the previous tab stop (with a tab character the platform's own Backspace takes the "\t"), Enter
   *  and Shift+Enter add a line that keeps the indent of the caret's line and continues a markdown list. How wide a tab character is drawn is
   *  the prop `tabWidth` (which defaults to this one's). Unset: Tab and Enter are the platform's own (focus, a bare
   *  line break). Nothing is edited while `locked` or `readOnly`. On web, a Tab or Shift+Tab right after Esc is the browser's: it moves the
   *  focus out of the box (the keyboard's way out; any other key, a press in the box or a blur in between ends that). Esc itself still
   *  goes to `onKey` as before. On web, a line that starts with tabs or spaces and wraps continues at its indent: its further visual
   *  lines start where its text starts, not at the box's left edge (hanging.ts). On iOS and Android the same, drawn by the aiwb-indent
   *  module with the width of `tabWidth` (below), which follows this one's unless given. */
  editing?: EditingSettings;
  /** How wide a tab character is drawn (2, 4 or 8 columns) and, on iOS and Android, the hanging indent: a line that wraps goes on at
   *  its own indent, where its text starts after its leading tabs and spaces (the aiwb-indent module; ChipInput.native.tsx). Unset:
   *  `editing?.tabWidth`. Its own prop because the composer gives no `editing` on iOS and Android while a dialog or a popup is open
   *  (screens/composer/underdialog.ts: a hardware Tab must not indent a box hidden under one), and the box behind it must not reflow
   *  when one opens. The web box reads `editing` (it gets it under dialogs too). */
  tabWidth?: TabWidth;
  /** The box holds plain text, not references (the prompt library's text field): text that reads as a reference tag (core logic/refs.ts
   *  REF_SRC) is that text and never a chip, whether it was set, typed, pasted or moved by an edit of `editing`; a paste is its plain
   *  text. insertRef, openInsert and ⌘P put nothing in (⌘P is still taken, so the page is not printed). */
  noChips?: boolean;
  /** The box's look where it is not the composer's (the prompt library's text field), over what `size` gives: `mono`, the text in
   *  the monospace face (ui/fonts.ts MONO); `fontSize`, its size in pt/px (the placeholder's too; a line stays 1.45 times as high);
   *  `minHeight`, the least height in pt/px (the 3 above and below the text included); `grow`, no greatest height: the box grows with
   *  its text and takes the height its parent leaves it (as a flex child), and scrolls inside once its parent bounds it. */
  look?: { mono?: boolean; fontSize?: number; minHeight?: number; grow?: boolean };
  /** iOS: the nativeID of the InputAccessoryView shown over the keyboard while the box has the focus (TextInput's
   *  inputAccessoryViewID; the library's phone editor's bar). Ignored elsewhere. */
  accessoryId?: string;
};
