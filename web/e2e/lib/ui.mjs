// What the end-to-end scripts of web/e2e know of the page they drive (the app's web build, app/dist-web; AD-80: testIDs and
// dataSet values, and the phone's stack): the selectors and the ways to navigate. The scenarios and the assertions are in the scripts.
//
//   q            CSS selectors by name (`q.row`, `q.composerInput`, ...): the parts of the page the scripts look at. A script builds
//                its locators from them, so `p.locator(q.chatRow)` is `[data-testid="side-row"][data-kind="chat"]`.
//   ui.*         what is not a selector: the sections' readers (`look`, `outline`), a press (a click with a mouse, a tap with a
//                finger), a hover, a menu, the Servers dialog, the composer's chips, a drag, and the phone's navigation (`toList`).
//
// On the phone the first screen is Home (app/src/screens/home, plans/ux-improvements/h1-design.md), not the sidebar's tree: the helpers below
// that name the list (`toList`, `openRow`, `rowOf`, `headPlus`, `openFoot`, `openServers`, ...) take Home's path there (back to Home, the chip of
// the server, the group screens, the row; the gear and Settings for the foot; "+ New" and its sheet for making). They read the DOM alone, never a
// check seam, because the scripts may run on a build that is not a uicheck build. What has no counterpart on Home (the sections, the outline, the
// "More" menu of a row, a drag, a fold) throws `PhoneHasNone`: a script skips such a step on the phone (`ui.onPhone(p)`).
//
// The testIDs are in plans/rn-rewrite/{u3-shell,s1-sidebar,s3-servers,s4-chat,k3-composer}.md and in
// web/dev/checks/sel.mjs (IDS); a script that needs another asks the screen for it (a testID on the element).
import * as sel from "../../dev/checks/sel.mjs";

const T = (id, data) => (data ? sel.tidSel(id, data) : `[data-testid=${JSON.stringify(id)}]`);

export const q = {
  rootVisible: "#root *:visible",
  side: T("side"),
  tree: T("side-tree"),
  section: T("side-section"),
  sectionHead: T("side-section-head"),
  sectionName: T("side-section-name"),
  sectionState: T("side-section-state"),
  sectionLine: T("side-section-line"),
  sectionBody: T("side-section-body"),
  sectionExtra: T("side-section-extra"),
  sectionReason: T("side-section-reason"),
  row: T("side-row"),
  chatRow: T("side-row", { kind: "chat" }),
  boardRow: T("side-row", { kind: "board" }),
  rowName: T("side-name"),
  groupHead: T("side-group-head"),
  groupName: T("side-group-name"),
  loose: T("side-loose"),
  nameInput: T("name-input"),
  newBtn: T("side-new"),
  menu: T("menu"),
  menuItem: T("menu-item"),
  archivedSwitch: T("side-archived"),
  serversBtn: T("servers-btn"),
  home: T("home"),
  homeNewChat: T("home-new-chat"),
  boardBar: T("board-bar"),
  boardNewChat: T("board-new-chat"),
  boardCanvas: T("board-canvas"),
  boardRole: T("board-role"),
  boardRoleDropped: T("board-role-dropped"),
  boardTake: T("board-take"),
  boardEditing: T("board-editing"),
  canvasNote: T("save-banner"),
  composer: T("composer"),
  composerInput: T("composer-input"),
  chatComposerInput: T("composer-input"),
  thread: T("thread"),
  msg: T("msg"),
  msgUser: T("msg", { role: "user" }),
  msgAssistant: T("msg", { role: "assistant" }),
  permTitle: T("perm-title"),
  permCard: `${T("perm-title")}, ${T("perm-who")}`, // (a waiting permission card: its title on the wide layouts, its who-line on the phone (T2))
  permActions: T("perm-actions"),
  permAllow: T("perm-allow"),
  permDone: T("perm-done"),
  send: T("send"),
  stop: T("stop"),
  agentReason: T("agent-reason"),
  attach: T("attach-btn"),
  thumb: `${T("image-thumb")}:not([data-state="busy"]) img`,
  thumbRemove: T("image-thumb-remove"),
  chatHeadName: T("chat-head-name"),
  chatNameInput: T("chat-name-input"),
  chatHeadServer: T("chat-head-server"),
  remoteBar: T("remote-bar"),
  remoteBarOff: T("remote-bar", { kind: "off" }),
  remoteBarOffText: `${T("remote-bar", { kind: "off" })} ${T("remote-bar-text")}`,
  remoteGone: `${T("remote-bar", { kind: "gone" })} ${T("remote-bar-text")}, ${T("remote-off", { kind: "gone" })} ${T("remote-off-text")}, ${T("composer-block", { kind: "gone" })}`, // (the phone: V1's block in the toolbar's place)
  dirs: T("dirs"),
  dirHead: T("menu-head"),
  dirInput: T("dir-input"),
  dirsLoaded: T("dir-use"),
  dirItem: T("dir-item"),
  dirUse: T("dir-use"),
  dialog: `${T("dialog")}, ${T("confirm-dialog")}`,
  choices: `${T("tchip")}[data-fixed="false"]:not([disabled]):not([aria-disabled="true"])`,
  dialogBody: T("dialog-body"),
  dialogTitle: T("dialog-title"),
  serversDialog: T("servers-dialog"),
  serversRow: T("servers-row"),
  serversName: T("servers-name"),
  serversState: T("servers-state"),
  serversLine: T("servers-line"),
  serversMcp: T("servers-mcp"),
  serversForm: T("servers-form"),
  serversFp: T("servers-fp"),
  serversInput: T("servers-input"),
  serversSelf: T("servers-selfsigned"),
  dropMark: `${T("side-tree")} [data-drop], ${T("side-tree")} [data-drop-before]`,
  archivedTag: T("archived-tag"),
  draftTag: T("draft-tag"),
  group: T("side-group"),
  board: T("side-board"),
  // voice (screens/voice, plans/voice-chats/architecture.md): the foot's gear and Settings > Voice, the composer's two controls (or their
  // entries in the "more" popup), the speech bar, the mic mark, Read aloud, the problem popover and the board's orb
  settingsBtn: T("settings-btn"),
  settingsDialog: T("settings-dialog"),
  voiceKey: T("vs-key"),
  voiceKeyTest: T("vs-key-test"),
  voiceKeySave: T("vs-key-save"),
  voiceKeyResult: T("vs-key-result"),
  voiceKeyRemove: T("vs-key-remove"),
  voiceSettingsClose: T("vs-close"),
  voiceDictate: T("voice-dictate"),
  voiceSpeech: T("voice-speech"),
  moreChip: T("more-chip"),
  moreDictate: T("more-dictate"),
  moreSpeech: T("more-speech"),
  composerTools: T("composer-tools"),
  speechBar: T("speech-bar"),
  speechWords: T("speech-words"),
  speechCountdown: T("speech-countdown"),
  speechEnd: T("speech-end"),
  micMark: T("msg-mic"),
  readAloudAct: T("fk-act", { kind: "read" }),
  voiceReading: T("voice-reading"),
  voiceProblem: T("voice-problem"),
  voiceProblemText: T("voice-problem-text"),
  voiceProblemAct: T("voice-problem-act"),
  voiceProblemDismiss: T("voice-problem-dismiss"),
  pillOrb: T("pill-orb"),
  // the phone's Home (h1-design.md §8) and the screens it pushes
  homeRoot: T("home"),
  homeRow: T("home-row"),
  homeRowName: T("home-row-name"),
  homeRowSub: T("home-row-sub"),
  homeSub: T("home-sub"),
  homeNew: T("home-new"),
  homeGear: T("home-gear"),
  homeNewSheet: T("home-new-sheet"),
  newChat: T("new-chat"),
  newBoard: T("new-board"),
  newGroup: T("new-group"),
  renameSheet: T("rename-sheet"),
  homeSettings: T("home-settings-stopgap"),
  homePlaceholder: T("home-placeholder"),
  homeList: T("home-list"),
  serverChip: T("server-chip"),
  groupScreen: T("group-screen"),
  groupNew: T("group-new"),
  groupEmptyNew: T("home-empty-new"),
  problemCard: T("problem-card"),
  stateWord: T("state-word"),
  navBack: T("nav-back"),
  actionRow: T("action-row"),
  boardChats: T("board-chats"),
  chatsSheet: T("chats-sheet"),
  chatsSheetRow: T("chats-sheet-row"),
};

