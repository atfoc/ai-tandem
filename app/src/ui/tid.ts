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
} as const;

/** `{testID, dataSet}` for a component to spread: tid("side-row", { server: id }). The dataSet is left out when empty. */
export function tid(testID: string, data?: DataSet): { testID: string; dataSet?: DataSet } {
  return data && Object.keys(data).length ? { testID, dataSet: data } : { testID };
}
