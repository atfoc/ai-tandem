// The ids the chat tree's phone sheet (TreeSheet.tsx) adds to the ones the tree popup has (TreePopup.tsx: `fk-row` with its dataSet, `fk-text`, `fk-tag`,
// `fk-mark`, `fk-stop`, `fk-end`, `fk-filter`, `fk-search`, `fk-none`, `fk-nav-sub` are drawn by both shapes, and `fk-here` is the pill here and the "● here" word
// there). A row's action sheet is a kit ActionSheet, so its rows are the kit's `action-row` (dataSet `action` = the item's id). No React here, so Node loads it.

/** The tree as a dialog (wide) or a full-height sheet (phone). */
export const TREE_POPUP_ID = "tree-popup";

export const TREE_TID = {
  /** The sheet's Done. */
  done: "fk-done",
  /** The action sheet of a row held (a kit ActionSheet). */
  rowSheet: "fk-row-sheet",
  /** The Label form of a row (a kit FormSheet) and its field. */
  labelForm: "fk-label-form",
  labelInput: "fk-label-input",
} as const;

/** The branch pill of a message that branched (BranchPill.tsx, the phone's shape of the marker; the marker itself, `fk-marker` with its dataSet `n` and `m`,
 *  is the pill). The arrows have a dataSet `disabled`: at the ends, and while another branch cannot be opened. */
export const PILL_TID = {
  prev: "fk-marker-prev",
  next: "fk-marker-next",
  /** The middle, which opens the tree at the message. */
  open: "fk-marker-open",
} as const;
