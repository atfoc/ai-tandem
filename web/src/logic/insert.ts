// Putting a text into a composer's text box from the insert popup (plans/prompt-library.md, section 5): the key that
// opens the popup, what the box holds after a text was put into it, and the one place where the popup plugs in.
// DOM-free: the box (RefInput.tsx) remembers the caret and changes the page, and holds what it did against this.

const isMac = (platform: string) => /Mac|iPhone|iPad/.test(platform);

/** ⌘P on macOS, Ctrl+P elsewhere, with nothing else held. platform: navigator.platform. Ctrl+P is not taken on macOS: there
 *  it moves the caret a line up in a text field. */
export const isInsertKey = (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; code: string }, platform: string) =>
  e.code === "KeyP" && !e.shiftKey && !e.altKey && (isMac(platform) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** The shortcut's name, for titles. */
export const insertKeyName = (platform: string) => (isMac(platform) ? "⌘P" : "Ctrl+P");

// ---- what the box holds

/** A caret or a selection in a box's value (the text, with each reference as its tag): from start up to end, the two
 *  the same for a caret. */
export type Span = { start: number; end: number };

/** A text's line breaks as a box's value has them. */
export const lines = (text: string) => text.replace(/\r\n?/g, "\n");

/** What a box holds after `text` is put at `at`: the text in place of what was selected there, between what was before
 *  and what was after, both as they were, and the caret right after it. The text goes in as it is, with its line
 *  breaks. */
export function insertText(value: string, at: Span, text: string): { value: string; caret: number } {
  const within = (n: number) => Math.max(0, Math.min(n, value.length));
  const start = within(Math.min(at.start, at.end)), end = within(Math.max(at.start, at.end)), t = lines(text);
  return { value: value.slice(0, start) + t + value.slice(end), caret: start + t.length };
}

/** Whether a box holds `want`. The line breaks that end the box are not compared: the browser shows an empty last line
 *  with a break of its own, which it drops when the line gets text. */
export const sameBox = (value: string, want: string) => value.replace(/\n+$/, "") === want.replace(/\n+$/, "");

// ---- the insert popup

/** What the insert popup gets from the text box it is opened for: the box has remembered where its caret or its
 *  selection is. The popup calls one of the two, once, when it has closed. */
export type InsertTarget = {
  /** Puts `text` where the caret was, in place of what was selected there. The box has the focus again, with the
   *  caret right after the text. */
  insert(text: string): void;
  /** Nothing is inserted: the box has the focus again, with its caret or its selection as it was. */
  cancel(): void;
};

type Opener = (target: InsertTarget) => void;
let opener: Opener | null = null;

/** Where the insert popup plugs in: `open` is called for each ⌘P in a composer's text box and each press of a
 *  composer's Insert button, with that box's target. Answers a function that takes it back. */
export function onInsertPopup(open: Opener): () => void {
  opener = open;
  return () => { if (opener === open) opener = null; };
}

/** Opens the insert popup for a text box. With no popup there, the box is as it was. */
export function openInsertPopup(target: InsertTarget): void {
  if (opener) opener(target); else target.cancel();
}
