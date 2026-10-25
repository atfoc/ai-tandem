// The testIDs of Chat info on the phone (package T3 of ux-improvements). A check reads them by these names.
export const T3_INFO_TID = {
  /** The sheet (dataSet `chat`: the chat's key). */
  sheet: "chat-info",
  /** A row (dataSet `row`: name, agent, folder, server, context, tree, archive, unarchive or delete; `disabled` when it is faded). */
  row: "chat-info-row",
  /** The accent Rename at the end of the Name row, and the Copy at the end of the Folder row. */
  rename: "chat-info-rename",
  copy: "chat-info-copy",
} as const;
