// Selectors of the browser checks and of Maestro (AD-80): identity by `testID` (react-native-web renders it as
// `data-testid`), values a check reads by `dataSet` (rendered as `data-*`; native ignores it), states by roles and aria-*.
// testIDs are kebab-case and reuse today's class names where one exists. This file types `dataSet` for the primitives of
// react-native (the augmentation below) and holds the ids the primitives of ui/ carry, so a check and a screen name them
// the same way. No React and no react-native values here, so Node loads it.

/** What a check reads from the page: `data-<key>="<value>"`. Entries that are undefined or null are not drawn. */
export type DataSet = Record<string, string | number | boolean | null | undefined>;

declare module "react-native" {
  interface ViewProps { dataSet?: DataSet }
  interface TextProps { dataSet?: DataSet }
  interface TextInputProps { dataSet?: DataSet }
  interface ImageProps { dataSet?: DataSet }
  interface PressableProps { dataSet?: DataSet }
}

/** The testIDs the primitives of ui/ draw (a screen's own ids are named in its own package). */
export const TID = {
  button: "btn",
  iconButton: "icon-btn",
  popover: "popover",
  dialog: "dialog",
  dialogTitle: "dialog-title",
  dialogBody: "dialog-body",
  sheet: "sheet",
  backdrop: "overlay-backdrop",
  menu: "menu",
  menuItem: "menu-item",
  menuHead: "menu-head",
  menuSep: "menu-sep",
  resizer: "resizer",
  picture: "picture",
  // the phone's parts (ux-improvements, package F1/F2: plans/ux-improvements/PLAN.md)
  sheetHead: "sheet-head",
  sheetTitle: "sheet-title",
  sheetSub: "sheet-sub",
  sheetLeft: "sheet-left",
  sheetRight: "sheet-right",
  actionSheet: "action-sheet",
  actionRow: "action-row",
  pickerSheet: "picker-sheet",
  pickerRow: "picker-row",
  formSheet: "form-sheet",
  confirmSheet: "confirm-sheet",
  confirmGo: "confirm-go",
  confirmCancel: "confirm-cancel",
  confirmAlt: "confirm-alt",
  cellGroup: "cell-group",
  cell: "cell",
  placeBar: "place-bar",
  contentBar: "content-bar",
  barTitle: "bar-title",
  barSub: "bar-sub",
  largeTitle: "large-title",
  navBack: "nav-back",
  stackSheet: "stack-sheet",
  toast: "toast",
  toastAction: "toast-action",
  swipeRow: "swipe-row",
  swipeAction: "swipe-action",
  searchField: "search-field",
  stateWord: "state-word",
  // F1's parts, finished (package F1). One block per part, so that its chunks append without touching each other: add a part's
  // ids at the end of its own block.
  // - controls (Button, IconButton, Switch, SecretInput, DialogActions, SearchField)
  searchClear: "search-clear",
  searchCancel: "search-cancel",
  switch: "switch",
  switchKnob: "switch-knob",
  // - sheets (Sheet, SheetHead, ActionSheet, Menu in a sheet)
  sheetBody: "sheet-body",
  actionQuick: "action-quick",
  actionSection: "action-section",
  // - picker (PickerSheet)
  pickerEmpty: "picker-empty",
  pickerCheck: "picker-check",
  pickerExtra: "picker-extra",
  pickerFoot: "picker-foot",
  // - forms (FormSheet, ConfirmSheet)
  formError: "form-error",
  confirmTile: "confirm-tile",
  confirmTitle: "confirm-title",
  confirmBody: "confirm-body",
  confirmError: "confirm-error",
  // - cells and bars (Cells, Bars)
  cellValue: "cell-value",
  cellSeparator: "cell-separator",
  barTitleFade: "bar-title-fade",
  // - toast (Toast)
  toastText: "toast-text",
  // - swipe (SwipeRow)
  swipeFront: "swipe-front",
  // (end of F1's blocks)
} as const;

/** `{testID, dataSet}` for a component to spread: tid("side-row", { server: id }). The dataSet is left out when empty. */
export function tid(testID: string, data?: DataSet): { testID: string; dataSet?: DataSet } {
  return data && Object.keys(data).length ? { testID, dataSet: data } : { testID };
}
