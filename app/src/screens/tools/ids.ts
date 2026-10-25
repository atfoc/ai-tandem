// The testIDs of the tool steps, the full diff, the permission card and dock, the busy line and the subagents on the phone (package T2
// of ux-improvements; the shared ones are in ui/tid.ts). A check reads them by these names; the wide layouts keep their own ids
// (`tool-card`, `tool-row`, `perm`, `perm-allow`, `sub-row`, `sub-drawer`…), and the phone keeps those of them a check still reads.
export const T2_TID = {
  /** A step on the phone: the two-line card (dataSet `kind`, `state`, `failed`, `open`) and its parts. */
  step: "step",
  stepTitle: "step-title",
  stepLine: "step-line",
  /** "exit code 1" of a failed shell step. */
  stepExit: "step-exit",
  /** The "+5 −2" of an edit. */
  stepCounts: "step-counts",
  /** The command box with its Copy. */
  stepCommand: "step-command",
  stepCommandCopy: "step-command-copy",
  /** The output's last lines ("last 6 of 14 lines"), Show all output and its Copy. */
  stepOutput: "step-output",
  stepOutputAll: "step-output-all",
  stepOutputCopy: "step-output-copy",
  /** The diff under a fade (rows `diff-row` keep their id; dataSet `a`, `b`: the line numbers), Show full diff, Copy. */
  stepDiff: "step-diff",
  stepDiffFull: "step-diff-full",
  stepDiffCopy: "step-diff-copy",
  /** A run of steps that only read, folded to one row (dataSet `count`, `open`). */
  stepGroup: "step-group",
  /** The pushed full diff (screen `diff`): Wrap (dataSet `on`), Copy, the summary "+5 −2 · 2 changes", the jumps, a folded run. */
  diffScreen: "diff-screen",
  diffWrap: "diff-wrap",
  diffCopy: "diff-copy",
  diffSummary: "diff-summary",
  diffPos: "diff-pos",
  diffPrev: "diff-prev",
  diffNext: "diff-next",
  diffFold: "diff-fold",
  /** The permission card's who-line ("Claude wants to run a command"), its title, its full command. The buttons keep `perm-allow`,
   *  `perm-deny`; an answered card folded to one line is `perm-folded` (a tap opens it). */
  permWho: "perm-who",
  permCommand: "perm-command",
  permFolded: "perm-folded",
  permTime: "perm-time",
  /** The dock above the composer while a waiting card is off screen (dataSet `count`, `at`): "1 of 2", Show, Deny, Allow. */
  permDock: "perm-dock",
  permDockPos: "perm-dock-pos",
  permDockShow: "perm-dock-show",
  permDockAllow: "perm-dock-allow",
  permDockDeny: "perm-dock-deny",
  /** The busy line at the thread's foot on the phone: its seconds. */
  busySeconds: "busy-seconds",
  /** The subagents' card of a call (dataSet `count`, `running`), its head, a row's 60 pt target keeps `sub-row`. */
  subCard: "sub-card",
  subCardHead: "sub-card-head",
  /** The 48 pt row of a subagent's report in the thread. */
  subReport: "sub-report-row",
  /** The subagent's pushed screen: its pills, the headings' Copy, the folded steps, the bottom bar's previous and next. */
  subScreen: "sub-screen",
  subPills: "sub-pills",
  subPromptCopy: "sub-prompt-copy",
  subReportCopy: "sub-report-copy",
  subSteps: "sub-steps",
  subPrev: "sub-screen-prev",
  subNext: "sub-screen-next",
} as const;
