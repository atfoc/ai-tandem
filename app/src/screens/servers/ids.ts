// The testIDs of the phone's server screens (package S2), which the browser checks and Maestro read. Values a check reads are in the
// dataSet named beside each (`server`, `word`, `how`, …). No React here, so Node loads it.
export const S2_TID = {
  // the Servers list (03a)
  list: "srv-list",              // the screen's body
  row: "srv-row",                // a server's row; dataSet server (entry id), word (state word key)
  add: "srv-add",                // "+ Add server" at the end of the list
  plus: "srv-plus",              // the "+" of the bar
  // the server's one body (ServerFacts), on its detail screen and in its sheet
  facts: "srv-facts",            // dataSet server, word, place ("screen" | "sheet")
  head: "srv-head",              // the status header: tile, name, state word, the second line
  since: "srv-since",            // the second line ("since 9:12", "Checked just now")
  address: "srv-address",        // the address cell
  copy: "srv-copy",              // its Copy
  version: "srv-version",
  agents: "srv-agents",          // the agent chips
  certRow: "srv-cert-row",       // the certificate's cell (pushes the certificate screen)
  test: "srv-test",              // "Test connection" / "Test again"
  result: "srv-result",          // the test's answer in place; dataSet ok
  why: "srv-why",                // Unreachable: why, in plain words
  tries: "srv-tries",            // Unreachable: what to try, numbered
  openSettings: "srv-open-settings", // Local network off: the one button
  update: "srv-update",          // Too old: both versions and how to update
  owner: "srv-owner",            // this computer's things (desktop and test host only)
  edit: "srv-edit",              // the bar's "Edit"
  remove: "srv-remove",          // "Remove server…"
  certNotice: "srv-cert-notice", // Certificate changed: the danger notice
  compare: "srv-compare",        // its "Compare fingerprints"
  // the sheet (13a)
  sheet: "srv-sheet",
  sheetRow: "srv-sheet-row",     // dataSet row: name, cert, settings
  // the edit form (P3)
  editForm: "srv-edit-form",
  editField: "srv-edit-field",   // dataSet field (name, address, secret)
  // the certificate screen (05c)
  cert: "srv-cert",              // dataSet server, changed
  fpNow: "srv-fp-now",           // the fingerprint presented now, 16 blocks; dataSet tone (ok | bad | plain)
  fpOld: "srv-fp-old",           // accepted before, muted
  fpBlock: "srv-fp-block",
  command: "srv-command",        // the command that prints the true fingerprint, with Copy
  scanCompare: "srv-scan-compare", // "Or scan its code instead"
  pasteCompare: "srv-paste-compare", // "Or paste its code instead" (where there is no camera): opens the paste box
  pasteRead: "srv-paste-read",   // "Compare" for the pasted text
  trust: "srv-trust",            // "Trust the new certificate…"
  notNow: "srv-not-now",
  // the add flow (04)
  addChoose: "add-choose",       // the P1 "Add a server"; rows are ActionSheet's action-row, dataSet action scan | paste | manual | help
  addForm: "add-form",           // the P3 "New server"; dataSet step (check | trust | mismatch | paste | manual)
  addFilled: "add-filled",       // "Filled in from the code"
  addField: "add-field",         // dataSet field (name, address, secret, code)
  addLocalNet: "add-localnet",   // iOS: the local network is announced
  addTest: "add-test",           // "Test connection"
  addResult: "add-result",       // the test's answer as cells
  addMatch: "add-match",         // dataSet match (yes | no)
  addTrust: "add-trust",         // "Trust and save"
  addCancel: "add-cancel",       // the mismatch's only button
  scanner: "add-scanner",        // the camera screen (device)
  scanClose: "add-scan-close",
  scanPaste: "add-scan-paste",
  // the add flow, additions of chunk S2-7
  addHelp: "add-help",           // the "How do I set up a server?" notice
  addFormSheet: "add-form-sheet", // the P3 sheet around the form (`add-form` is the body inside it, with the step)
  addRead: "add-read",           // the paste step's "Use this text"
  addNote: "add-note",           // the paste step's answer to a text (the parser's words); dataSet ok
  addError: "add-error",         // the words of a failed test or save under the button
  addCompare: "add-compare",     // trust without a fingerprint from the code: "Compare it with the Fingerprint line the server printed"
  addAddress: "add-address",     // a code with several addresses: one to pick; dataSet address
  addSelfSigned: "add-selfsigned", // the manual step's switch
  addSettings: "add-open-settings", // local network refused: "Open Settings"
} as const;
