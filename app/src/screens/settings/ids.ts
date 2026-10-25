// The testIDs of the Settings area (package S1): Settings, its rows, About, the placeholders of the screens other packages build (the
// Appearance page's are in appearanceids.ts). A row's dataSet is `{ row: <name> }`, a placeholder's `{ screen: <name> }`.
export const S1_TID = {
  screen: "settings-screen",
  row: "settings-row",
  about: "about-screen",
  aboutRow: "about-row",
  placeholder: "settings-placeholder",
} as const;
