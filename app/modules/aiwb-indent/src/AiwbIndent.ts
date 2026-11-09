// The contract of `aiwb-indent`: the hanging indent of the text box on iOS and Android. When a line of a box that edits like code
// (ChipInputProps.editing) wraps, its continuation lines start where its text starts after its leading tabs and spaces, not at the
// box's left edge; a tab is drawn `tabWidth` columns wide. React Native's TextInput has no such style, so the module puts it on the
// platform's own text view (README.md says how on each platform). This file has no run-time import of the native module: it is the
// types, and the rules the native sides follow, as functions the tests run (app/test/hangindent.test.ts) and the Swift and the
// Kotlin mirror.

/** What the module emits while it draws a box's indent: the height the box's text takes as drawn, padding included (the box's
 *  content height). React Native measures the box without the indent (and with its own tab width), so the field sets its height
 *  from this instead (app/src/platform/chipinput/hang.ts). */
export type DrawnHeightEvent = { tag: number; height: number };

export type AiwbIndentEvents = { onDrawnHeight(e: DrawnHeightEvent): void };

/** The handle `addListener` answers; Expo's EventSubscription. */
export type Subscription = { remove(): void };

/** The module: the native one (AiwbIndentModule.ts), the fake (fake.ts) and the stand-in of the web build (null). */
export interface AiwbIndentModule {
  /** Draws the hanging indent on the TextInput whose React tag is `tag` (findNodeHandle), with tabs `tabWidth` columns wide (2, 4
   *  or 8); `tabWidth` 0 stops it and draws the box as React Native does. Called again with another width, it changes the width.
   *  Resolves true when the view was found (and the indent is now as asked), false when it was not (not mounted yet, or gone):
   *  the caller asks again later (at the view's next layout). Never rejects. */
  setIndent(tag: number, tabWidth: number): Promise<boolean>;
  addListener<E extends keyof AiwbIndentEvents>(name: E, listener: AiwbIndentEvents[E]): Subscription;
}

/** The share of the text's width an indent may take at most: a deeper indent is drawn this wide, so a line always has room. */
export const MAX_INDENT_SHARE = 0.5;

/** The columns of a line's indent: its leading run of spaces and tabs, a space one column, a tab up to the next multiple of
 *  `tabWidth`. It stops at the first other character (a no-break space, a chip's label, a list's "-"). A line of nothing but spaces
 *  and tabs has them all as its indent. */
export function indentColumns(line: string, tabWidth: number): number {
  let cols = 0;
  for (const c of line) {
    if (c === " ") cols += 1;
    else if (c === "\t") cols += tabWidth - (cols % tabWidth);
    else break;
  }
  return cols;
}

/** A paragraph of the text, as the platforms cut it: from a line's start to after its "\n" (or to the end of the text). */
export type Paragraph = { start: number; end: number; columns: number; hasTab: boolean };

/** The paragraphs of `text` (UTF-16 offsets, as both platforms count) with each one's indent and whether it holds a tab. No paragraph
 *  for the empty line after a final "\n". */
export function paragraphs(text: string, tabWidth: number): Paragraph[] {
  const out: Paragraph[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl + 1;
    const line = text.slice(start, end);
    out.push({ start, end, columns: indentColumns(line, tabWidth), hasTab: line.includes("\t") });
    start = end;
  }
  return out;
}

/** How far the continuation lines of a paragraph start, in points (iOS) or pixels (Android): its columns times the width of a space
 *  in the paragraph's font, at most MAX_INDENT_SHARE of the text's width (`textWidth`, the box's width less its padding; 0 or less
 *  when not known yet: no cap). The first line is not moved: its own spaces and tabs put its text there. */
export function hangWidth(columns: number, spaceWidth: number, textWidth: number): number {
  const w = columns * spaceWidth;
  return textWidth > 0 ? Math.min(w, textWidth * MAX_INDENT_SHARE) : w;
}

/** The distance between two tab stops: `tabWidth` spaces of the font. The stops are at every multiple of it from the text's left
 *  edge, so a tab after n columns ends at the next multiple of `tabWidth` columns, as indentColumns counts. */
export function tabInterval(tabWidth: number, spaceWidth: number): number {
  return tabWidth * spaceWidth;
}