export const exact = (s) => new RegExp(`^\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

// ---- the layout and the pointer

/** A press: a click with a mouse, a tap with a finger (the phone and tablet viewports). */
export const click = (p, locator, opts) => sel.press(p, locator, opts);
/** The pointer over it; a touch viewport has none. */
export const hover = (p, locator) => sel.hover(p, locator);
export const layout = (p) => sel.layoutNow(p);

/** Whether the page is the phone layout: its first screen is Home. */
export const onPhone = (p) => layout(p) === "phone";

/** What the phone's Home has no counterpart of (a section, the outline, a row's "More", a drag, a fold): the step that needs it is skipped on the phone. */
export class PhoneHasNone extends Error {
  constructor(what) { super(`the phone's Home has no ${what}`); this.name = "PhoneHasNone"; }
}
const wideOnly = (p, what) => { if (onPhone(p)) throw new PhoneHasNone(what); };

// ---- the phone: Home, the chips, the group screens

const WAIT = 15000;
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

/** The stack's back, once, and a wait until the screen it left is gone (or a moment, for a stack that keeps its screens mounted). */
async function backOnce(p) {
  const b = p.locator(q.navBack).last();
  if (!(await b.isVisible())) return false;
  const h = await b.elementHandle();
  await click(p, b);
  await h?.waitForElementState("hidden", { timeout: 1500 }).catch(() => {});
  await nap(250);
  return true;
}

/** The server the chip of `server` (an entry id, or its name) stands for: the chip's `data-server`; null with one server (no chips). */
async function chipId(p, server) {
  const ids = await p.locator(q.serverChip).evaluateAll((els) => els.map((e) => ({ id: e.dataset.server, name: (e.textContent ?? "").trim() })));
  return ids.find((c) => c.id === server)?.id ?? ids.find((c) => c.name === server)?.id ?? (ids.length ? null : undefined);
}

/** Home on screen: back through the stack to it (the chat, the board and the group screens are screens above it), then the chip of `server`
 *  (an entry id or its name) pressed when chips are drawn and it is not the selected one. Answers the Home locator. */
export async function showHome(p, server) {
  for (let i = 0; i < 8; i++) if (!(await backOnce(p))) break;
  const home = p.locator(q.homeRoot).first();
  await home.waitFor({ state: "visible", timeout: WAIT });
  if (server) {
    const id = await chipId(p, server);
    if (id === null) throw new Error(`Home has no chip for the server "${server}"`);
    if (id) {
      const chip = p.locator(`${q.serverChip}[data-server=${JSON.stringify(id)}]`).first();
      if ((await chip.getAttribute("data-selected")) !== "true") await click(p, chip);
      await p.locator(`${q.homeRoot}[data-server=${JSON.stringify(id)}]`).first().waitFor({ state: "visible", timeout: WAIT });
    }
  }
  // (a list that is being drawn shows placeholders: rows are looked for once they are gone)
  await p.locator(q.homePlaceholder).first().waitFor({ state: "detached", timeout: WAIT }).catch(() => {});
  return home;
}

/** The word key of a server's state on Home ("connected", "connecting", "unreachable", "too-old", ...): its chip's, or with one server the
 *  word beside the title; null when Home does not draw it (not mounted, or no such server). Reads the DOM, so it works under a chat too. */
export const homeWord = (p, server) => p.evaluate(({ server, q }) => {
  const chips = [...document.querySelectorAll(q.chip)];
  const c = chips.find((e) => e.dataset.server === server || (e.textContent ?? "").trim() === server);
  if (c) return c.dataset.word ?? null;
  if (chips.length) return null;
  return document.querySelector(q.sub + " " + q.word)?.dataset.word ?? null;
}, { server, q: { chip: q.serverChip, sub: q.homeSub, word: q.stateWord } });

/** Waits until Home says the server (an entry id or its name; "local" for this computer's) is `word`. */
export async function waitHomeWord(p, server, word, timeout = 60000) {
  const id = server === "local" ? "local" : server;
  const t0 = Date.now();
  for (;;) {
    const w = (await homeWord(p, id)) ?? (id === "local" ? await homeWord(p, "This computer") : null);
    if (w === word) return true;
    if (Date.now() - t0 > timeout) throw new Error(`Home says "${w}" of ${server}, not "${word}"`);
    await nap(150);
  }
}

