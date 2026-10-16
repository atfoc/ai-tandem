// What the end-to-end scripts of web/e2e know of the page they drive (the app's web build, app/dist-web; AD-80: testIDs and
// dataSet values, and the phone's stack): the selectors and the ways to navigate. The scenarios and the assertions are in the scripts.
//
//   q            CSS selectors by name (`q.row`, `q.composerInput`, ...): the parts of the page the scripts look at. A script builds
//                its locators from them, so `p.locator(q.chatRow)` is `[data-testid="side-row"][data-kind="chat"]`.
//   ui.*         what is not a selector: the sections' readers (`look`, `outline`), a press (a click with a mouse, a tap with a
//                finger), a hover, a menu, the Servers dialog, the composer's chips, a drag, and the phone's navigation (`toList`).
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
  remoteGone: `${T("remote-bar", { kind: "gone" })} ${T("remote-bar-text")}, ${T("remote-off", { kind: "gone" })} ${T("remote-off-text")}`,
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
};

export const exact = (s) => new RegExp(`^\\s*${String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);

// ---- the layout and the pointer

/** A press: a click with a mouse, a tap with a finger (the phone and tablet viewports). */
export const click = (p, locator, opts) => sel.press(p, locator, opts);
/** The pointer over it; a touch viewport has none. */
export const hover = (p, locator) => sel.hover(p, locator);
export const layout = (p) => sel.layoutNow(p);

/** Brings the sidebar's list on screen: on the phone back through the stack to it (the chat and the board are screens of it), else
 *  the sidebar shown if it was hidden. */
export async function toList(p) {
  await sel.showList(p);
}

/** Opens a row (a locator of a row of the list) the way the layout does: the list on screen, the row pressed. */
export async function openRow(p, row) {
  await toList(p);
  await row.first().scrollIntoViewIfNeeded().catch(() => {});
  await click(p, row.first());
}

// ---- the sidebar

/** What the page shows when it is open: the sidebar's tree. */
export const treeWait = q.tree;

/** The page's selection (the store's `sel`, kept in localStorage `aiwb.sel`). */
export const selection = (p) => p.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "{}"));

/** A section of the sidebar by the entry's name ("This computer" for the local one). */
export const sectionOf = (p, name) => p.locator(`${q.section}[aria-label=${JSON.stringify(name)}]`);
/** This computer's section. */
export const here = (p) => p.locator(`${q.section}[data-server="local"]`);
/** A section by the server's id in the page's list ("local" for this computer's). */
export const sectionById = (p, id) => p.locator(`${q.section}[data-server=${JSON.stringify(id)}]`);
export const stateOfSection = (p, id) => p.locator(`${q.section}[data-server=${JSON.stringify(id)}] ${q.sectionState}`);

/** A row by its kind ("chat" | "board") and name, within a scope (a page's sidebar, or a section). */
export const rowOf = (scope, kind, name) => {
  const page = scope.page ? scope.page() : scope;
  return scope.locator(kind === "chat" ? q.chatRow : q.boardRow).filter({ has: page.locator(q.rowName, { hasText: exact(name) }) });
};
export const groupHead = (scope, name) => {
  const page = scope.page ? scope.page() : scope;
  return scope.locator(q.groupHead).filter({ has: page.locator(q.groupName, { hasText: exact(name) }) });
};

/** Pointer over `head` (a head, a row), then the press of its button whose title starts with `title` ("New", "More"). */
export async function headButton(p, head, title) {
  await toList(p);
  await hover(p, head);
  const which = head.locator(`[title^=${JSON.stringify(title)}]`).first();
  await click(p, which);
}

/** The "+" of a head (the sidebar's, a section's, a group's): its menu opens, and `item` is picked. */
export async function plus(p, head, item) {
  await headButton(p, head, "New");
  await click(p, menuItem(p, item));
}

/** A row's or a group head's "More" menu, and an item of it; with `then`, an item of the list that item opens. */
export async function more(p, row, item, then) {
  await headButton(p, row, "More");
  await click(p, menuItem(p, item));
  if (then) await click(p, menuItem(p, then));
}

/** A button of this computer's section (Retry, Restart server, Open server log) by its words. */
export const sectionAction = (section, label) => section.locator(q.sectionExtra).getByRole("button", { name: exact(label) });

export const menuItem = (p, text) => p.locator(q.menuItem, { hasText: exact(text) });

/** The sidebar head's "+" and its item. */
export async function headPlus(p, item) {
  await toList(p);
  await click(p, p.locator(q.newBtn));
  await click(p, menuItem(p, item));
}

/** Types a name into the rename box that is open in a scope (a new board or group opens with one). */
export async function nameIt(scope, name) {
  const input = scope.locator(q.nameInput).first();
  await input.waitFor();
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

/** Names the board just made: its name box opens on the wide layouts; the phone opens the board's own screen, so its row is renamed from the list. */
export async function nameNewBoard(p, scope, name, { unnamed = "whiteboard" } = {}) {
  if (layout(p) !== "phone") return nameIt(scope, name);
  await more(p, rowOf(scope, "board", unnamed), "Rename");
  return nameIt(scope, name);
}

/** The switch "Show archived": set to `on`. */
export async function showArchived(p, on) {
  await toList(p);
  const sw = p.locator(q.archivedSwitch);
  const now = (await sw.getAttribute("aria-checked")) === "true";
  if (now !== on) await click(p, sw);
}

/** What a section shows (by its aria-label, the entry's name): its name, state, tone, whether it is collapsed, the lines it says, the lines
 *  and the reason this computer's section says of its server, the buttons beside them, how many rows it draws and whether it has a "+". */
export const lookOf = (p, name) => p.evaluate(({ name, q }) => {
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
}, { name, q });

/** The state words of a section by its name; "" when it is not drawn. */
export const stateWords = (p, name) => lookOf(p, name).then((l) => l?.state ?? "");

/** The tree a page shows in a section, as lines: a group and a board are followed by what is in them, two spaces further in. The same
 *  code reads the page's section of B and the owner's own section of B, so "the same tree" is the same lines. */
export const outline = (p, of) => p.evaluate(({ of, q }) => {
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
}, { of, q });

/** The state of a chat's row: the `data-state` of its `crow-dot`. */
export async function rowState(row) {
  return (await row.locator(T("crow-dot")).first().getAttribute("data-state").catch(() => "")) ?? "";
}

// ---- the composer and the thread

export const box = (p) => p.locator(q.composerInput);
export const boxText = (p) => box(p).evaluate((el) => el.innerText);
export const readOnly = (p) => box(p).getAttribute("aria-readonly").catch(() => null);

export async function send(p, text) {
  await click(p, box(p));
  await box(p).fill(text);
  await box(p).press("Enter");
}

export const msgs = async (p) => ({ user: await p.locator(q.msgUser).allInnerTexts(), assistant: await p.locator(q.msgAssistant).allInnerTexts() });

/** A chip of the composer's toolbar by what it is: "folder", "model", "effort", "agent". */
export const chip = (p, kind) => p.locator(`${T("tchip")}[data-kind=${JSON.stringify(kind)}]`);
/** The same for the folder of a chat of another server. */
export const folderChip = (p, serverName) => chip(p, "folder");
/** Presses a chip of the composer. The phone's toolbar has room for some of them: the others are in the popup of the "more" chip, which opens first. */
export async function openChip(p, kind, serverName) {
  const c = serverName ? folderChip(p, serverName) : chip(p, kind);
  if (!(await c.count())) {
    await click(p, p.locator(T("more-chip")));
    await c.first().waitFor();
  }
  await click(p, c.first());
}
/** Closes the "more" popup of the composer's toolbar if a pick left it open (the phone's pick of a chip that is in it: the list closes, the popup stays). */
export async function closeMore(p) {
  const rows = p.locator(T("more-row"));
  if (!(await rows.count())) return;
  await p.keyboard.press("Escape");
  if (await rows.first().waitFor({ state: "detached", timeout: 2000 }).then(() => false, () => true)) await click(p, p.locator(T("overlay-backdrop")).last(), { position: { x: 5, y: 5 } });
  await rows.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** Closes the folder picker if it is open (a step that failed in it: its sheet or popup would be over every later step). */
export async function closeDirs(p) {
  const d = p.locator(q.dirs);
  if (!(await d.count())) return;
  await p.keyboard.press("Escape").catch(() => {});
  if (await d.first().waitFor({ state: "detached", timeout: 2000 }).then(() => false, () => true)) await click(p, p.locator(T("overlay-backdrop")).last(), { position: { x: 5, y: 5 } }).catch(() => {});
  await d.first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
}

/** The words on a chip, read from the row or, when the chip is in the "more" popup, from there (the popup is closed again). */
export async function chipLabel(p, kind) {
  const c = chip(p, kind);
  if (await c.count()) return chipName(c.first());
  await click(p, p.locator(T("more-chip")));
  await c.first().waitFor();
  const name = await chipName(c.first());
  await closeMore(p);
  return name;
}

/** The words on a chip. */
export const chipName = (loc) => loc.locator(T("chip-name")).textContent().then((t) => (t ?? "").trim(), () => "");
/** The folder a chip shows, from its title ("Working directory: <path> — ..."), and the model's name. */
export async function shows(p) {
  const title = (await chip(p, "folder").getAttribute("title").catch(() => "")) ?? "";
  return {
    folder: title.replace(/ — .*$/, "").replace(/^Working directory: /, ""),
    model: (await chip(p, "model").innerText().catch(() => "")).replace(/[▾\s]+$/, "").trim(),
  };
}

/** The list a chip opened, its options not on, not off. */
export const otherOption = (p) => p.locator(`${T("pick-row")}:not([aria-selected="true"]):not([aria-disabled="true"])`).first();
export const optionId = (loc) => loc.getAttribute("data-option-id");
export const modelOption = (p, id) => p.locator(T("pick-row", { optionId: id }));

/** The folder picker of the composer, opened by its chip. */
export const dirs = (p) => p.locator(q.dirs);

// ---- the chat's header

/** Names the chat on screen through its header, so that its row can be found by name. */
export async function renameChat(p, name) {
  await click(p, p.locator(q.chatHeadName));
  const input = p.locator(q.chatNameInput);
  await input.fill(name);
  await input.press("Enter");
  await input.waitFor({ state: "detached" });
}

// ---- the Servers dialog

export const serversDialog = (p) => p.locator(q.serversDialog);
export const serverRow = (p, name) => serversDialog(p).locator(q.serversRow).filter({ has: p.locator(q.serversName, { hasText: exact(name) }) });
/** The button of a scope by its words. */
export const button = (scope, label) => scope.getByRole("button", { name: exact(label) });

export async function openServers(p) {
  await toList(p);
  await click(p, p.locator(q.serversBtn));
  const dlg = serversDialog(p);
  await dlg.waitFor();
  return dlg;
}
export async function closeServers(p) {
  const dlg = serversDialog(p);
  await click(p, button(dlg, "Close"));
  await dlg.waitFor({ state: "detached" });
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
  await toList(p);
  await click(p, locator);
}
/** A press on a section's head: it folds. */
export const fold = (p, section) => inList(p, sectionToggle(section));
/** A double press on something of the list. */
export async function dblclick(p, locator) {
  await toList(p);
  await locator.dblclick();
}
/** The titles of the buttons of a head (a section's "+", a row's "…"). */
export const headButtons = (head) => head.evaluate((el) => [...el.querySelectorAll('[data-testid="side-add"], [data-testid="side-more"]')].map((e) => e.getAttribute("title")));
/** Whether the element is draggable as HTML (the attribute): null, the app drags by the pointer. */
export const draggable = (el) => el.getAttribute("draggable");

/** A drag from one element to another, whole: a pointer drag (a mouse at once, a finger held first). */
export async function drag(p, from, to, opts = {}) {
  await toList(p);
  const t = await to.boundingBox();
  const at = opts.targetPosition ? { x: t.x + opts.targetPosition.x, y: t.y + opts.targetPosition.y } : to;
  return sel.dragTo(p, from, at);
}

/** A drag step by step, to look at the page while the pointer is over the target: { start(from), over(to), end() }. */
export async function dragger(p) {
  await toList(p);
  const d = await sel.pointerDragger(p);
  return { start: (from) => d.start(from), over: (to) => d.move(to), end: () => d.end(), cancel: () => d.cancel() };
}
