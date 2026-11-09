// The testIDs of Settings › Claude accounts (multiple-claude goal §1.1–§1.3, §1.6): the list (the phone's screen and the wide layouts' dialog
// both draw it), its rows and buttons, the add/edit sheet and its fields, and the login row. The chat side's checks rely on these names; a
// row's dataSet is { server, id } (the host row's { server }), the sheet's { mode: "add" | "edit", id }, a folder row's { path, pending }.
export const ACCOUNTS_TID = {
  screen: "accounts-screen",
  dialog: "accounts-dialog",
  list: "accounts-list",
  section: "accounts-section",
  host: "account-host",
  row: "account-row",
  chip: "account-chip",
  line: "account-line",
  pending: "account-pending",
  edit: "account-edit",
  loginButton: "account-login-button",
  logout: "account-logout",
  stop: "account-stop",
  restart: "account-restart",
  add: "account-add",
  addHint: "account-add-hint",
  sheet: "account-sheet",
  name: "account-name",
  folder: "account-folder",
  folderRemove: "account-folder-remove",
  addFolder: "account-add-folder",
  folderBrowser: "account-folder-browser",
  advanced: "account-advanced",
  image: "account-image",
  note: "account-note",
  remove: "account-remove",
  error: "account-error",
  save: "account-save",
  cancel: "account-cancel",
  login: "account-login",
  code: "account-code",
  codeSubmit: "account-code-submit",
  openAgain: "account-open-again",
  /** A login Claude ended (failed): starts a new one. */
  loginAgain: "account-login-again",
  loginCancel: "account-login-cancel",
  loginError: "account-login-error",
  /** The Settings dialog's row (the wide layouts) that opens the accounts dialog. */
  settingsOpen: "settings-accounts",
  close: "accounts-close",
} as const;

/** The name of the phone's place screen (and of Settings' row). */
export const ACCOUNTS_SCREEN = "claude-accounts";