/** The rows (kind, key, name) of the screen on top: Home's list or the open group screen's. */
async function screenRows(p, scope) {
  return scope.locator(q.homeRow).evaluateAll((els, names) => els.map((e) => ({ kind: e.dataset.kind, key: e.dataset.key, name: (e.querySelector(names)?.textContent ?? "").trim() })), q.homeRowName);
}

/** On the screen `scope` (Home or a group screen) the row of `kind` named `name`: pressed when found; else each group is pushed, searched, and left. */
async function descend(p, scope, kind, name, depth) {
  const rows = await screenRows(p, scope);
  const hit = rows.find((r) => r.kind === kind && r.name === name);
  if (hit) {
    const row = scope.locator(`${q.homeRow}[data-kind=${JSON.stringify(kind)}][data-key=${JSON.stringify(hit.key)}]`).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await click(p, row);
    return true;
  }
  if (depth >= 4) return false;
  for (const g of rows.filter((r) => r.kind === "group")) {
    await click(p, scope.locator(`${q.homeRow}[data-kind="group"][data-key=${JSON.stringify(g.key)}]`).first());
    const screen = p.locator(`${q.groupScreen}[data-key=${JSON.stringify(g.key)}]`).first();
    await screen.waitFor({ state: "visible", timeout: WAIT });
    if (await descend(p, screen, kind, name, depth + 1)) return true;
    await backOnce(p);
  }
  return false;
}

/** What Home shows of a server's tree as lines like `outline`'s ("group Films", "  chat Owner chat"; a group's rows two spaces further in), each level
 *  sorted by its lines. Boards' chats are not on Home, so a board has none under it. Leaves the stack at Home. */
export async function homeOutline(p, server) {
  const out = [];
  const walk = async (scope, depth) => {
    const rows = await screenRows(p, scope);
    const pad = "  ".repeat(depth);
    const level = [];
    for (const r of rows) level.push({ line: `${pad}${r.kind} ${r.name}`, r });
    level.sort((a, b) => (a.line < b.line ? -1 : a.line > b.line ? 1 : 0));
    for (const { line, r } of level) {
      out.push(line);
      if (r.kind !== "group" || depth >= 4) continue;
      await click(p, scope.locator(`${q.homeRow}[data-kind="group"][data-key=${JSON.stringify(r.key)}]`).first());
      const screen = p.locator(`${q.groupScreen}[data-key=${JSON.stringify(r.key)}]`).first();
      await screen.waitFor({ state: "visible", timeout: WAIT });
      await walk(screen, depth + 1);
      await backOnce(p);
    }
  };
  await walk(await showHome(p, server), 0);
  return out;
}

/** Opens the chat or the board named `name` from Home: the chip of its server (`server`, an id or a name; every server's, in the order of the
 *  chips, when none is given), the groups pushed as far as it takes, the row pressed. A chat that sits on a board is not on Home: use `openBoardChat`. */
export async function openFromHome(p, kind, name, { server } = {}) {
  const ids = server ? [server] : await p.locator(q.serverChip).evaluateAll((els) => els.map((e) => e.dataset.server));
  for (const s of ids.length ? ids : [undefined]) {
    const home = await showHome(p, s);
    if (await descend(p, home, kind, name, 0)) return;
  }
  throw new Error(`Home has no ${kind} "${name}"${server ? ` on ${server}` : ""} (a chat of a board is not listed: open the board)`);
}

/** Opens a chat of a board: the board from Home, then its chat. The board screen's Chats button opens the chats (a sheet with `chats-sheet-row`
 *  rows, dataSet `key` = the chat's key, where the app has it); with no sheet the press has opened the board's chat and that is the one. */
export async function openBoardChat(p, boardName, chatKey, { server } = {}) {
  await openFromHome(p, "board", boardName, { server });
  const chats = p.locator(q.boardChats).first();
  await chats.waitFor({ state: "visible", timeout: WAIT });
  await click(p, chats);
  const row = p.locator(`${q.chatsSheetRow}[data-key=${JSON.stringify(chatKey)}]`).first();
  if (await row.waitFor({ state: "visible", timeout: 4000 }).then(() => true, () => false)) await click(p, row);
}

/** What a phone's make asks of the sheet: the make's own tile or row (H2's "New" sheet: Chat and Whiteboard as tiles, Group as a row). */
const NEW_ACTION = { "New chat": "chat", "New whiteboard": "board", "New group": "group", Chat: "chat", Whiteboard: "board", Group: "group" };
const NEW_MAKE = { chat: q.newChat, board: q.newBoard, group: q.newGroup };

/** What the open "New" sheet offers to make: the actions ("board", "chat", "group") whose tile or row it draws, sorted. */
export async function newSheetOffers(p) {
  const sheet = p.locator(q.homeNewSheet).first();
  await sheet.waitFor({ state: "visible", timeout: WAIT });
  const out = [];
  for (const [act, make] of Object.entries(NEW_MAKE)) if (await sheet.locator(make).count()) out.push(act);
  return out.sort();
}

/** "+ New" of the screen on top (Home's, a group screen's, an empty group's) and the sheet's make `item` ("New chat", "New whiteboard", "New group").
 *  A group opens H2's Rename sheet with the name the app gave it: it is closed with nothing typed, so the group keeps that name. */
