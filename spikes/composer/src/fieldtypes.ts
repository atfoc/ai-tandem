import type { Span } from "./logic/chipdoc";

/** A run of the shown string: plain text, or a chip (of the kind of its reference). */
export type Piece = { text: string; chip?: "selection" | "point" };

export type FieldProps = {
  pieces: Piece[];
  /** The whole shown string (the web's field is a textarea that holds it as its value). */
  text: string;
  selection: Span;
  onText(next: string): void;
  onSelection(s: Span): void;
  onFocus?(): void;
  onBlur?(): void;
  /** The text of the selection as a copy puts it on the clipboard (tags for chips), or null for the field's own. */
  copyText?(): string | null;
  /** A cut took `copyText` already; the selection is to be removed. */
  onCut?(): void;
  placeholder?: string;
  maxHeight: number;
  plain?: boolean;
  testID?: string;
  editable?: boolean;
};
