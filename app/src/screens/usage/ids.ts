// The testIDs the phone's "Context and usage" sheet adds (package T3, chunk 2). The ids the wide popup already has (`usage-body`, `usage-context`,
// `usage-ctx`, `usage-plan`, `usage-row`, `usage-bar`, `usage-reset`, `usage-foot`, `ctx-refresh`, `plan-refresh`, `usage-err`, `usage-note`) are
// kept on the sheet where it shows the same thing.
export const USAGE_TID = {
  /** The sheet (dataSet `chat`: the chat's key). */
  sheet: "usage-sheet",
  /** The big share of the window ("36%") and the words beside it. */
  big: "usage-big",
  bigWords: "usage-big-words",
  /** The stacked bar of the split. Its segments are `usage-split-seg` (dataSet `cat`, `slot`). */
  splitBar: "usage-split-bar",
  splitSeg: "usage-split-seg",
  /** A legend row (dataSet `cat`, `on`: its parts or items are open) and what opens under it. */
  legend: "usage-legend",
  legendItem: "usage-legend-item",
  /** The line that says how the context was counted. */
  counted: "usage-counted",
} as const;