async function newHere(p, item) {
  const act = NEW_ACTION[item];
  if (!act) throw new Error(`nothing "${item}" in the New sheet`);
  const btn = p.locator(`${q.homeNew}, ${q.groupNew}`).locator("visible=true").last();
  await click(p, btn);
  const sheet = p.locator(q.homeNewSheet).first();
  await sheet.waitFor({ state: "visible", timeout: WAIT });
  await click(p, sheet.locator(NEW_MAKE[act]).first());
  if (act !== "group") return;
  const rename = p.locator(q.renameSheet).first();
  if (!(await rename.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) return;
  await p.keyboard.press("Escape");
  await rename.waitFor({ state: "detached", timeout: WAIT });
}

/** Makes a thing on the phone at a place: Home of `server` (an id or a name; the one shown if none), the groups named in `groups` pushed one by one,
 *  then "+ New" and the sheet's row. The thing is made on that server, in that group, at once (a chat opens its screen, a board its screen). */
export async function makeAt(p, item, { server, groups = [] } = {}) {
  let scope = await showHome(p, server);
  for (const name of groups) {
    if (!(await descend(p, scope, "group", name, 99))) throw new Error(`Home has no group "${name}" here`);
    const g = p.locator(q.groupScreen).locator("visible=true").last();
    await g.waitFor({ state: "visible", timeout: WAIT });
    scope = g;
  }
  await newHere(p, item);
}

/** The foot's control `id` (a testID: `servers-btn`, `library-btn`, `settings-btn`, `theme-btn`, `side-archived`) pressed: on the wide layouts it is in the
 *  sidebar; on the phone Home's gear pushes Settings and the control is reached through its row (Servers, Library, Voice, Archived, Appearance), its
 *  placeholder's cell or switch pressed (`sel.openFoot`). */
export async function openFoot(p, id, { press = true } = {}) {
  if (!onPhone(p)) {
    await toList(p);
    const c = p.locator(`[data-testid=${JSON.stringify(id)}]`).first();
    if (press) await click(p, c);
    return c;
  }
  return sel.openFoot(p, id, { press });
}

/** Brings the list on screen: on the phone Home (back through the stack to it; the chat, the board and the groups are screens above it), else
 *  the sidebar shown if it was hidden. */
export async function toList(p) {
  if (onPhone(p)) await showHome(p);
  else await sel.showList(p);
}

// (a row locator that `rowOf` made on the phone remembers what it stands for, so that `openRow` can walk Home to it)
const homeRows = new WeakMap();

/** Opens a row (a locator of a row of the list) the way the layout does: the list on screen, the row pressed. On the phone a row of `rowOf` is
 *  found on Home by its kind and name (every server's chip, every group), a row that is on screen is pressed. */
export async function openRow(p, row) {
  const of = homeRows.get(row);
  if (onPhone(p) && of) return openFromHome(p, of.kind, of.name, { server: of.server });
  await toList(p);
  await row.first().scrollIntoViewIfNeeded().catch(() => {});
  await click(p, row.first());
}

// ---- the sidebar

/** What the page shows when it is open: the sidebar's tree, or on the phone Home. */
export const treeWait = `${q.tree}, ${q.homeRoot}`;

/** The page's selection (the store's `sel`, kept in localStorage `aiwb.sel`). */
export const selection = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));

/** A section of the sidebar by the entry's name ("This computer" for the local one). */
export const sectionOf = (p, name) => { wideOnly(p, "section"); return p.locator(`${q.section}[aria-label=${JSON.stringify(name)}]`); };
/** This computer's section. */
export const here = (p) => { wideOnly(p, "section"); return p.locator(`${q.section}[data-server="local"]`); };
/** A section by the server's id in the page's list ("local" for this computer's). */
export const sectionById = (p, id) => { wideOnly(p, "section"); return p.locator(`${q.section}[data-server=${JSON.stringify(id)}]`); };
export const stateOfSection = (p, id) => { wideOnly(p, "section state (use waitConnected / homeWord)"); return p.locator(`${q.section}[data-server=${JSON.stringify(id)}] ${q.sectionState}`); };

/** Waits until the server (an entry id, "local" for this computer's) is connected as the page shows it: the section's state on the wide layouts,
 *  Home's word on the phone. */
export async function waitConnected(p, id = "local", timeout = 90000) {
  if (onPhone(p)) return waitHomeWord(p, id, "connected", timeout);
  await stateOfSection(p, id).filter({ hasText: /^Connected$/ }).waitFor({ timeout });
}

/** A row by its kind ("chat" | "board") and name, within a scope (a page's sidebar, or a section). */
export const rowOf = (scope, kind, name, { server } = {}) => {
  const page = scope.page ? scope.page() : scope;
  if (onPhone(page)) {
    // (Home's rows of the screen on top; `openRow` walks Home to the row, so the locator says where it is looked for)
    const row = page.locator(`${q.homeRow}[data-kind=${JSON.stringify(kind)}]`).filter({ has: page.locator(q.homeRowName, { hasText: exact(name) }) });
    homeRows.set(row, { kind, name, server });
    return row;
  }
  return scope.locator(kind === "chat" ? q.chatRow : q.boardRow).filter({ has: page.locator(q.rowName, { hasText: exact(name) }) });
};
export const groupHead = (scope, name) => {
  const page = scope.page ? scope.page() : scope;
  wideOnly(page, "group head (a group is a row that opens a screen)");
  return scope.locator(q.groupHead).filter({ has: page.locator(q.groupName, { hasText: exact(name) }) });
};

/** Pointer over `head` (a head, a row), then the press of its button whose title starts with `title` ("New", "More"). */
export async function headButton(p, head, title) {
  wideOnly(p, `"${title}" button on a head (make with makeAt, or "+ New")`);
  await toList(p);
  await hover(p, head);
  const which = head.locator(`[title^=${JSON.stringify(title)}]`).first();
  await click(p, which);
}

/** The "+" of a head (the sidebar's, a section's, a group's): its menu opens, and `item` is picked. */
export async function plus(p, head, item) {
  wideOnly(p, "head with a \"+\" (make with makeAt)");
  await headButton(p, head, "New");
  await click(p, menuItem(p, item));
}

/** A row's or a group head's "More" menu, and an item of it; with `then`, an item of the list that item opens. */
export async function more(p, row, item, then) {
  wideOnly(p, "\"More\" menu on a row (H2 adds row actions)");
  await headButton(p, row, "More");
  await click(p, menuItem(p, item));
  if (then) await click(p, menuItem(p, then));
}

/** A button of this computer's section (Retry, Restart server, Open server log) by its words. */
export const sectionAction = (section, label) => section.locator(q.sectionExtra).getByRole("button", { name: exact(label) });

export const menuItem = (p, text) => p.locator(q.menuItem, { hasText: exact(text) });

/** The sidebar head's "+" and its item. */
export async function headPlus(p, item, { server, groups } = {}) {
  if (onPhone(p)) return makeAt(p, item, { server, groups });
  await toList(p);
  await click(p, p.locator(q.newBtn));
  await click(p, menuItem(p, item));
}

