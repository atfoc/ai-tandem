// The chip input (AD-60): the composer's text box, which holds plain text with board-reference chips (⌘L, ⌘⇧L) in it.
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
};

export type ChipInputProps = {
  placeholder: string;
  /** The new value, and the text of the caret's node before the caret (for @ mentions): "" when the caret is right
   *  after a chip, or is not in the text. Called after every change of the text, of the chips and of the caret. */
  onChange(value: string, beforeCaret: string): void;
  /** The composer's keys in the box (Enter to send, Esc, ↑ ↓ and Tab of the mention list …), after the box has taken its
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
  /** The box's size. Unset: today's (13 pt, three lines to six, or 40% of the window on web). "phone": 17 pt text (the placeholder too), one line
   *  high when empty, growing to six lines and then scrolling inside (ux-improvements goal 3.6). */
  size?: "phone";
};
