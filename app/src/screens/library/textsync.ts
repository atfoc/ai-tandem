// What the prompt library's text box holds, so that it can be used as a controlled field (PromptText.tsx). The box (the composer's
// ChipInput) is not controlled: it is given a text with set(), and it reports its text through onChange after every change of the
// text or of the caret, and after set() too. Its owners (the library dialog's editor, the phone's prompt editor) keep what is typed in
// their own state and give it back as `value`, as with a TextInput. One object remembers the text the box holds, and answers the two
// questions that make the box behave as a controlled TextInput:
//  - fromBox(v): the box reported `v`; true when the owner is to be told, that is when the text differs from what the box held: a change
//    the person made. A caret that moved, and the report that follows a set(), say the text the box holds already, and are not told.
//  - toBox(value): the owner's value is `value`; true when the box is to be set() to it, that is when it differs from what the box holds:
//    another prompt was chosen, the edits were reverted or discarded, a second window changed the prompt. A value that is what the box
//    holds (what the person just typed, given back; what was saved) is not set again, so the caret and the undo stay.
// The first toBox (nothing is held yet) always sets: the box starts with the owner's value.

export type TextSync = {
  /** The box reported its text: true = a change the person made, to tell the owner. */
  fromBox(v: string): boolean;
  /** The owner's value: true = the box holds something else, and is to be set() to it. */
  toBox(value: string): boolean;
};

export function textSync(): TextSync {
  let held: string | null = null; // what the box holds; null before the first set
  return {
    fromBox(v) {
      if (v === held) return false;
      held = v;
      return true;
    },
    toBox(value) {
      if (value === held) return false;
      held = value;
      return true;
    },
  };
}
