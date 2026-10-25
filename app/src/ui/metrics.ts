// The phone's sizes (ux-improvements goal 3.1.1): the touch target, the rows and cells, the margins and the type ramp of the phone
// layout, in points. The wide layouts keep today's sizes (goal 4.2): a part reads these only where `usePhone()` (useLayout.ts) is
// true, or where it is phone-only. No React and no react-native here, so Node loads it (the rules check of package R1 imports it).
//
// Contract of package F1 (plans/ux-improvements/PLAN.md): the names are fixed; F1 may add names, not rename them.

export const PHONE = {
  /** The least touch target: a control that looks smaller has a target this big around it. */
  target: 44,
  /** A row of an action sheet (P1) or a picker (P2). */
  sheetRow: 50,
  /** A cell of a pushed list screen (P5). */
  cell: 48,
  /** A row of Home, a group, Archived, the library (icon, name, sub-line). */
  listRow: 60,
  /** A chip of the composer's chip row and of a board chat's context row. */
  chip: 36,
  /** The side margin of every screen and sheet. */
  margin: 16,
  /** The gap between the composer's box and the keyboard. */
  keyboardGap: 6,
} as const;

/** The type ramp of the phone layout. Secondary text is never under `secondary`. */
export const TYPE = {
  /** Controls, lists, sheets, the composer's box, a bar's title. */
  control: 17,
  /** A chat's reading body, with `bodyLine` as its line height factor. */
  body: 16,
  bodyLine: 1.5,
  /** A sub-line, a value, a note: the floor of all text on the phone. */
  secondary: 13,
  /** A busy line in the thread. */
  busy: 15,
  /** The headings of a chat's Markdown. */
  h2: 20,
  h3: 17,
  /** A P4 confirm's title. */
  confirmTitle: 20,
  /** Home's and a group's large title. */
  largeTitle: 34,
} as const;

/** A long press on the phone (a row's action sheet, a message's sheet, a chip's server sheet), in milliseconds. A finger that moves
 *  10 pt after it starts a drag instead (goal 3.3). */
export const LONG_PRESS_MS = 500;
export const DRAG_SLOP = 10;