/** Types a name into the rename box that is open in a scope (a new board or group opens with one). */
export async function nameIt(scope, name) {
  // (the phone makes a board and a group with the name the app gives them: no name box opens, and Home has no rename until H2. Skipped there: answers false)
  const page = scope.page ? scope.page() : scope;
  if (onPhone(page)) return false;
  const input = scope.locator(q.nameInput).first();
  await input.waitFor();
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

/** Names the board just made: its name box opens on the wide layouts. The phone opens the board's own screen and Home has no rename (H2 adds it
 *  with the row actions): there the board keeps the name the app gave it ("whiteboard") and this answers false, so a script knows the name did not take. */
export async function nameNewBoard(p, scope, name, { unnamed = "whiteboard" } = {}) {
  if (onPhone(p)) return false;
  return nameIt(scope, name);
}

/** The switch "Show archived": set to `on`. */
export async function showArchived(p, on) {
  const sw = await openFoot(p, "side-archived", { press: false });
  const now = (await sw.getAttribute("aria-checked")) === "true";
  if (now !== on) await click(p, sw);
  if (onPhone(p)) await showHome(p);
}

/** What a section shows (by its aria-label, the entry's name): its name, state, tone, whether it is collapsed, the lines it says, the lines
 *  and the reason this computer's section says of its server, the buttons beside them, how many rows it draws and whether it has a "+". */
export const lookOf = (p, name) => (wideOnly(p, "section to look at (use homeWord)"), p.evaluate(({ name, q }) => {
  const s = [...document.querySelectorAll(q.section)].find((e) => e.getAttribute("aria-label") === name);
  if (!s) return null;
  const text = (e) => e?.textContent?.trim() ?? "";
  const lines = [...s.querySelectorAll(q.sectionLine)];
  const inExtra = (e) => !!e.closest(q.sectionExtra);
  const buttons = [...s.querySelectorAll(`${q.sectionExtra} [data-testid="btn"]`)].map(text);
  return {
    name: text(s.querySelector(q.sectionName)), state: text(s.querySelector(q.sectionState)),
    tone: s.dataset.tone ?? "",
    collapsed: s.dataset.collapsed === "true",
    lines: lines.filter((e) => !inExtra(e)).map(text), extra: lines.filter(inExtra).map(text), reason: s.querySelector(q.sectionReason)?.textContent ?? "", buttons,
    rows: s.querySelectorAll(`${q.row}, ${q.groupHead}`).length,
    add: !![...s.querySelectorAll(`${q.sectionHead} [title]`)].find((e) => (e.getAttribute("title") ?? "").startsWith("New on")),
  };
}, { name, q }));

/** The state words of a section by its name; "" when it is not drawn. */
export const stateWords = (p, name) => lookOf(p, name).then((l) => l?.state ?? "");

/** The tree a page shows in a section, as lines: a group and a board are followed by what is in them, two spaces further in. The same
 *  code reads the page's section of B and the owner's own section of B, so "the same tree" is the same lines. */
export const outline = (p, of) => (wideOnly(p, "tree to read an outline of"), p.evaluate(({ of, q }) => {
  const sec = [...document.querySelectorAll(q.section)].find((e) => e.getAttribute("aria-label") === of);
  const body = sec?.querySelector(q.sectionBody);
  const out = [];
  const named = (row) => (row.querySelector(q.rowName)?.textContent ?? row.querySelector(q.groupName)?.textContent ?? row.querySelector(q.nameInput)?.value ?? "?").trim();
  const tags = (row) => (row.querySelector(q.archivedTag) ? " [archived]" : "") + (row.querySelector(q.draftTag) ? " [draft]" : "");
  const isGroup = (el) => el.matches(q.group), isBoard = (el) => el.matches(q.board), isChat = (el) => el.matches(q.chatRow);
  const walk = (el, depth) => {
    const pad = "  ".repeat(depth);
    if (isGroup(el)) {
      const head = el.querySelector(q.groupHead);
      out.push(`${pad}group ${named(head)}${tags(head)}`);
      for (const c of el.querySelectorAll(":scope > *")) if (!c.matches(q.groupHead) && !c.contains(head)) walk(c, depth + 1);
      return;
    }
    if (isBoard(el)) {
      const row = el.querySelector(q.boardRow);
      out.push(`${pad}board ${named(row)}${tags(row)}`);
      for (const c of el.children) if (!c.contains(row) && c !== row) walk(c, depth + 1);
      return;
    }
    if (isChat(el)) { out.push(`${pad}chat ${named(el)}${tags(el)}`); return; }
    for (const c of el.children) walk(c, depth);
  };
  if (body) for (const c of body.children) walk(c, 0);
  return out;
}, { of, q }));

/** The state of a chat's row: the `data-state` of its `crow-dot`. */
export async function rowState(row) {
  // (Home's row says it in its sub-line: "Writing…", "Needs your approval", "Waiting on N subagents"; a row that is not on the screen on top says nothing)
  if (homeRows.has(row)) {
    const t = ((await row.locator(q.homeRowSub).first().textContent({ timeout: 1000 }).catch(() => "")) ?? "").trim();
    return /^Writing/.test(t) ? "writing" : /approval/.test(t) ? "approval" : /^Waiting on/.test(t) ? "thinking" : "";
  }
  return (await row.locator(T("crow-dot")).first().getAttribute("data-state").catch(() => "")) ?? "";
}

// ---- voice

/** Settings > Voice opened by the foot's gear (on the phone the list first). */
export async function openVoiceSettings(p) {
  await openFoot(p, "settings-btn");
  await p.locator(q.settingsDialog).first().waitFor();
}
/** Settings > Voice closed. */
export async function closeVoiceSettings(p) {
  await click(p, p.locator(q.voiceSettingsClose));
  await p.locator(q.settingsDialog).first().waitFor({ state: "detached" });
}
/** A voice control of the composer by its testID (`q.voiceDictate`, `q.voiceSpeech`): pressed where the toolbar puts it, in its row or, on a
 *  narrow row, as the entry of the "more" popup (`more` is that entry's selector). The toolbar draws the pair in the row until it has measured
 *  itself and then places it, so the place is waited for until it stays. */
export async function pressVoiceControl(p, row, more) {
  let last = "";
  for (let i = 0; i < 40; i++) {
    const at = await p.evaluate((tools) => { const t = document.querySelector(tools); return t ? `${t.dataset.voice}/${t.dataset.insert}/${t.dataset.more}` : ""; }, q.composerTools);
    if (at && at === last) break;
    last = at;
    await new Promise((r) => setTimeout(r, 150));
  }
  if (await p.locator(row).count()) { await click(p, p.locator(row).first()); return "row"; }
  await click(p, p.locator(q.moreChip));
  await p.locator(more).first().waitFor();
  await click(p, p.locator(more).first());
  return "more";
}

// ---- the composer and the thread

export const box = (p) => p.locator(q.composerInput);
export const boxText = (p) => box(p).evaluate((el) => el.innerText);
export const readOnly = (p) => box(p).getAttribute("aria-readonly").catch(() => null);

export async function send(p, text) {
  await click(p, box(p));
  await box(p).fill(text);
  await box(p).press("ControlOrMeta+Enter");
}

export const msgs = async (p) => ({ user: await p.locator(q.msgUser).allInnerTexts(), assistant: await p.locator(q.msgAssistant).allInnerTexts() });

/** A chip of the composer's toolbar by what it is: "folder", "model", "agent" (the effort has no chip: the model's says "<model> · <effort>"). */
export const chip = (p, kind) => p.locator(`${T("tchip")}[data-kind=${JSON.stringify(kind)}]`);
/** The same for the folder of a chat of another server. */
export const folderChip = (p, serverName) => chip(p, "folder");
/** The phone's chip row (C2): agent, folder, model and subagents, each opening its sheet; the effort has no chip, it is in the model sheet and
 *  the model chip says "<model> · <effort>". The wide toolbar the same: its model chip opens the model and effort menu (model-menu), a popover
 *  (plans/model-effort-menu/design.md 2.5). In both a row or a segment is a draft, which Done applies (closeMore). */
const PHONE_CHIP = { effort: "model" };
/** The wide toolbar's model and effort menu. */
const MENU = T("model-menu");
const PHONE_SHEET = { agent: "agent-sheet", folder: "folder-sheet", model: "model-sheet", effort: "model-sheet", subagents: "sub-sheet" };
/** The phone: the sheet a chip of `kind` opens. */
export const chipSheet = (p, kind) => p.locator(T(PHONE_SHEET[kind] ?? `${kind}-sheet`)).last();

/** Presses a chip of the composer. The wide toolbar has room for some of them: the others are in the popup of the "more" chip, which opens first.
 *  On the phone the chip's sheet opens (the effort's is the model sheet). */
export async function openChip(p, kind, serverName) {
  const c = serverName && !onPhone(p) ? folderChip(p, serverName) : chip(p, PHONE_CHIP[kind] ?? kind);
  if (!onPhone(p) && !(await c.count())) {
    await click(p, p.locator(T("more-chip")));
    await c.first().waitFor();
  }
  if (!onPhone(p)) {
    await click(p, c.first());
    if ((PHONE_CHIP[kind] ?? kind) === "model") await p.locator(MENU).first().waitFor({ state: "visible", timeout: WAIT });
    return;
  }
  // (the phone's composer is drawn again while a chat that was just opened on a remote server loads: a press on a chip that goes away is made again on the new one)
  for (let i = 0; ; i++) {
    try { await click(p, c.first(), i ? { timeout: 10000 } : undefined); break; }
    catch (e) { if (i >= 3) throw e; await nap(400); }
  }
  await chipSheet(p, kind).waitFor({ state: "visible", timeout: WAIT });
}
/** The press that opens the file chooser of the composer: the wide toolbar's attach button; on the phone "+" and its Files row (C1). */
export async function pressAttach(p, opts) {
  if (!onPhone(p)) return click(p, p.locator(q.attach), opts);
  await click(p, p.locator(T("composer-plus")).first(), opts);
  await click(p, p.locator(T("action-row", { action: "files" })).first(), opts);
}

/** The warning of a chat whose server is not connected: the wide bar over the thread; on the phone V1's block in the toolbar's place
 *  ("<server> is offline since 14:02." and "Your draft is kept until it's back."). */
export const offWarning = (p) => p.locator(onPhone(p) ? T("composer-block", { kind: "offline" }) : q.remoteBarOff);
/** Any warning of a chat's server (not connected, or the chat gone from it). */
export const anyWarning = (p) => p.locator(onPhone(p) ? `${T("composer-block", { kind: "offline" })}, ${T("composer-block", { kind: "gone" })}` : q.remoteBar);

/** The permission cards still waiting (their buttons), and the words of the decided ones: the wide card's verdict ("Approved", "Denied"); the
 *  phone's card folded to one line once answered (T2: "Allowed · …", "Denied · …"), its first word. */
export const waitingCards = (p) => p.locator(onPhone(p) ? T("perm-allow") : q.permActions).count();
export const decidedCards = async (p) => (onPhone(p)
  ? (await p.locator(T("perm-folded")).allInnerTexts()).map((t) => (t.match(/\b(Allowed|Denied)\b/) ?? [])[1] ?? t.trim())
  : p.locator(q.permDone).allInnerTexts());

/** Closes the "more" popup of the composer's toolbar if a pick left it open (the narrow toolbar's pick of a chip that is in it: the list closes, the
 *  popup stays); on the phone the chip's sheet that a pick left open (the model sheet: Done). */
export async function closeMore(p) {
  if (!onPhone(p) && await p.locator(MENU).count()) { // (the model and effort menu: Done applies the draft and closes it)
    await click(p, p.locator(MENU).first().locator(T("model-menu-done")));
    await p.locator(MENU).first().waitFor({ state: "detached", timeout: WAIT });
  }
  if (onPhone(p)) {
    // (a pick that closes its sheet leaves it going for a moment; a model with no effort leaves the model sheet with neither Done nor Cancel:
    // then the dimmed page above it closes it)
    const sheet = p.locator(Object.values(PHONE_SHEET).map((id) => T(id)).join(", "));
    if (!(await sheet.count())) return;
    if (await sheet.first().waitFor({ state: "detached", timeout: 1500 }).then(() => true, () => false)) return;
    const done = sheet.last().locator(`${T("sheet-right")}:visible, ${T("model-menu-done")}:visible`), cancel = sheet.last().locator(`${T("sheet-left")}:visible, ${T("model-menu-cancel")}:visible`);
    if (await done.count()) await click(p, done.first());
    else if (await cancel.count()) await click(p, cancel.first());
    else await click(p, p.locator(T("overlay-backdrop")).last(), { position: { x: 5, y: 5 } });
    await sheet.first().waitFor({ state: "detached", timeout: WAIT });
    return;
  }
  const rows = p.locator(T("more-row"));
  if (!(await rows.count())) return;
  await p.keyboard.press("Escape");
  if (await rows.first().waitFor({ state: "detached", timeout: 2000 }).then(() => false, () => true)) await click(p, p.locator(T("overlay-backdrop")).last(), { position: { x: 5, y: 5 } });
  await rows.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** Closes the folder picker if it is open (a step that failed in it: its sheet or popup would be over every later step). */
export async function closeDirs(p) {
  if (onPhone(p)) return closeMore(p); // (the phone: the folder sheet's Cancel)
  const d = p.locator(q.dirs);
  if (!(await d.count())) return;
  await p.keyboard.press("Escape").catch(() => {});
  if (await d.first().waitFor({ state: "detached", timeout: 2000 }).then(() => false, () => true)) await click(p, p.locator(T("overlay-backdrop")).last(), { position: { x: 5, y: 5 } }).catch(() => {});
  await d.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** The words on a chip, read from the row or, when the chip is in the "more" popup, from there (the popup is closed again). */
export async function chipLabel(p, kind) {
  // (the model chip says "<model> · <effort>": each is its part)
  const part = (words) => {
    const at = words.lastIndexOf(" · ");
    if (kind === "model") return at < 0 ? words : words.slice(0, at);
    if (kind === "effort") return at < 0 ? "" : words.slice(at + 3);
    return words;
  };
  const c = chip(p, PHONE_CHIP[kind] ?? kind);
  if (onPhone(p) || await c.count()) return part(await chipName(c.first()));
  await click(p, p.locator(T("more-chip")));
  await c.first().waitFor();
  const name = await chipName(c.first());
  await closeMore(p);
  return part(name);
}

/** The words on a chip. */
export const chipName = (loc) => loc.locator(T("chip-name")).textContent().then((t) => (t ?? "").trim(), () => "");
/** The folder a chip shows, from its title ("Working directory: <path> — ..."), and the model's name. */
export async function shows(p) {
  const title = (await chip(p, "folder").getAttribute("title").catch(() => "")) ?? "";
  return {
    folder: title.replace(/ — .*$/, "").replace(/^Working directory: /, ""),
    // (the model chip says "<model> · <effort>" when the model has efforts, its data-effort set: the model's part)
    model: await chip(p, "model").first().evaluate((e) => { const t = e.innerText.replace(/[▾\s]+$/, "").trim(), at = t.lastIndexOf(" · "); return e.dataset.effort && at >= 0 ? t.slice(0, at) : t; }).catch(() => ""),
  };
}

/** The list a chip opened, its options not on, not off. The model and effort menu (the wide popover, the phone's model sheet): the rows of the
 *  models not drafted, the effort's segments not on; the wide agent's list: its rows not chosen; the phone's agent sheet: its rows without the ✓. */
export const otherOption = (p, kind) => {
  if ((PHONE_CHIP[kind] ?? kind) === "model") {
    const menu = onPhone(p) ? chipSheet(p, kind) : p.locator(MENU).first();
    if (kind === "effort") return menu.locator(T("effort-seg")).locator(`${T("segment")}:not([data-on="true"])`).first();
    return menu.locator(`${T("model-menu-row")}:not([data-on="true"]):not([aria-disabled="true"])`).first();
  }
  if (!onPhone(p)) return p.locator(`${T("pick-row")}:not([aria-selected="true"]):not([aria-disabled="true"])`).first();
  return chipSheet(p, kind).locator(`${T("picker-row")}:not(:has(${T("picker-check")})):not([aria-disabled="true"])`).first();
};
/** The id of an option of `otherOption`: the wide list's option id, a sheet's or a segment's value, a model row's model. */
export const optionId = async (loc) => (await loc.getAttribute("data-option-id")) ?? (await loc.getAttribute("data-value")) ?? loc.getAttribute("data-model");
/** A model's row in the model and effort menu (a draft: closeMore applies it). */
export const modelOption = (p, id) => p.locator(T("model-menu-row", { model: id }));

/** The folder picker of the composer, opened by its chip (the phone: its sheet). */
export const dirs = (p) => (onPhone(p) ? chipSheet(p, "folder") : p.locator(q.dirs));
/** The folder picker's head: the wide menu's head ("Folder on <server>"); the phone sheet's title and its sub, the server ("Start the agent in · <server>"). */
export async function dirsHead(p) {
  const d = dirs(p);
  if (!onPhone(p)) return ((await d.locator(q.dirHead).first().textContent()) ?? "").trim(); // not innerText: the head is drawn in capitals
  const title = ((await d.locator(T("sheet-title")).first().textContent()) ?? "").trim();
  const sub = ((await d.locator(T("sheet-sub")).first().textContent().catch(() => "")) ?? "").trim();
  return sub ? `${title} · ${sub}` : title;
}
/** Types a path into the folder picker and goes there (the phone: a tap on the path shows the field first). */
export async function typeDir(p, path) {
  const d = dirs(p), input = d.locator(q.dirInput);
  if (onPhone(p) && !(await input.isVisible().catch(() => false))) {
    await click(p, d.locator(T("dir-path")).first());
    await input.waitFor({ state: "visible", timeout: WAIT });
  }
  await input.fill(path);
  await input.press("Enter");
}

// ---- the chat's header

/** Names the chat on screen through its header, so that its row can be found by name. */
export async function renameChat(p, name) {
  await click(p, p.locator(q.chatHeadName));
  if (onPhone(p)) { // (the phone: the head opens Chat info (T3), whose Rename closes it and opens H2's Rename sheet)
    await click(p, p.locator(T("chat-info")).last().locator(T("chat-info-rename")).first());
    const sheet = p.locator(q.renameSheet).last();
    await sheet.waitFor({ state: "visible", timeout: WAIT });
    const box = sheet.locator(T("rename-input")).first();
    await box.fill(name);
    await box.press("Enter");
    await sheet.waitFor({ state: "detached", timeout: WAIT });
    return;
  }
  const input = p.locator(q.chatNameInput);
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

// ---- the Servers dialog

export const serversDialog = (p) => p.locator(q.serversDialog);
export const serverRow = (p, name) => (onPhone(p)
  ? p.locator(T("srv-row")).filter({ has: p.getByText(exact(name)) }) // (the phone: S2's list, rows `srv-row`; the state is `data-word` of the row, its words the row's aria-label)
  : serversDialog(p).locator(q.serversRow).filter({ has: p.locator(q.serversName, { hasText: exact(name) }) }));
/** The button of a scope by its words. */
export const button = (scope, label) => scope.getByRole("button", { name: exact(label) });

/** The Servers dialog open (wide); at the phone S2's list (`srv-list`), pushed through Home's gear and Settings' Servers row. */
export async function openServers(p) {
  await openFoot(p, "servers-btn");
  if (onPhone(p)) {
    const list = p.locator(T("srv-list")).last();
    await list.waitFor();
    return list;
  }
  const dlg = serversDialog(p);
  await dlg.waitFor();
  return dlg;
}
export async function closeServers(p) {
  if (onPhone(p)) { // (the stack's back, out of a detail and then out of the list)
    for (let i = 0; i < 4 && await p.locator(`${T("srv-list")}, ${T("srv-facts")}`).count(); i++) await sel.back(p);
    await p.locator(`${T("srv-list")}, ${T("srv-facts")}`).first().waitFor({ state: "detached" });
    return;
  }
  const dlg = serversDialog(p);
  await click(p, button(dlg, "Close"));
  await dlg.waitFor({ state: "detached" });
}
/** The phone: the stack's back (true when there was one). */
export const stackBack = (p) => sel.back(p);
/** The phone: a server's detail (`srv-facts`), pushed from the list by its row. */
export async function openServerDetail(p, name) {
  if (!await p.locator(T("srv-list")).last().isVisible().catch(() => false)) await openServers(p);
  await click(p, serverRow(p, name).first());
  const facts = p.locator(T("srv-facts")).last();
  await facts.waitFor();
  return facts;
}
/** The phone: the manual form of S2's add flow (list "+" › Choose how › Type it in) filled, the test not yet pressed; answers the form's parts. */
export async function fillFormPhone(p, { name, address, secret, selfSigned }) {
  if (!await p.locator(T("srv-plus")).last().isVisible().catch(() => false)) await openServers(p);
  await click(p, p.locator(T("srv-plus")).last());
  await p.locator(T("add-choose")).waitFor();
  await click(p, p.locator(T("action-row", { action: "manual" })));
  const form = p.locator(T("add-form", { step: "manual" }));
  await form.waitFor();
  for (const [f, v] of [["name", name], ["address", address], ["secret", secret]]) await p.locator(T("add-field", { field: f })).fill(v);
  const sw = p.locator(T("add-selfsigned"));
  if (selfSigned && (await sw.getAttribute("aria-checked")) !== "true") await click(p, sw);
  return { test: p.locator(T("add-test")), trust: p.locator(T("add-trust")), fingerprint: p.locator(T("srv-fp-now")).last(), sheet: p.locator(T("add-form-sheet")).last() };
}
export async function fillForm(p, { name, address, secret, selfSigned }) {
  const dlg = serversDialog(p);
  await click(p, button(dlg, "Add server"));
  const form = dlg.locator(q.serversForm);
  const field = (f) => form.locator(T("servers-input", { field: f }));
  await field("name").fill(name);
  await field("address").fill(address);
  await field("secret").fill(secret);
  if (selfSigned) { const c = form.locator(q.serversSelf); if ((await c.getAttribute("aria-checked")) !== "true") await click(p, c); }
  return form;
}

// ---- dialogs and the states of a row

/** A button of the dialog open on the page (the confirm dialog), by its words. */
export const dialogButton = (p, label) => button(p.locator(q.dialog), label);
/** Whether a chat's state (`rowState`) is "at work" (the agent runs: thinking, writing, a tool), or waits for an answer to an ask. */
export const working = (state) => /^(thinking|writing|tool)$/.test(state ?? "");
export const waitsOrWorks = (state) => /^(approval|thinking|writing|tool)$/.test(state ?? "");

// ---- section heads, groups and dragging

/** The press that folds a section: the toggle in its head. */
export const sectionToggle = (section) => section.locator(T("side-section-toggle"));
/** A press on something of the list (a group head, a section's head): the list on screen first. */
export async function inList(p, locator) {
  wideOnly(p, "head to press in the list");
  await toList(p);
  await click(p, locator);
}
/** A press on a section's head: it folds. */
export const fold = (p, section) => inList(p, sectionToggle(section));
/** A double press on something of the list. */
export async function dblclick(p, locator) {
  wideOnly(p, "head to double-press");
  await toList(p);
  await locator.dblclick();
}
/** The titles of the buttons of a head (a section's "+", a row's "…"). */
export const headButtons = (head) => head.evaluate((el) => [...el.querySelectorAll('[data-testid="side-add"], [data-testid="side-more"]')].map((e) => e.getAttribute("title")));
/** Whether the element is draggable as HTML (the attribute): null, the app drags by the pointer. */
export const draggable = (el) => el.getAttribute("draggable");

/** A drag from one element to another, whole: a pointer drag (a mouse at once, a finger held first). */
export async function drag(p, from, to, opts = {}) {
  wideOnly(p, "drag (rows are moved from their sheet, H2)");
  await toList(p);
  const t = await to.boundingBox();
  const at = opts.targetPosition ? { x: t.x + opts.targetPosition.x, y: t.y + opts.targetPosition.y } : to;
  return sel.dragTo(p, from, at);
}

/** A drag step by step, to look at the page while the pointer is over the target: { start(from), over(to), end() }. */
export async function dragger(p) {
  wideOnly(p, "drag (rows are moved from their sheet, H2)");
  await toList(p);
  const d = await sel.pointerDragger(p);
  return { start: (from) => d.start(from), over: (to) => d.move(to), end: () => d.end(), cancel: () => d.cancel() };
}
