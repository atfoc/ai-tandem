// The testIDs of the chat screen on the phone (package T1 of ux-improvements; the shared ones are in ui/tid.ts). A check reads them by
// these names; the wide layouts keep their own ids (`chat-head`, `fk-more`, `md-copy`…), which are not listed here.
export const T1_TID = {
  /** The header's Tree button (dataSet `count`: the chat's branches) and its ⋯ (Chat info). */
  chatTree: "chat-tree",
  chatMore: "chat-more",
  /** The "↓ Latest" pill over the thread's foot, shown when the person has scrolled up and new text arrived. */
  latest: "thread-latest",
  /** A table in the thread: the pinned first column, the swipe hint, "Open full table". */
  tablePin: "md-table-pin",
  tableHint: "md-table-hint",
  tableOpen: "md-table-open",
  /** The pushed table viewer (screen `table`) and its Copy. */
  tableScreen: "table-screen",
  tableCopy: "table-copy",
  /** A code block's Wrap (dataSet `on`). Copy keeps `md-copy`. */
  codeWrap: "md-code-wrap",
  /** The link sheet (a P1 held from a link; rows `open`, `copy`). */
  linkSheet: "link-sheet",
  /** The message sheet (a P1 held from a message; quick row `copy`, `quote`, `read`, `select`; rows by the fork's button ids). */
  messageSheet: "msg-sheet",
  /** The message lifted over the dimmed thread while its sheet is open. */
  messageLift: "msg-lift",
  /** The Select text sheet's buttons (the Quote sheet in mode "select"; its dataSet `mode`). */
  selectCopy: "select-copy",
  selectCopyAll: "select-copy-all",
} as const;
