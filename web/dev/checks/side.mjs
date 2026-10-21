// The readers of the sidebar for the checks of the new build (a helper module of the sidebar's area: no dash in its name, so the
// runner does not take it for a check). These replaced `sideSeen`, `sectionsSeen` and `sideMenu` of dev/shot.mjs (gone with the page they read), which read
// the old page's classes, over the testIDs and `dataSet` values of app/src/screens/sidebar:
//   side-tree  side-section {server, tone, collapsed}  side-section-head {server}  side-section-toggle {server} (aria-expanded)
//   side-section-name  side-section-state {server, tone}  side-count  side-add  side-more  side-section-body  side-section-line
//   side-section-extra  side-section-reason  side-loose {group}  side-group {group, depth, archived}  side-group-head {group, depth}
//   side-group-name  side-group-body  side-board {board, archived}  side-board-chats  side-row {kind, key, archived}  side-name  side-sub
//   draft-tag  archived-tag  name-input  side-foot  side-archived (role switch)  servers-btn  library-btn  settings-btn  theme-btn
import { byTid, hover, openMenu, press, tidSel } from "./sel.mjs";

/** In the page: one section of the sidebar as it is drawn. id: the entry id of the section's server, "local" for this computer's.
 *    there      the part is drawn
 *    name, state, tone   a section's head: the server's name, the words of its state, "ok" | "wait" | "bad"
 *    collapsed  the section is collapsed; count: the number its head shows then, "" for none
 *    add        its head has the "+"; menu: its head has a menu button (a group's has, a section's must not)
 *    draggable  its head can be dragged
 *    lines      what its body says in the place of rows, or under them
 *    outline    its rows, top to bottom, each "<kind> <name>" indented by two spaces a level: "group Renders", "  board Storyboard",
 *               "    chat Tighten act two"; a group that is collapsed ends with " [collapsed]", a row that is archived with " [archived]"
 *    rows       the names of its board and chat rows, in that order; subs: the line under each chat row
 *    titles     the tooltip of each row and header */
function sidePartInPage(id) {
  const T = (t) => `[data-testid="${t}"]`;
  const root = [...document.querySelectorAll(T("side-section"))].find((s) => s.dataset.server === id);
  if (!root) return { there: false };
  const text = (e) => (e?.textContent ?? "").replace(/\s+/g, " ").trim();
  // (a row or a header that can be dragged stands in a `display: contents` div on web: the gesture detector's, S2. A walk goes through it.)
  const flat = (el) => [...(el?.children ?? [])].flatMap((c) => (!c.dataset.testid && c.style.display === "contents" ? flat(c) : [c]));
  const kid = (el, id) => flat(el).find((c) => c.dataset.testid === id) ?? null;
  const body = root.querySelector(`:scope > ${T("side-section-body")}`);
  const outline = [], titles = [];
  const row = (r, kind, depth) => {
    const archived = kind === "chat" ? r.dataset.archived === "true" : !!r.closest('[data-archived="true"]');
    outline.push(`${"  ".repeat(depth)}${kind} ${text(r.querySelector(T("side-name")))}${archived ? " [archived]" : ""}`);
    titles.push(r.getAttribute("title") ?? "");
  };
  const walk = (el, depth) => {
    for (const e of flat(el)) {
      const id = e.dataset.testid;
      if (id === "side-group") {
        const head = kid(e, "side-group-head"), inner = kid(e, "side-group-body");
        outline.push(`${"  ".repeat(depth)}group ${text(head.querySelector(T("side-group-name")))}${e.dataset.archived === "true" ? " [archived]" : ""}${inner ? "" : " [collapsed]"}`);
        titles.push(head.getAttribute("title") ?? "");
        walk(inner, depth + 1);
      } else if (id === "side-board") {
        row(kid(e, "side-row"), "board", depth);
        for (const c of flat(kid(e, "side-board-chats")).filter((c) => c.dataset.testid === "side-row")) row(c, "chat", depth + 1);
      } else if (id === "side-row") row(e, "chat", depth);
      else if (id === "side-loose") walk(e, depth);
    }
  };
  walk(body, 0);
  const mine = (sel) => [...(body?.querySelectorAll(sel) ?? [])];
  const head = root.querySelector(`:scope > ${T("side-section-head")}`), st = root.querySelector(T("side-section-state")), toggle = head.querySelector(T("side-section-toggle"));
  return { there: true, outline, titles, rows: mine(`${T("side-row")} ${T("side-name")}`).map(text), subs: mine(`${T("side-row")} ${T("side-sub")}`).map(text),
    lines: mine(T("side-section-line")).map(text),
    name: text(head.querySelector(T("side-section-name"))), state: text(st), tone: st?.dataset.tone ?? "", collapsed: toggle.getAttribute("aria-expanded") === "false",
    count: text(head.querySelector(T("side-count"))), add: !!head.querySelector(T("side-add")), menu: !!head.querySelector(T("side-more")),
    draggable: head.draggable === true || !!head.closest("[draggable=true]") };
}

