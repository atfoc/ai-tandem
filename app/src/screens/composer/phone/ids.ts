// The testIDs of the phone's composer (ux-improvements package C1); the checks read them (web/dev/checks/UX.C1-composer.mjs and the composer's
// existing checks' phone halves). The wide composer's ids are unchanged (`composer`, `composer-box`, `composer-input`, `send`, `stop`, ...).
export const PHONE_IDS = {
  /** The phone toolbar's row. */
  toolbar: "composer-phone-tools",
  /** "+": opens the Add to message sheet. */
  plus: "composer-plus",
  /** Talk, the primary while the box is empty (inside voice's `voice-speech`). */
  talk: "composer-talk",
  /** Dictate, the mic (inside voice's `voice-dictate`). */
  dictate: "composer-dictate",
  /** The Add to message sheet; its rows are the kit's `action-row` with dataSet `action` (camera, library, files, prompt, selection, point). */
  plusSheet: "plus-sheet",
  /** The context row of 34-point chips; each chip `ctx-chip` with dataSet `kind` (board, ref, quotes, selected). */
  contextRow: "context-row",
  /** The @ suggestions docked above the composer; each row `mention-item` with dataSet `board`, `on`. */
  atDock: "mention-dock",
  /** The chip row of a new chat (package C2 draws its chips). */
  chipRow: "composer-chip-row",
} as const;
