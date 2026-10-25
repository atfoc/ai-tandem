// The testIDs of the prompt library's phone screens and sheets (package S4; the shared ones are in ui/tid.ts). Values go in dataSet:
// a row's `{ server, id }`, a screen's `{ server, group }`, the editor's `{ mode, server }`. The insert popup's phone sheet keeps the
// testIDs of the wide popup (`insert-popup`, `insert-search`, `insert-row` …, in InsertPopup.tsx) so PL5.1 and PL5.2 read both.
export const S4_TID = {
  // the Library screen and a group screen (P5)
  libScreen: "lib-screen",               // the Library screen's scroll view
  groupScreen: "lib-group-screen",       // a group screen's scroll view { server, group }
  plus: "lib-plus",                      // "+" at the right of the Library screen's bar
  more: "lib-more",                      // "…" at the right of a group screen's bar
  search: "lib-phone-search",            // the 44 pt search of the Library screen (SearchField)
  section: "lib-section",                // a server's section { server } (a CellGroup; titled only when there are several)
  groupRow: "lib-group-row",             // a group, 60 pt { server, id }
  promptRow: "lib-prompt-row",           // a prompt { server, id }
  hitRow: "lib-hit-row",                 // a search hit, with its path { server, id }
  hitPath: "lib-hit-path",               // the path line of a hit
  newHere: "lib-new-here",               // "+ New prompt here" of a group screen
  foot: "lib-foot",                      // the footer line of a screen
  offNotice: "lib-off-notice",           // the one notice of a server that is not connected { server }
  fileNotice: "lib-file-notice",         // the notice of a library whose file was set aside { server }
  emptyLib: "lib-phone-empty",           // no prompts and no groups at all
  noHits: "lib-phone-none",              // a search that finds nothing
  hits: "lib-hits",                      // the card of a search's hits
  emptyRow: "lib-empty-row",             // a card row that only says "Empty" / "No prompts here yet"
  emptyNew: "lib-empty-new",             // the "New prompt" button of the empty library
  // the prompt editor (P3)
  editor: "prompt-editor",               // the FormSheet { mode: new | edit, server }
  editorName: "editor-name",
  editorGroup: "editor-group-row",       // the Group row: opens the move picker
  editorText: "editor-text",
  editorBar: "editor-kbar",              // the bar over the keyboard
  editorBarState: "editor-kbar-state",   // "Edited · not saved"
  editorBarDone: "editor-kbar-done",
  editorDelete: "editor-delete",         // Delete prompt… at the end
  editorOff: "editor-off-notice",        // the server is not connected: fields locked
  // the move picker (P2) and the group form (P3)
  movePicker: "move-picker",             // the PickerSheet; its rows are `picker-row` with value `${server}|${group}`
  groupForm: "group-form",               // { mode: new | rename }
  groupFormName: "group-form-name",
  groupFormWhere: "group-form-where",    // the Group row of a new group
  // the Prompt sheet of a composer (the insert popup on the phone)
  insertSection: "insert-section",       // a section head: "Recent" or a folder path
  insertLibrary: "insert-library",       // "Library" at the right of the head
  insertCancel: "insert-cancel",         // "Cancel" at the left of the head
  insertPopup: "insert-popup",           // the sheet itself (the wide popup's id)
  insertSearch: "insert-search",         // the 44 pt search, 17 pt
  insertList: "insert-list",             // the list: the Recent section, then the folders (or the hits)
  insertRow: "insert-row",               // a prompt, two lines { key, server, recent? }
  insertEmpty: "insert-empty",           // no prompts in any library, with `insertOpenLibrary`
  insertOpenLibrary: "insert-open-library",
  insertNone: "insert-none",             // a search that finds nothing
} as const;

/** The value of a move picker's row: a place as one string. */
export const placeValue = (server: string, group: string): string => `${server}|${group}`;
export const placeOf = (value: string): { server: string; group: string } => {
  const i = value.indexOf("|");
  return { server: value.slice(0, i), group: value.slice(i + 1) };
};

// chunk 2 (the editor's, the move picker's and the group form's parts)
export const S4_SHEET_TID = {
  editorBody: "prompt-editor-body",        // the editor's content: dataSet { mode, server } (FormSheet takes a testID only)
  groupFormBody: "group-form-body",        // the group form's content: dataSet { mode }
  groupFormProblem: "group-form-problem",  // what is wrong with the name, under the field
  editorProblem: "editor-problem",         // the same, for the editor's name
} as const;