/** What one section of the sidebar shows (see sidePartInPage): by its server's entry id, this computer's ("local") by default. */
export const sideSeen = (page, id = "local") => page.evaluate(sidePartInPage, id);

/** The entry ids of the sections the sidebar draws, top to bottom. */
export const sectionsSeen = (page) => page.evaluate(() => [...document.querySelectorAll('[data-testid="side-section"]')].map((s) => s.dataset.server));

/** The locator of a section of the sidebar by its server's entry id. */
export const section = (page, id) => byTid(page, "side-section", { server: id }).first();

/** A section's head (the whole line) and the part of it a press collapses. */
export const sectionHead = (page, id) => byTid(section(page, id), "side-section-head").first();
export const sectionToggle = (page, id) => byTid(section(page, id), "side-section-toggle").first();

/** A group's header in `root` (a section's locator, or the page when it is left out), by the group's name. `page` is the page the
 *  locators belong to: the inner locator of a filter is made from it. */
export const groupHead = (page, name, root = page) => byTid(root, "side-group-head").filter({ has: page.locator(`${tidSel("side-group-name")}:text-is(${JSON.stringify(name)})`) }).first();

/** A row (a chat or a board) in `root` by its exact name. */
export const rowNamed = (page, name, root = page) => byTid(root, "side-row").filter({ has: page.locator(`${tidSel("side-name")}:text-is(${JSON.stringify(name)})`) }).first();

/** A group of the section (or the page), by name, as a locator of its whole box. */
export const groupBox = (page, name, root = page) => byTid(root, "side-group").filter({ has: page.locator(`${tidSel("side-group-name")}:text-is(${JSON.stringify(name)})`) }).first();

/** Opens the menu of a row or a header of the sidebar (its "More" button, or its "+": `button` is the button's title) and presses the
 *  item that says `item`; with more items named, each next one in the list the one before opened ("Move to…", then a group). root: a
 *  locator of the row or the header. With no item the button is pressed (a board row's "+" makes a chat at once). */
export async function sideMenu(page, root, button, ...items) {
  await hover(page, root);
  const b = root.locator(`${tidSel("side-more")}[title=${JSON.stringify(button)}], ${tidSel("side-add")}[title=${JSON.stringify(button)}], ${tidSel("side-new")}[title=${JSON.stringify(button)}]`).first();
  if (!items.filter(Boolean).length) return press(page, b);
  return openMenu(page, b, ...items);
}

/** The foot's controls, each by its testID and what it says (the Servers button without its title, which tells of an entry that is not
 *  connected), and the foot's box. */
export const footOf = (page) => page.evaluate(() => {
  const foot = document.querySelector('[data-testid="side-foot"]'), r = foot.getBoundingClientRect();
  const ids = ["side-archived", "servers-btn", "library-btn", "settings-btn", "theme-btn"];
  return { controls: ids.map((id) => { const e = foot.querySelector(`[data-testid="${id}"]`); return `${id} ${e && id !== "servers-btn" && id !== "theme-btn" ? e.getAttribute("title") ?? "" : ""} ${e?.textContent.trim() ?? "MISSING"}`; }),
    box: [r.left, r.width, r.height, innerHeight - r.bottom].map(Math.round), inTree: !!foot.closest('[data-testid="side-tree"]') };
});
