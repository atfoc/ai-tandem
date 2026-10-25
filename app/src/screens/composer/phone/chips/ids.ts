// The testIDs of a new chat's chip row and its pickers on the phone (ux-improvements package C2); the checks read them
// (web/dev/checks/UX.C2-pickers.mjs and the phone halves of the composer's checks). Kept from the wide toolbar, so that a check reads both
// layouts the same way: each chip is `tchip` with dataSet `kind` (agent, folder, model, subagents) and `missing`; the folder browser's
// `dir-browser`, `dir-input`, `dir-item`, `dir-use`, `dir-err`; the subagent options `sub-opt` with dataSet `section`, `value`, `on`; the reason
// line `agent-reason` with dataSet `tone`. The pickers' rows are the kit's `picker-row` (dataSet `value`).
export const C2_IDS = {
  /** The row (also C1's PHONE_IDS.chipRow). */
  row: "composer-chip-row",
  /** The line beside the only chip of a chat that can change its model alone (a fork with no message of its own, a pending move). */
  note: "chip-note",
  /** The line under the row that says why the model and subagent chips take no press now (a send in flight, a fork starting its agent, a choice being saved). */
  held: "chip-held",
  /** The sheets. */
  agentSheet: "agent-sheet",
  modelSheet: "model-sheet",
  folderSheet: "folder-sheet",
  subSheet: "sub-sheet",
  /** A segmented control (effort, depth, running at once) and its segments (`segment` with dataSet `value`, `on`). */
  segmented: "segmented",
  segment: "segment",
  /** The model sheet's effort control and its line. */
  effort: "effort-seg",
  effortLine: "effort-line",
  /** The folder sheet's Up, its path (a tap types one), the head of its list and the empty folder's text. */
  dirUp: "dir-up",
  dirPath: "dir-path",
  dirHead: "dir-head",
  dirEmpty: "dir-empty",
  /** The empty chat on the phone: its starters' block ("Try asking"). */
  starters: "starters",
} as const;
