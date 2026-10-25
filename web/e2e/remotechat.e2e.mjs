// Another server as a section of the sidebar, and this computer's server beside it, through the real pages
// (plans/remote-server-sections-goal.md, sections 2, 3 and 7; app-as-client-goal.md, 4.2, 4.4 and 7.1).
//
// A remote server is one place in the sidebar: a fixed section under this computer's that shows that machine's whole
// tree, the same tree to everyone who connects, and nothing while the server is not connected. The Go tests show that
// with stand-in clients; this script shows it with the pages themselves in a headless Chrome (Playwright), against two
// real servers, each page served by a test host (web/dev/host.mjs) that does for it what the app's main process does:
//
//   A   this computer's server, found or started by the host of "the page" with the server program (--local-bin).
//       Its section is "This computer", the first. The page is "the page": the client.
//   B   another machine's server, an entry of the page's server list ("Studio B"), reached over a link the script owns
//       (a TCP relay, which the host dials in the place of B's address), so that the script can pull the network while B
//       goes on, hold B's answers back, and put another server behind the entry's address. B's own app, "the owner's
//       page", is a second host whose this computer is B: the first section of its sidebar is B, and nothing else.
//
// The host's waits between two attempts to connect are lowered (backoff=3s, tooold=4s: AIWB_APP_WAITS' syntax, given to
// the host as `timing`), so that a return is seen in seconds; every other wait is the production one.
//
// It spends no money: both servers run the stand-in agent internal/agenttest/fake-claude and have no Cursor and no pi.
// It never touches the installed app: the script builds its own binary into a temp folder, sets both servers up there,
// runs them on temp data folders and on free ports (the MCP listeners too), and stops them at the end. Not part of
// `npm test`.
//
//   cd web && npm install --no-save playwright && npx playwright install chromium
//   node web/e2e/remotechat.e2e.mjs
//
// Steps (goal section in brackets):
//   1 the sidebar with no server in the list has this computer's section alone, and "+" asks nothing; B is added in
//     the Servers dialog: a section under this computer's with B's name and state: connecting (the line is made slow),
//     then connected with nothing on it; A's data folder holds no list and nothing of B    [3.1, 3.2, 3.12]
//   2 the owner makes a group, chats and a board on B's own page: the page's section shows the same tree with no
//     reload, and no row names a server                                                    [3.3, 3.11]
//   3 a chat, a whiteboard and a group from the section's "+", a chat and a group from a
//     group's "+" inside the section: each is on B at once, in its place, nothing asks where it
//     should live, and the owner's page shows it                                           [3.4]
//   4 a group of the section is renamed, moved, archived, unarchived and deleted from the page,
//     and the owner's page follows; the owner renames, makes and deletes one, and the page follows [3.5]
//   5 a board is moved by its menu, which lists the section's groups alone; a chat by a drag; a
//     drag from the section to this computer's and from this computer's into the section is not
//     taken and makes no request; a section's head is no group                             [3.2, 3.5]
//   6 collapse of the section and of a group in it: in localStorage, kept across a reload, sent
//     nowhere, and nothing changes for the owner; "Show archived" is one switch; two more entries
//     that never connect ("Certificate not accepted", "Fingerprint not accepted"): a section each,
//     in the order of the list; one collapses and stays so; removed, their sections go      [3.1, 3.2, 3.13]
//   7 a chat of the section: a folder of B's machine, a first message with a permission ask
//     answered on the page; the group's defaults are B's, the same for the page and the owner; an
//     image, which B alone keeps; a second message which both pages follow while the agent works,
//     an ask answered by the owner, a message of the owner's, the draft mark, and two writers in
//     one draft                                                                             [3.3, 3.4, 3.6, 5]
//     then a chat that has not started, open on both pages: the effort the owner picks shows in the
//     page's composer and the model the page picks in the owner's; and a Stop pressed on one page
//     while the agent works ends the turn on the other                                      [3.3, 3.6]
//   8 the link is pulled with the chat open: it stays, read-only, under the warning; what was
//     typed stays and is saved when B is back; left, the chat cannot be opened; a reload knows
//     nothing of B; a chat deleted on B meanwhile says so; and all the while this computer's section works  [3.7 to 3.9]
//   9 this computer's server is stopped while the page is open: its section says so and the host starts it again by
//     itself, B's section unmoved; B's process stops; a server that is too old stands behind the entry's address (a
//     stand-in with B's certificate that reports level 5); then, each with a stand-in of its own, what the list calls
//     "Secret not accepted", "Not an AI Whiteboard server", "Another server", "Name not known there" and "Certificate
//     changed": the section says the dialog's words and the one line; and then the real B again [3.2, 3.7, 3.10]
//   M a make and a first message whose answers do not arrive (B's answers are held back): the
//     page says so, nothing is cleaned up, and what was made shows when the answers flow    [3.4]
//   10 the entry is removed in the Servers dialog: the question says that everything stays there
//     and counts nothing; the section goes; B still has everything                          [3.12]
//
// It prints one line per check, `ok <n> <what>` or `FAIL <n> <what> — <what was seen>`, saves a
// screenshot for a failed check, and exits with 1 when a check failed (2 when it could not run).
//
// Environment (all optional):
//   AIWB_E2E_BIN       server binary                    (default: built into the temp folder)
//   DIST               the app's web build to serve (AIWB_E2E_CLIENT too): `cd app && npm run build:web`, then `DIST=app/dist-web`;
//                      without DIST the script builds its own into the temp folder. The host serves the page over plain HTTP and
//                      the page calls it from its own address, so the page's CSP needs `connect-src 'self'`
//                      (app/scripts/export-web.mjs `--connect-self`): an export that has it is used as it is, the shipped one
//                      (`connect-src 'none'`) is copied into the temp folder with that one change, and DIST itself is not touched
//   VIEWPORT=phone     the page is the phone layout of the app (an iPhone 15: a finger, Home and the chat as screens of a stack, the
//                      toolbar's folder and effort behind its "more" chip); the owner's page stays at a desk. Default: desktop.
//                      At the phone the page's server is a chip of Home and its state a word (`ui.waitHomeWord`), its tree what Home
//                      and the group screens list (`ui.homeOutline`), a make is "+ New" and its sheet (`ui.makeAt`). What Home has no
//                      counterpart of is skipped there, each with a comment: the sections' lines and folds, the "More" menu of a row,
//                      a name box for a new board or group, the drags, the draft mark of a row, "Show archived" as a switch beside
//                      the list, and the states of a server that Home folds into "Unreachable" (it keeps their words as the reason).
//   AIWB_E2E_KEEP=1    keep the temp folder (server logs, screenshots) after a run that passed;
//                      after a failed run it is always kept, and its path is printed
//   AIWB_E2E_SHOTS     a folder that gets a picture of the sidebar in each state the script brings a section to (no
//                      server, connecting, connected and empty, a tree, collapsed, not connected, too old and every
//                      other state of the list), numbered in the order they were taken, to be judged by eye
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import {
  Link, Scratch, all, callsFrom, finish, freePort, holds, hostApp, hostCall, hostFor, loadChromium, makeOut, onSignal, openPage as openHostPage, parseAppWaits, serverBinary, sleep, standInAgent, viewportContext, waitFor, writesFrom,
} from "./lib/rig.mjs";
import * as ui from "./lib/ui.mjs";

const { q } = ui;

// Everything the run makes: the binary, both servers' folders, the logs, screenshots.
const OUT = makeOut("remotechat");

// ---- pictures, to judge the sidebar by eye (AIWB_E2E_SHOTS): no check reads them
const SHOTS = process.env.AIWB_E2E_SHOTS ? path.resolve(process.env.AIWB_E2E_SHOTS) : "";
let shots = 0;
/** A picture of a page's sidebar as it is now; whole: of the whole page. */
async function shot(name, p, whole = false) {
  if (!SHOTS || !p) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${String(++shots).padStart(2, "0")}-${name}.png`);
  await (whole ? p.screenshot({ path: file }) : p.locator(q.side).screenshot({ path: file })).catch(() => {});
}

// ---- checks: one line each

let failed = 0;
let n = 0;
let page = null;  // the page: a failed check takes its screenshot and what it logged since the last check
let owner = null; // B's own page
let told = { errors: 0, requests: 0 };
async function check(what, pass, seen = "") {
  n++;
  const d = String(seen).replace(/\s+/g, " ").trim();
  if (pass === true) { console.log(`ok ${n} ${what}${d ? `  (${d})` : ""}`); }
  else {
    failed++;
    const extra = [];
    if (typeof pass === "string") extra.push(pass);
    if (page) {
      const errs = page.errors.slice(told.errors), reqs = page.failedRequests.slice(told.requests);
      if (errs.length) extra.push(`console: ${errs.slice(-4).join(" ; ")}`);
      if (reqs.length) extra.push(`requests: ${reqs.slice(-6).join(" ; ")}`);
      const file = path.join(OUT, `fail-${n}.png`);
      await page.screenshot({ path: file }).then(() => extra.push(`screenshot ${file}`), () => {});
      if (owner) await owner.screenshot({ path: path.join(OUT, `fail-${n}-owner.png`) }).catch(() => {});
    }
    console.log(`FAIL ${n} ${what} — ${[d, ...extra].filter(Boolean).join(" | ").replace(/\s+/g, " ") || "not as expected"}`);
  }
  if (page) told = { errors: page.errors.length, requests: page.failedRequests.length };
  return pass === true;
}
/** A step that threw: one failed check, and the script goes on with the next step. */
async function step(name, fn) {
  try { await fn(); }
  catch (e) {
    console.log(`# ${String(e.stack ?? e).split("\n").slice(0, 4).join(" | ")}`);
    await check(`${name}: the step ran to its end`, false, e.message);
    for (const p of [page, owner]) await p?.keyboard.press("Escape").catch(() => {});
  }
}

// ---- the two scratch servers, the link and the two apps

let A = null, B = null;
let link = null;
let host1 = null; // the page's app: A is this computer, B an entry of its list
let host2 = null; // B's own app: B is this computer
const A_NAME = "This computer", B_NAME = "Studio B";
const B_ONLY = "only-on-b";
/** A PNG of one pixel: the image a chat of the section is given. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
const hostOf = (s) => (s === A ? host1 : host2);

async function prepare() {
  const bin = serverBinary(OUT), agent = standInAgent(OUT);
  A = new Scratch({ out: OUT, bin, agent, tag: "a", name: A_NAME }); // the page's own
  B = new Scratch({ out: OUT, bin, agent, tag: "b", name: B_NAME });      // the other machine's
  fs.mkdirSync(path.join(B.work, B_ONLY)); // a folder of B's machine: a group of B remembers it
  await A.setUp();
  await B.setUp();
  await B.launch();
  link = await new Link(B.port).open();
  // The page's host dials the link in the place of every address but A's: the entries added in the Servers dialog stand
  // at addresses that nothing listens on, and what answers behind them is what the link leads to.
  const dial = (o) => net.connect(o.port === A.port ? o : { host: "127.0.0.1", port: link.port });
  host1 = await hostFor({ out: OUT, name: "page", local: A, extra: { dial, timing: parseAppWaits("backoff=3s,tooold=4s") } });
  host2 = await hostFor({ out: OUT, name: "owner", local: B, extra: { timing: parseAppWaits("backoff=3s,tooold=4s") } });
}
const setLink = (mode) => link.set(mode);

const get = (s, p) => hostCall(hostOf(s), "local", "GET", p);
const stateOf = async (s) => (await get(s, "/api/state")).json;
const chatOn = async (s, id) => (await stateOf(s))?.chats?.find((c) => c.id === id) ?? null;
const groupOn = async (s, name) => (await stateOf(s))?.groups?.find((g) => g.name === name) ?? null;
/** The user messages of a chat, as a server's client API gives them. */
const userTexts = async (s, id) => ((await get(s, `/api/chats/${id}/items`)).json?.items ?? []).filter((it) => it.kind === "user").map((it) => String(it.text ?? ""));
/** The draft B has of a chat's main branch, and its counter. */
const draftOn = async (id) => { const st = (await get(B, `/api/chats/${id}/items`)).json?.state; return { text: st?.draft?.text ?? "", rev: st?.draftRev ?? 0 }; };
/** B's entry in the page's server list (the app's own list: the host holds it). */
const entry = async () => ((await hostApp(host1, "servers.list")).json?.servers ?? []).find((v) => v.name === B.name) ?? null;
/** The page's connection to B: the entry connected and its section drawn with the tree. */
const connected = (timeout = 60000) => holds("the page is connected to B", async () => (await entry())?.state === "connected" && (await sectionLook())?.state === "Connected", { timeout, every: 200 });
/** How many things B has: nothing of it may go by what a client's page does to its own list. */
const census = async () => { const s = await stateOf(B); return { groups: s.groups.length, boards: s.boards.length, chats: s.chats.length }; };

let ENTRY = ""; // the id of B's entry in the page's list, once it is added
/** A thing's id on B, of the page's key of it ("<entry id>~<id>"). */
const own = (key) => String(key ?? "").split("~").pop();
const inB = (key) => String(key ?? "").startsWith(`${ENTRY}~`);

// ---- the pages

const VIEWPORT = process.env.VIEWPORT || "desktop"; // "phone": the page is the app's phone layout
const PHONE = VIEWPORT === "phone";
// The warning of a chat whose server is not connected, or that is gone from it: the wide bar; on the phone V1's block in the toolbar's place.
const WARN = PHONE ? '[data-testid="composer-block"][data-kind="offline"], [data-testid="composer-block"][data-kind="gone"]' : q.remoteBar;

let browser = null;
/** Opens the page of a scratch server's app (A: the page; B: the owner's) and waits for its this-computer section to be connected. */
async function openPage(s = A) {
  // (the page is the client at the viewport asked for; the owner's page is the owner at a desk)
  const context = s === A && VIEWPORT !== "desktop" ? await viewportContext(VIEWPORT) : undefined;
  const p = await openHostPage(browser, hostOf(s), { timeout: 10000, wait: ui.treeWait, context });
  await ui.waitConnected(p, "local", 90000);
  return p;
}
const sel = ui.selection;
const stored = (p, key) => p.evaluate((k) => localStorage.getItem(k), key);
const one = (o) => JSON.stringify(o);
const exact = ui.exact;
const menuItem = ui.menuItem;
const box = ui.box;
const boxText = ui.boxText;
const msgs = ui.msgs;
const counts = (m) => `${m.user.length} user, ${m.assistant.length} assistant`;
const noneTwice = (m) => new Set(m.user).size === m.user.length && new Set(m.assistant).size === m.assistant.length;
const replied = (p, text, timeout = 40000) => holds(`the reply to "${text}"`, async () => (await msgs(p)).assistant.some((t) => t.includes(text)), { timeout });

/** B's section on the page. At the phone there is none: the scope is the page, and `rowOf` looks the rows up on Home. */
const section = (p = page) => (PHONE && p === page ? p : ui.sectionOf(p, B.name));
/** What a section of a page shows, by the entry's name. At the phone Home says the server's word alone: its label ("Connected", "Connecting…",
 *  "Unreachable", "Too old", ...) as `state`, and nothing of rows, lines or a "+" (`rows`/`add` are undefined there, so a check that reads them is branched). */
const sectionLook = (p = page) => lookOf(B.name, p);
const WORD_TEXT = { connected: "Connected", connecting: "Connecting…", unreachable: "Unreachable", offline: "Offline", "cert-changed": "Certificate changed · paused", "too-old": "Too old" };
const serverId = (name) => (name === A.name ? "local" : name === B.name ? ENTRY || B.name : name);
const lookOf = async (name, p = page) => {
  if (!PHONE || p !== page) return ui.lookOf(p, name);
  const w = await ui.homeWord(p, serverId(name));
  return w ? { name, state: WORD_TEXT[w] ?? w, word: w, collapsed: false } : null;
};
/** Waits at the phone until Home says the word key of the server (an entry id or a name). */
const homeIs = (name, word, timeout = 30000) => holds(`Home says "${word}" of ${name}`, async () => (await ui.homeWord(page, serverId(name))) === word, { timeout, every: 100 });

/** The tree a page shows, as lines: of a section (of: its name; "" for this computer's). A group and a
 *  board are followed by what is in them, two spaces further in. The same code reads the page's section of B and the
 *  owner's own section of B, so "the same tree" is the same lines. At the phone Home's lists: the stack is left at Home (a chat open is closed). */
const outline = (p, of = "") => (PHONE && p === page ? ui.homeOutline(p, of && of !== A.name ? serverId(of) : "local") : ui.outline(p, of || A.name));
const lines = (o) => (o ?? ["(none)"]).map((l) => l.trim()).join(" / ");
/** Whether the page's section of B and the owner's own section of B show the same tree, each without a reload. A draft mark is
 *  each page's own word about the chat it has open, so it is left out. */
const plain = (o) => (o ?? []).map((l) => l.replace(" [draft]", ""));
// (at the phone Home lists groups, boards and chats without the boards' chats and without marks: the owner's lines are cut to the same, and both sorted)
const homeLike = (o) => plain(o).filter((l) => !/\[archived\]$/.test(l)).sort();
const sameTree = (timeout = 20000) => holds("the page's section shows the tree of the owner's page", async () => {
  const a = plain(await outline(page, B.name)), b = plain(await outline(owner));
  return a.length > 0 && (PHONE ? one(homeLike(a)) === one(homeLike(b)) : one(a) === one(b));
}, { timeout });
const bothTrees = async () => `the page's section: ${lines(await outline(page, B.name))} || the owner's page: ${lines(await outline(owner))}`;

/** A row by its name, within a scope (a page's sidebar, or B's section). */
const rowOf = ui.rowOf;
const groupHead = ui.groupHead;
const side = (p) => p.locator(q.tree);
/** This computer's section of a page: what the page keeps of its own server, as the owner sees all of B. */
const here = ui.here;

/** Opens the "+" of a head (the sidebar's, a section's, a group's) and picks an item of its menu. */
const plus = ui.plus;
/** Opens a row's or a group head's "More" menu and picks an item; with `then`, an item of the list that item opens. */
const more = ui.more;
/** Types a name into the rename box that is open in a scope (a new board or group opens with one). */
const nameIt = ui.nameIt;
/** Names the chat on screen through its header, so that its row can be found by name. */
async function renameChat(p, name) {
  await ui.renameChat(p, name);
  if (PHONE && p === page) return; // (Home's row is not on screen under the chat; `openRow` finds it by its name when it is needed)
  await rowOf(side(p), "chat", name).first().waitFor({ state: "attached", timeout: 15000 }); // (attached: the phone shows the chat, not the list)
}
/** A make on B from the page: the "+" of the section's head or of a group's head on the wide layouts; at the phone "+ New" of Home's
 *  chip of B (of the group's screen, the groups pushed one by one) and the sheet's row. `item`: "Chat" | "Whiteboard" | "Group". */
const NEW_ROW = { Chat: "New chat", Whiteboard: "New whiteboard", Group: "New group" };
const makeOnB = (item, group) => PHONE
  ? ui.makeAt(page, NEW_ROW[item], { server: ENTRY, groups: group ? [group] : [] })
  : plus(page, group ? groupHead(section(), group) : section().locator(q.sectionHead), item);
/** The key of the thing a page selects after `act`, which it did not select before. */
async function selected(p, kind, act) {
  const before = (await sel(p))[kind] ?? null;
  await act();
  return waitFor(`the page selects its new ${kind}`, async () => { const k = (await sel(p))[kind]; return k && k !== before ? k : null; }, { timeout: 45000 });
}
const send = ui.send;
const showArchived = ui.showArchived;
const dialogDo = async (p, label) => { await ui.click(p, ui.dialogButton(p, label)); };

// ---- the steps

/** A group made from the "+" of the sidebar's head: on the page's own server, its name box open. */
async function headGroup(p) {
  await ui.headPlus(p, "New group");
}
/** Whether the page made this call of the client API (the server, the method, the path before its query). */
const called = (p, server, method, path) => p.calls.some((c) => c.server === server && c.method === method && c.path.split("?")[0] === path);

const HERE = "Here", LOCAL_GROUP = "Local only";
const FILMS = "Films", OWNER_CHAT = "Owner chat", OWNER_LOOSE = "Owner loose", OWNER_BOARD = "storyboard"; // one word: a board's name is also its folder's
const TWO = "Two pages";
const MY_CHAT = "Made by A", MY_BOARD = "plan", MY_GROUP = "Shared", INNER = "Inner", IN_GROUP = "In the group";
const AWAY = `${B_NAME} is not connected`;
const WHY = `${AWAY}: nothing can be sent or changed until it is back.`;
const ONE_LINE = "Its chats show when the server is back.";
let chat0 = "", chatLoose = "", chatGroup = "", boardKey = "";

async function step1() {
  // No server but this computer: no section, and the "+" of the head asks nothing and offers no server.
  let none, offered;
  if (PHONE) {
    // (Home of one server draws no chips; "+ New" opens the sheet: Chat and Whiteboard as tiles, Group as a row)
    none = await page.locator(q.serverChip).count();
    await ui.click(page, page.locator(q.homeNew));
    await page.locator(q.homeNewSheet).first().waitFor();
    offered = await ui.newSheetOffers(page);
    await page.keyboard.press("Escape");
    await page.locator(q.homeNewSheet).first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
    await check("1 with no server in the list Home has no chip, and its \"+ New\" offers a chat, a whiteboard and a group", none === 0 && one(offered) === one(["board", "chat", "group"]), `chips ${none}; "+ New" offers ${one(offered)}`);
  } else {
    none = await page.locator('.side-section:not([data-server="local"])').count();
    await ui.click(page, page.locator(q.newBtn));
    offered = (await page.locator(q.menuItem).allInnerTexts()).map((t) => t.trim());
    await page.keyboard.press("Escape");
    await check("1 with no server in the list the sidebar has this computer's section alone, and its \"+\" offers a chat, a whiteboard and a group", none === 0 && one(offered) === one(["New chat", "New whiteboard", "New group"]),
      `sections ${none}; "+" offers ${one(offered)}`);
  }
  await shot("no-server-in-the-list", page);
  chat0 = await selected(page, "chat", async () => { await ui.headPlus(page, "New chat"); });
  await box(page).waitFor();
  await check("1 a new chat is made here at once and nothing asks where it should live", !!(await chatOn(A, chat0)), `A has the chat: ${!!(await chatOn(A, chat0))}`);
  await renameChat(page, HERE);
  if (!PHONE) { // (the phone makes a group with the name the app gives it and Home has no rename: no local group there)
    await headGroup(page);
    await nameIt(side(page), LOCAL_GROUP);
  }

  const flatFp = (t) => t.replace(/[^0-9a-f]/gi, "").toLowerCase();
  const typed = { name: B.name, address: `https://127.0.0.1:${B.port}`, secret: B.secret, selfSigned: true };
  let accept, shown, save, form, saveStep;
  if (PHONE) { // (S2's add flow: Test connection, the trust step shows the fingerprint, "Trust and save" saves; there is no separate Accept and Save)
    await ui.openServers(page);
    form = await ui.fillFormPhone(page, typed);
    await ui.click(page, form.test);
    accept = form.trust;
    await accept.waitFor({ timeout: 30000 });
    shown = (await form.fingerprint.locator('[data-testid="srv-fp-block"]').allInnerTexts()).join("");
  } else {
    await ui.openServers(page);
    form = await ui.fillForm(page, typed);
    await ui.click(page, ui.button(form, "Test connection"));
    accept = ui.button(form, "Accept fingerprint");
    await accept.waitFor({ timeout: 30000 });
    shown = (await form.locator(q.serversFp).last().innerText()).trim();
  }
  await check("1 the form shows the fingerprint that `remote setup` printed", flatFp(shown) === flatFp(B.fingerprint), `shown ${shown}, printed ${B.fingerprint}`);
  if (!PHONE) {
    await ui.click(page, accept);
    save = ui.button(form, "Save");
    await waitFor("Save is enabled after the accepted test", async () => !(await save.isDisabled()));
  }
  // The line is slow from here on: every answer of B takes a second and a half, so the entry's first connection takes seconds.
  setLink("slow");
  await ui.click(page, PHONE ? accept : save);
  const connecting = PHONE
    // (Home: the chip of B says "connecting" and the list is placeholders; its word is all there is to read)
    ? await holds('Home says "connecting" of B', async () => (await ui.homeWord(page, (await entry())?.id ?? B.name)) === "connecting", { timeout: 60000, every: 30 })
    : await holds('the section says "Connecting…" and shows no row, no line and no "+"', async () => { const l = await sectionLook(); return !!l && l.state === "Connecting…" && l.tone === "wait" && l.rows === 0 && l.lines.length === 0 && !l.add; }, { timeout: 60000, every: 30 });
  await check(PHONE ? '1 B is added, and while its first connection is being made Home says "connecting" of it' : '1 B is added, and while its first connection is being made its section says "Connecting…" and shows nothing else', connecting, one(await sectionLook()));
  await shot("connecting", page);
  setLink("pass");
  const row = ui.serverRow(page, B.name);
  const ok = await holds("the row reads Connected", async () => PHONE ? (await row.first().getAttribute("data-word")) === "connected" : (await row.locator(q.serversState).innerText()) === "Connected", { timeout: 60000 });
  await check(`1 the link passes again: the entry connects by itself, and its row in the Servers ${PHONE ? "list" : "dialog"} reads "Connected"`, ok, `row: ${(await row.innerText().catch(() => "no row")).replace(/\n/g, " / ")}`);
  await ui.closeServers(page);
  ENTRY = (await entry())?.id ?? "";
  B.instance = B.info.instanceId; // (a stand-in that takes B's place reports it: a server without one is no AI Whiteboard server)

  // The section: under the local part, with the name and the state, and the line of a server with nothing on it.
  if (PHONE) {
    // (Home: with two servers there is a chip each, this computer's first; B's says "connected" and its list is empty, which Home draws as its empty state)
    const chips = await page.locator(q.serverChip).evaluateAll((els) => els.map((e) => e.dataset.server));
    const said = await holds("Home says connected of B", async () => (await ui.homeWord(page, ENTRY)) === "connected", { timeout: 60000 });
    const empty = (await ui.homeOutline(page, ENTRY)).length === 0;
    await check("1 B has a chip on Home after this computer's, its word is \"connected\", and nothing is on it", said === true && empty && one(chips) === one(["local", ENTRY]), `chips ${one(chips)}; B's tree ${one(await ui.homeOutline(page, ENTRY))}`);
  } else {
    const empty = await holds("the section says that B has nothing on it", async () => (await sectionLook())?.lines.join("|") === "Nothing on this server yet.", { timeout: 20000 });
    const look = await sectionLook();
    const order = (await page.locator(q.section).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).join(",");
    await check("1 B has a section under this computer's, with its name, the state \"Connected\", the line that nothing is on it, and a \"+\"",
      empty === true && look?.name === B.name && look.state === "Connected" && look.tone === "ok" && look.rows === 0 && look.add && order === `${A.name},${B.name}`, `${one(look)}; order ${order}`);
  }
  await shot("connected-nothing-on-it", page);
  // What the server keeps and what the app keeps: A's own snapshot has nothing of B and its data folder holds no list and no file of a remote
  // thing; the list is the app's, in its state folder, in a file that only its user reads (the secrets are in it).
  const st = await stateOf(A);
  const files = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => /^servers|record|makes/i.test(f));
  const list = path.join(host1.stateDir, "servers.json");
  const mode = fs.existsSync(list) ? fs.statSync(list).mode & 0o777 : -1;
  await check("1 A's snapshot has nothing of B and no thing of A's own names a server, A's data folder holds no server list and no file of a remote thing, and the app's list is a file only its user reads",
    !!ENTRY && !("sections" in st) && [...st.chats, ...st.boards].every((x) => !("server" in x)) && files.length === 0 && mode === 0o600 && fs.readFileSync(list, "utf8").includes(B.name),
    `entry ${ENTRY}; sections in the snapshot ${"sections" in st}; files ${one(files)}; the app's list ${list} mode ${mode.toString(8)}`);
}

async function step2() {
  owner = await openPage(B);
  // The owner's page is the page it always was: a group, a chat in it, a loose chat and a board, each made by a click there.
  await headGroup(owner);
  await nameIt(side(owner), FILMS);
  await selected(owner, "chat", () => plus(owner, groupHead(side(owner), FILMS), "Chat"));
  await box(owner).waitFor();
  await renameChat(owner, OWNER_CHAT);
  await selected(owner, "chat", async () => { await ui.headPlus(owner, "New chat"); });
  await box(owner).waitFor();
  await renameChat(owner, OWNER_LOOSE);
  await selected(owner, "board", async () => { await ui.headPlus(owner, "New whiteboard"); });
  await nameIt(side(owner), OWNER_BOARD);
  const same = await sameTree();
  const a = await outline(page, B.name);
  await check("2 what the owner made on B's own page shows in A's section with no reload: the same groups, the same things in them, the loose ones first",
    same === true && one(plain(a)) === one([`board ${OWNER_BOARD}`, `chat ${OWNER_LOOSE}`, `group ${FILMS}`, `  chat ${OWNER_CHAT}`]), await bothTrees());
  await shot("connected-the-owners-tree", page);
  await shot("the-owners-own-page", owner);
  if (!PHONE) { // (a row of Home is read by its name; the check of the sections' rows has no counterpart)
    const rows = await section().locator(`${q.row}, ${q.groupHead}`).evaluateAll((els) => els.map((e) => `${e.textContent} ${e.getAttribute("title") ?? ""}`));
    await check("2 no row of the section names the server, and no row says who made it", rows.length === 4 && rows.every((t) => !t.includes(B.name) && !/owner\b.*made|made by/i.test(t.replace(OWNER_CHAT, "").replace(OWNER_LOOSE, ""))), one(rows));
  }
  const local = await outline(page);
  await check("2 the local part holds what lives on this computer alone", one(local) === one(PHONE ? [`chat ${HERE}`] : [`chat ${HERE}`, `group ${LOCAL_GROUP}`]), lines(local));
  const none = await owner.locator(q.section).count(), remote = await groupOn(B, "Remote");
  await check('2 the owner\'s page has no group "Remote" and one section only: its own, B', none === 1 && !remote, `sections on the owner's page ${none}; a group "Remote" on B: ${!!remote}`);
}

async function step3() {
  const made = callsFrom(page);
  // The section's "+": a chat, a whiteboard and a group, each on B, outside any group.
  let offered;
  if (PHONE) {
    // (Home of B's chip: "+ New" and its sheet)
    await ui.showHome(page, ENTRY);
    await ui.click(page, page.locator(q.homeNew));
    await page.locator(q.homeNewSheet).first().waitFor();
    offered = await ui.newSheetOffers(page);
    await page.keyboard.press("Escape");
    await page.locator(q.homeNewSheet).first().waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  } else {
    await ui.headButton(page, section().locator(q.sectionHead), "New on");
    offered = (await page.locator(q.menuItem).allInnerTexts()).map((t) => t.trim());
    await shot("the-plus-of-a-sections-head", page, true);
    await page.keyboard.press("Escape");
  }
  chatLoose = await selected(page, "chat", () => makeOnB("Chat"));
  await box(page).waitFor();
  const c1 = await chatOn(B, own(chatLoose));
  await check("3 the section's \"+\" offers a chat, a whiteboard and a group; \"Chat\" makes one on B at once, in no group, unstarted, and A has none of it",
    one(offered) === one(PHONE ? ["board", "chat", "group"] : ["Chat", "Whiteboard", "Group"]) && inB(chatLoose) && !!c1 && c1.locked === false && (c1.group ?? "__ungrouped__") === "__ungrouped__" && !(await chatOn(A, own(chatLoose))),
    `offered ${one(offered)}; key ${chatLoose}; B's chat ${one(c1 && { group: c1.group, locked: c1.locked })}`);
  await renameChat(page, MY_CHAT);

  boardKey = await selected(page, "board", () => makeOnB("Whiteboard"));
  // (the phone cannot name the board it made: Home has no rename, so B has it under the name the app gave it)
  const named = await ui.nameNewBoard(page, section(), MY_BOARD);
  const b1 = await holds("B has the board under its name", async () => (await stateOf(B)).boards.some((b) => b.id === own(boardKey) && (named === false ? true : b.name === MY_BOARD) && (b.group ?? "__ungrouped__") === "__ungrouped__"));
  await check("3 \"Whiteboard\" makes a board on B at once and asks nothing", inB(boardKey) && b1 === true && (await stateOf(A)).boards.length === 0, `key ${boardKey}; on B: ${b1}; boards of A: ${(await stateOf(A)).boards.length}`);

  if (PHONE) {
    // (the group the page makes keeps the app's name, so the later steps' group is made by the owner, who names it)
    const groups0 = new Set((await stateOf(B)).groups.map((g) => g.id));
    await makeOnB("Group");
    const g1 = await holds("B has a new group", async () => (await stateOf(B)).groups.some((g) => !groups0.has(g.id) && !g.parent));
    await check("3 \"Group\" makes a group on B, at the top level, and A has none of it", g1 === true && (await stateOf(A)).groups.length === 0, `on B: ${g1}; groups of A: ${(await stateOf(A)).groups.length}`);
    await headGroup(owner);
    await nameIt(side(owner), MY_GROUP);
    await holds("B has the group the owner made", async () => !!(await groupOn(B, MY_GROUP)));
    await holds("Home lists it", async () => (await outline(page, B.name)).includes(`group ${MY_GROUP}`));
  } else {
    await plus(page, section().locator(q.sectionHead), "Group");
    await nameIt(section(), MY_GROUP);
    const g1 = await holds("B has the group", async () => { const g = await groupOn(B, MY_GROUP); return !!g && !g.parent; });
    await check("3 \"Group\" makes a group on B, at the top level, and A has none of it", g1 === true && !(await groupOn(A, MY_GROUP)), `on B: ${g1}; on A: ${!!(await groupOn(A, MY_GROUP))}`);
  }

  // A group's "+" inside the section: the chat and the group are made in that group.
  const gid = (await groupOn(B, MY_GROUP))?.id;
  chatGroup = await selected(page, "chat", () => makeOnB("Chat", MY_GROUP));
  await box(page).waitFor();
  const c2 = await chatOn(B, own(chatGroup));
  await renameChat(page, IN_GROUP);
  const nested0 = new Set((await stateOf(B)).groups.map((g) => g.id));
  await makeOnB("Group", MY_GROUP);
  if (!PHONE) await nameIt(section(), INNER);
  const g2 = await holds("B has the nested group", async () => PHONE ? (await stateOf(B)).groups.some((g) => !nested0.has(g.id) && g.parent === gid) : (await groupOn(B, INNER))?.parent === gid);
  await check("3 a group's \"+\" in the section makes a chat and a group in that group, on B, and asks nothing", inB(chatGroup) && c2?.group === gid && g2 === true,
    `B's chat ${one(c2 && { group: c2.group })}, the group ${gid}; nested on B: ${g2}`);

  // Every make was one call to B's server (the call names the entry, the path is B's own) with B's own ids, and none named a server or a collapse.
  // (the phone's last make is not over when B has its result: the page's record of the call has its status a moment later)
  if (PHONE) await holds("the page has recorded the answer of every make", async () => made().filter((c) => c.method === "POST" && /^\/api\/(chats|boards|groups)$/.test(c.path)).every((c) => c.status), { timeout: 15000 });
  const posts = made().filter((c) => c.method === "POST" && /^\/api\/(chats|boards|groups)$/.test(c.path));
  const bad = made().filter((c) => c.method !== "GET" && c.method !== "APP" && (c.server !== ENTRY || /"(server|collapsed)"/.test(c.body) || c.body.includes(`${ENTRY}~`)));
  await check("3 each was made by one call to B's server, with B's own ids, naming no server", posts.length === 5 && posts.every((c) => c.status === 200 && c.server === ENTRY) && bad.length === 0,
    `makes ${one(posts.map((c) => `${c.method} ${c.server} ${c.path} ${c.status} ${c.body}`))}; others ${one(bad.map((c) => `${c.method} ${c.server} ${c.path} ${c.body}`))}`);
  const same = await sameTree();
  await check("3 the owner's page shows what the client made, in the group it was made in, with no reload", same === true && plain(await outline(owner)).includes(`  chat ${IN_GROUP}`), await bothTrees());
  await shot("connected-a-tree-with-groups", page, true);
}

async function step4() {
  // From the page: rename, move to the top level (a drag), archive, unarchive, delete with what is in it.
  await more(page, groupHead(section(), MY_GROUP), "Rename");
  await nameIt(section(), "Shared work");
  const renamed = await holds("B and the owner's page have the new name", async () => !!(await groupOn(B, "Shared work")) && (await outline(owner)).includes("group Shared work"));
  await check("4 a group of the section is renamed from the page: B has the name and the owner's page shows it with no reload", renamed, await bothTrees());
  await more(page, groupHead(section(), "Shared work"), "Rename");
  await nameIt(section(), MY_GROUP);
  await waitFor("the name is back", async () => !!(await groupOn(B, MY_GROUP)));

  // The nested group is dragged to the section's ungrouped area: it is at the top level on B.
  const drag = writesFrom(page);
  await ui.drag(page, groupHead(section(), INNER), section().locator(q.loose));
  const top = await holds("the group is at B's top level", async () => { const g = await groupOn(B, INNER); return !!g && !g.parent; }, { timeout: 15000 });
  await check("4 a nested group is dragged to the top level of the section: moved on B, by one call, and the owner's page follows", top === true && (await sameTree()) === true && drag().length === 1 && /\/groups\/[^/]+\/move$/.test(drag()[0]),
    `on B: ${top}; calls ${one(drag())}; ${await bothTrees()}`);
  // And back into the group, by a drag onto it.
  await ui.drag(page, groupHead(section(), INNER), groupHead(section(), MY_GROUP), { targetPosition: { x: 60, y: 22 } });
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const nested = await holds("the group is nested on B again", async () => (await groupOn(B, INNER))?.parent === gid, { timeout: 15000 });
  await check("4 and dragged into a group of the section: nested on B, and the owner's page follows", nested === true && (await sameTree()) === true, `on B: ${nested}; ${await bothTrees()}`);

  await more(page, groupHead(section(), INNER), "Archive");
  const archived = await holds("B has the group archived", async () => (await groupOn(B, INNER))?.archived === true);
  const hidden = await holds("the row is gone from both pages", async () => !(await outline(page, B.name)).some((l) => l.includes(INNER)) && !(await outline(owner)).some((l) => l.includes(INNER)));
  await showArchived(page, true);
  await showArchived(owner, true);
  const tagged = await holds("both pages show it as archived", async () => (await outline(page, B.name)).includes(`  group ${INNER} [archived]`) && (await outline(owner)).includes(`  group ${INNER} [archived]`));
  await check("4 a group of the section is archived from the page: archived on B, gone from both pages, and shown as archived with \"Show archived\"", all(archived, hidden, tagged), await bothTrees());
  await more(page, groupHead(section(), INNER), "Unarchive");
  const back = await holds("B has the group unarchived", async () => (await groupOn(B, INNER))?.archived !== true && !!(await groupOn(B, INNER)));
  await showArchived(page, false);
  await showArchived(owner, false);
  await check("4 and unarchived from the page", all(back, await sameTree()), await bothTrees());

  // Deleted with what is in it: a chat is made in it first, by the owner.
  await selected(owner, "chat", () => plus(owner, groupHead(side(owner), INNER), "Chat"));
  await box(owner).waitFor();
  await renameChat(owner, "Doomed");
  await rowOf(section(), "chat", "Doomed").waitFor({ timeout: 15000 });
  const doomed = (await stateOf(B)).chats.find((c) => c.name === "Doomed")?.id;
  await more(page, groupHead(section(), INNER), "Delete");
  const body = await page.locator(q.dialogBody).innerText().catch(() => "");
  await dialogDo(page, "Delete everything in it");
  const gone = await holds("B has neither the group nor the chat in it", async () => !(await groupOn(B, INNER)) && !(await chatOn(B, doomed)));
  await check("4 a group of the section is deleted from the page with everything in it: the question says that it is deleted on B for everyone, B has neither, and the owner's page follows",
    all(gone, await sameTree()) === true && body.includes(B.name) && body.includes("for everyone"), `question: "${body}"; ${await bothTrees()}`);

  // The reverse: the owner renames a group, makes one and deletes it.
  await more(owner, groupHead(side(owner), FILMS), "Rename");
  await nameIt(side(owner), "Movies");
  const seen = await holds("A's section has the owner's name for the group", async () => (await outline(page, B.name)).includes("group Movies") && !(await outline(page, B.name)).includes(`group ${FILMS}`));
  await headGroup(owner);
  await nameIt(side(owner), "Passing");
  const came = await holds("A's section has the owner's new group", async () => (await outline(page, B.name)).includes("group Passing"));
  await more(owner, groupHead(side(owner), "Passing"), "Delete");
  await dialogDo(owner, "Delete everything in it");
  const went = await holds("A's section lost the group the owner deleted", async () => !(await outline(page, B.name)).includes("group Passing"));
  await more(owner, groupHead(side(owner), "Movies"), "Rename");
  await nameIt(side(owner), FILMS);
  await check("4 the reverse: the owner renames a group, makes one and deletes it, and the page's section follows each with no reload", all(seen, came, went, await sameTree()), await bothTrees());
}

async function step5() {
  // A board by its menu: "Move to…" lists the groups of its own section, and nothing of this computer or of a server.
  const row = rowOf(section(), "board", MY_BOARD);
  await ui.headButton(page, row, "More");
  await ui.click(page, menuItem(page, "Move to…"));
  const targets = (await page.locator(q.menuItem).allInnerTexts()).map((t) => t.trim());
  const moved = writesFrom(page);
  await ui.click(page, menuItem(page, MY_GROUP));
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const there = await holds("B has the board in the group", async () => (await stateOf(B)).boards.find((b) => b.id === own(boardKey))?.group === gid);
  await check("5 a board of the section is moved by its menu: the list has the section's groups alone, and the board is in the group on B",
    there === true && one([...targets].sort()) === one([FILMS, MY_GROUP].sort()) && moved().length === 1 && moved()[0] === `PATCH /api/boards/${own(boardKey)}` && called(page, ENTRY, "PATCH", `/api/boards/${own(boardKey)}`), `targets ${one(targets)}; calls ${one(moved())}; on B: ${there}`);

  // A chat by a drag onto a group of its own section.
  const dragged = writesFrom(page);
  await ui.drag(page, rowOf(section(), "chat", MY_CHAT), groupHead(section(), FILMS), { targetPosition: { x: 60, y: 22 } });
  const films = (await groupOn(B, FILMS))?.id;
  const inFilms = await holds("B has the chat in the group", async () => (await chatOn(B, own(chatLoose)))?.group === films, { timeout: 15000 });
  await holds("the page's call is recorded", async () => dragged().length > 0, { timeout: 5000 }); // (the browser's events of a request come a little after its effect)
  await check("5 a chat of the section is moved by a drag onto another group of the section: one call, and B has it there", inFilms === true && dragged().length === 1 && dragged()[0] === `PATCH /api/chats/${own(chatLoose)}` && called(page, ENTRY, "PATCH", `/api/chats/${own(chatLoose)}`) && (await sameTree()) === true,
    `calls ${one(dragged())}; on B: ${inFilms}; ${await bothTrees()}`);

  // Across: from the section to the local part, and from the local part into the section. Neither is taken, and no request is made.
  const before = { a: await outline(page), b: await outline(page, B.name) };
  const across = callsFrom(page);
  const lit = async () => page.locator(q.dropMark).count();
  const drops = [
    ["a chat of the section onto a local group", rowOf(section(), "chat", MY_CHAT), groupHead(side(page), LOCAL_GROUP)],
    ["a chat of the section onto the local ungrouped area", rowOf(section(), "chat", OWNER_LOOSE), here(page).locator(q.loose)],
    ["a group of the section onto a local group", groupHead(section(), FILMS), groupHead(side(page), LOCAL_GROUP)],
    ["a local chat onto a group of the section", rowOf(side(page), "chat", HERE), groupHead(section(), MY_GROUP)],
    ["a local group onto the section's ungrouped area", groupHead(side(page), LOCAL_GROUP), section().locator(q.loose)],
    ["a local chat onto the section's head", rowOf(side(page), "chat", HERE), section().locator(q.sectionHead)],
  ];
  const litDuring = [];
  for (const [what, from, to] of drops) {
    // (by hand, to look at the drop mark while the pointer is over the target)
    const d = await ui.dragger(page);
    await d.start(from);
    await d.over(to);
    await sleep(150);
    if (await lit()) litDuring.push(what);
    await d.end();
    await sleep(150);
  }
  await sleep(800);
  const after = { a: await outline(page), b: await outline(page, B.name) };
  const reqs = across().filter((c) => c.method !== "GET");
  await check("5 a drag from the section to the local part, and from the local part into the section, is not taken: no zone lights, nothing moves and no request is made",
    litDuring.length === 0 && reqs.length === 0 && one(before) === one(after), `lit for: ${one(litDuring)}; requests ${one(reqs.map((c) => `${c.method} ${c.path}`))}; before ${one(before)}; after ${one(after)}`);

  // The head of a section is not a group's: no menu, no rename, not dragged, and "+" alone beside its name.
  const head = section().locator(q.sectionHead);
  await ui.dblclick(page, head);
  const rename = await section().locator(`${q.sectionHead} ${q.nameInput}`).count();
  if ((await sectionLook()).collapsed) await fold(); // (two clicks collapse and expand; one more if a click was lost)
  const looks = { draggable: await ui.draggable(head), buttons: await ui.headButtons(head), rename };
  await check("5 a section's head is no group's: it is not dragged, has no menu and no rename, and its one button is the \"+\"", looks.draggable !== "true" && one(looks.buttons) === one([`New on ${B.name}`]) && rename === 0, one(looks));
}

/** A press on a section's head: it folds. */
const fold = (sec = section()) => ui.fold(page, sec);

async function step6() {
  const ownerSees = await outline(owner);
  const quiet = callsFrom(page);
  await fold();
  const closed = await holds("the section is collapsed", async () => { const l = await sectionLook(); return l.collapsed && l.rows === 0; });
  const kept1 = await stored(page, "aiwb.collapsed");
  await check("6 a click on the section's head collapses it: no row is drawn, and the entry's id is in localStorage \"aiwb.collapsed\"", closed === true && JSON.parse(kept1 ?? "[]").includes(ENTRY), `stored ${kept1}; ${one(await sectionLook())}`);
  await shot("collapsed", page);
  await fold();
  await waitFor("the section is expanded", async () => !(await sectionLook()).collapsed);
  await ui.inList(page, groupHead(section(), FILMS));
  const gid = (await groupOn(B, FILMS))?.id;
  const folded = await holds("the group of the section is collapsed", async () => !(await outline(page, B.name)).some((l) => l === `  chat ${OWNER_CHAT}`) && JSON.parse((await stored(page, "aiwb.collapsed")) ?? "[]").includes(`${ENTRY}~${gid}`));
  await fold();
  await waitFor("the section is collapsed again", async () => (await sectionLook()).collapsed);
  await sleep(1000);
  const sent = quiet().filter((c) => c.method !== "GET");
  const there = (await stateOf(B)).groups.find((g) => g.id === gid);
  await check("6 a group of the section collapses the same way, and nothing of it is sent: no request at all, B's group is as it was, and the owner's page shows it open",
    folded === true && sent.length === 0 && !there?.collapsed && one(await outline(owner)) === one(ownerSees), `requests ${one(sent.map((c) => `${c.method} ${c.path} ${c.body}`))}; B's group ${one(there)}; stored ${await stored(page, "aiwb.collapsed")}`);

  await page.reload();
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  const still = await holds("after a reload the section is collapsed", async () => (await sectionLook())?.collapsed === true && (await sectionLook()).state === "Connected", { timeout: 20000 });
  await fold();
  const group = await holds("and the group in it too", async () => { const o = await outline(page, B.name); return o.includes(`group ${FILMS}`) && !o.includes(`  chat ${OWNER_CHAT}`) && o.includes(`group ${MY_GROUP}`); }, { timeout: 15000 });
  await check("6 the collapse of the section and of the group in it survives a reload of the page", all(still, group), `${one(await sectionLook())}; ${lines(await outline(page, B.name))}`);
  await shot("a-group-of-the-section-collapsed", page);
  await ui.inList(page, groupHead(section(), FILMS));
  const open = await holds("the group is open again", async () => (await outline(page, B.name)).includes(`  chat ${OWNER_CHAT}`));
  await check("6 expanded again, the section shows B's tree as the owner's page does, and the storage holds no collapse", all(open, await sameTree()) === true && (await stored(page, "aiwb.collapsed")) === "[]", `stored ${await stored(page, "aiwb.collapsed")}; ${await bothTrees()}`);

  // "Show archived" is one switch for the local part and the section.
  await more(page, rowOf(section(), "chat", OWNER_LOOSE), "Archive");
  await more(page, rowOf(side(page), "chat", HERE), "Archive");
  const off = await holds("both archived chats are hidden", async () => !(await outline(page, B.name)).some((l) => l.includes(OWNER_LOOSE)) && !(await outline(page)).some((l) => l.includes(HERE)));
  const switches = await page.locator(q.archivedSwitch).count();
  await showArchived(page, true);
  const on = await holds("both show as archived", async () => (await outline(page, B.name)).includes(`chat ${OWNER_LOOSE} [archived]`) && (await outline(page)).includes(`chat ${HERE} [archived]`));
  const onB = (await stateOf(B)).chats.find((c) => c.name === OWNER_LOOSE)?.archived === true;
  await shot("show-archived", page);
  await more(page, rowOf(section(), "chat", OWNER_LOOSE), "Unarchive");
  await more(page, rowOf(side(page), "chat", HERE), "Unarchive");
  const undone = await holds("both are unarchived", async () => (await stateOf(B)).chats.find((c) => c.name === OWNER_LOOSE)?.archived !== true && (await stateOf(A)).chats.find((c) => c.name === HERE)?.archived !== true);
  await showArchived(page, false);
  await check('6 "Show archived" is one switch: a chat of the section archived from the page is archived on B, and it and an archived local chat hide and show together', all(off, on, undone) === true && switches === 1 && onB, `switches ${switches}; archived on B: ${onB}; hidden ${off}; shown ${on}; undone ${undone}`);
}

/** Two more entries of the list, which never connect: one whose certificate is not accepted (no self-signed box: the
 *  link leads to B, whose certificate no authority signed) and one whose fingerprint was never accepted. The sections
 *  stand in the order of the list, each with the words of its state; one of them collapses and stays so; and removing
 *  an entry takes its section and its collapse away. */
async function step6b() {
  const ATTIC = "Attic", CELLAR = "Cellar";
  const dlg = ui.serversDialog(page);
  const rowIn = (name) => ui.serverRow(page, name);
  const add = async (name, selfSigned) => {
    await ui.openServers(page);
    const form = await ui.fillForm(page, { name, address: `https://127.0.0.1:${await freePort()}`, secret: "a-secret-of-no-server", selfSigned }); // never dialed: A dials the link, whatever the address
    await ui.click(page, ui.button(form, "Save anyway"));
    await rowIn(name).waitFor({ timeout: 15000 });
    await ui.closeServers(page);
  };
  await add(ATTIC, false);
  await add(CELLAR, true);
  const said = (name, words) => holds(`the section of ${name} says "${words}" and the one line, with no row`, async () => {
    const l = await lookOf(name);
    return !!l && l.state === words && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one([ONE_LINE]);
  }, { timeout: 60000 });
  const attic = await said(ATTIC, "Certificate not accepted"), cellar = await said(CELLAR, "Fingerprint not accepted");
  const order = await page.locator(q.section).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const listed = ((await hostApp(host1, "servers.list")).json?.servers ?? []).filter((v) => !v.local).map((v) => v.name);
  await check("6 two more entries that never connect: each has its section, in the order of the list after this computer's, with the words of its state and the one line; B's section keeps its rows",
    all(attic, cellar) === true && one(order) === one([A.name, B.name, ATTIC, CELLAR]) && one(order.slice(1)) === one(listed) && (await sectionLook()).rows > 0,
    `sections ${one(order)}; the list ${one(listed)}; ${ATTIC} ${one(await lookOf(ATTIC))}; ${CELLAR} ${one(await lookOf(CELLAR))}`);
  await shot("three-sections-in-the-order-of-the-list", page, true);

  // A section of a server that is not connected collapses, and stays collapsed across a reload.
  const atticId = ((await hostApp(host1, "servers.list")).json?.servers ?? []).find((v) => v.name === ATTIC)?.id ?? "";
  await fold(ui.sectionOf(page, ATTIC));
  await fold();
  const folded = await holds("both are collapsed", async () => (await lookOf(ATTIC)).collapsed && (await sectionLook()).collapsed && (await lookOf(ATTIC)).lines.length === 0);
  await shot("a-connected-section-and-one-that-is-not-collapsed", page);
  await page.reload();
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  const kept = await holds("after a reload both are collapsed, and the third is not", async () => (await lookOf(ATTIC))?.collapsed === true && (await sectionLook())?.collapsed === true && (await lookOf(CELLAR))?.collapsed === false, { timeout: 20000 });
  const storedNow = JSON.parse((await stored(page, "aiwb.collapsed")) ?? "[]");
  await check("6 a section of a server that is not connected collapses as a connected one does, says its state in its head alone, and both stay collapsed across a reload",
    all(folded, kept) === true && storedNow.includes(atticId) && storedNow.includes(ENTRY) && (await lookOf(ATTIC)).state === "Certificate not accepted", `stored ${one(storedNow)}; ${ATTIC} ${one(await lookOf(ATTIC))}`);
  await fold();
  await waitFor("B's section is expanded again", async () => !(await sectionLook()).collapsed && (await sectionLook()).rows > 0);

  // Removing the two entries takes their sections away, and the collapse of the one that was collapsed.
  const before = await census();
  for (const name of [ATTIC, CELLAR]) {
    await ui.openServers(page);
    await ui.click(page, ui.button(rowIn(name), "Remove"));
    await ui.click(page, ui.button(page.locator(q.dialog).filter({ has: page.locator(q.dialogTitle, { hasText: /^Remove server$/ }) }), "Remove"));
    await rowIn(name).waitFor({ state: "detached", timeout: 15000 });
    await ui.closeServers(page);
  }
  const gone = await holds("B's section alone is left", async () => one(await page.locator(q.section).evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))) === one([A.name, B.name]), { timeout: 15000 });
  const left = await stored(page, "aiwb.collapsed");
  await check("6 the two entries are removed in the Servers dialog: their sections go, the collapse of the removed one goes with it, and B's section and B are as they were",
    gone === true && left === "[]" && one(await census()) === one(before) && (await sameTree()) === true, `stored collapse ${left}; ${await bothTrees()}`);
}

async function step7() {
  // The chat made in the group: a first message whose agent asks for a permission, answered on the page.
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await box(page).waitFor();
  const id = own(chatGroup);
  // A folder of B's machine is picked for the chat before its first message: the group on B remembers it from that message on.
  const dir = path.join(B.work, B_ONLY);
  await ui.openChip(page, "folder", B.name);
  const dirs = ui.dirs(page);
  const head = await ui.dirsHead(page);
  try {
    await ui.typeDir(page, B.work);
    await waitFor("the picker lists the folder of B's machine", async () => (await dirs.locator(q.dirItem).allInnerTexts()).some((t) => t.includes(B_ONLY)));
    await ui.typeDir(page, dir);
    await sleep(300);
    await ui.click(page, dirs.locator(q.dirUse, { hasText: new RegExp(`^Use ${path.basename(dir)}$`) })); // (the button names the folder once its listing has loaded)
  } finally {
    await ui.closeDirs(page); // (a step that failed above leaves no browser open over the later ones)
  }
  await ui.closeMore(page);
  const picked = await holds("B's chat has the folder", async () => (await chatOn(B, id))?.cwd === dir);
  // (the phone's folder sheet is titled "Start the agent in", with the server under it)
  const headWant = PHONE ? `Start the agent in · ${B.name}` : `Folder on ${B.name}`;
  await check(`7 the folder picker of a chat of the section is titled "${headWant}", lists folders of B's machine, and the pick is the chat's folder on B`, head === headWant && picked === true, `head "${head}"; B's chat: ${(await chatOn(B, id))?.cwd}`);
  await send(page, '[[ask Bash {"command":"ls"}]] hello');
  const card = page.locator(q.permCard).first();
  const asked = await card.waitFor({ timeout: 40000 }).then(() => true, (e) => e.message.split("\n")[0]);
  // (at the phone the chat is on screen and Home's row is not: the row's state is not read there)
  const cls = PHONE ? "" : await ui.rowState(rowOf(section(), "chat", IN_GROUP));
  await check("7 a first message in a chat of the section: the permission card shows, and the row shows that the chat waits or works", asked === true && (PHONE || ui.waitsOrWorks(cls)), `card: ${asked}; row state "${cls}"`);
  if (asked === true) await ui.click(page, page.locator(q.permAllow, { hasText: /^Allow$/ }));
  const reply = await replied(page, "ask Bash -> allow");
  const onB = await holds("B has the user message once", async () => (await userTexts(B, id)).length === 1);
  await check("7 Allow is clicked on the page: the reply arrives, and B has the message once", all(reply, onB), `thread ${one(await msgs(page)).slice(0, 300)}`);
  await waitFor("the first turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // The defaults of a group in a section are that server's, shared by all who use it: the next chat in the group starts
  // in that folder, made from the page or by the owner; a chat outside the group does not; and A remembers none.
  const gid = (await groupOn(B, MY_GROUP))?.id;
  const next = await selected(page, "chat", () => makeOnB("Chat", MY_GROUP));
  await box(page).waitFor();
  const byOwner = await selected(owner, "chat", () => plus(owner, groupHead(side(owner), MY_GROUP), "Chat"));
  await box(owner).waitFor();
  const loose = await selected(page, "chat", () => makeOnB("Chat"));
  await box(page).waitFor();
  const cw = [(await chatOn(B, own(next)))?.cwd, (await chatOn(B, byOwner))?.cwd, (await chatOn(B, own(loose)))?.cwd];
  const mineKept = one((await stateOf(A)).defaults ?? {});
  await check("7 the group on B remembers the folder of that first message: the next chat in the group starts in it, made from the page or by the owner; one outside the group starts in B's own folder; A remembers nothing of it",
    cw[0] === dir && cw[1] === dir && cw[2] === B.work && !mineKept.includes(gid) && !mineKept.includes(B_ONLY) && !mineKept.includes(ENTRY),
    `in the group, from the page: ${cw[0]}; by the owner: ${cw[1]}; outside: ${cw[2]}; A's defaults: ${mineKept.slice(0, 200)}`);
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await page.locator(q.msgAssistant).first().waitFor();

  // An image in the chat: uploaded to B through A, shown from A's own address for it, and kept by B alone.
  const ups = callsFrom(page);
  const chooser = page.waitForEvent("filechooser", { timeout: 20000 });
  chooser.catch(() => {}); // (a press that opens no chooser is the failed check below, not an exception that ends the script)
  const attached = await ui.pressAttach(page, { timeout: 15000 }).then(() => chooser).then((c) => c.setFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG })).then(() => true, (e) => `the attach button gave no file chooser: ${e.message.split("\n")[0]}`);
  const thumb = page.locator(q.thumb);
  const up = attached === true ? await holds("the thumbnail of the uploaded image shows", async () => (await thumb.count()) === 1 && (await thumb.evaluate((el) => el.complete && el.naturalWidth > 0)), { timeout: 30000 }) : attached;
  const post = ups().find((c) => c.method === "POST" && c.server === ENTRY && c.path.startsWith(`/api/chats/${id}/images`));
  const hash = await waitFor("B's draft names the image", async () => (await get(B, `/api/chats/${id}/items`)).json?.state?.draft?.images?.[0]?.id ?? null, { timeout: 15000 }).catch(() => "");
  const got = hash ? await fetch(`${host1.url}host/picture/${ENTRY}/${id}/${hash}`) : null;
  const bytes = got ? Buffer.from(await got.arrayBuffer()) : null;
  const local = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => hash && f.includes(hash));
  await check("7 an image added to the chat is uploaded to B in one call naming B's entry, is named by B's draft, is served by the host (the app's main process) from B's bytes under its own headers as an image, and A keeps no file of it",
    up === true && post?.status === 200 && /^[0-9a-f]{64}$/.test(hash) && got?.status === 200 && got.headers.get("content-type") === "image/png" && got.headers.get("x-content-type-options") === "nosniff" && bytes?.equals(PNG) && local.length === 0,
    `${attached === true ? "" : attached + "; "}upload ${one(post && { server: post.server, path: post.path.slice(0, 80), status: post.status })}; B's draft names ${hash.slice(0, 12)}…; GET -> ${got?.status} ${got?.headers.get("content-type")} nosniff: ${got?.headers.get("x-content-type-options")}; files of A: ${one(local)}`);
  if (up === true) await ui.click(page, page.locator(q.thumbRemove));
  await holds("the draft has no image again", async () => !((await get(B, `/api/chats/${id}/items`)).json?.state?.draft?.images?.length), { timeout: 15000 });

  // The owner opens the same chat on B's own page. A second message from A: both pages follow it while the agent works.
  await ui.openRow(owner, rowOf(side(owner), "chat", IN_GROUP));
  await owner.locator(q.msgAssistant).first().waitFor({ timeout: 20000 });
  await send(page, "[[sleep 4]] again");
  const working = await holds("both pages show the chat at work", async () => {
    const a = PHONE ? "writing" : await ui.rowState(rowOf(section(), "chat", IN_GROUP)), b = await ui.rowState(rowOf(side(owner), "chat", IN_GROUP)); // (the phone's Home row is under the chat: the owner's alone)
    return ui.working(a) && ui.working(b) && (await msgs(owner)).user.some((t) => t.includes("again"));
  }, { timeout: 20000, every: 50 });
  const both = all(await replied(page, "again"), await replied(owner, "again"));
  const ma = await msgs(page), mo = await msgs(owner);
  await check("7 a second message: while the agent works both pages show the chat at work and the message, and both get the reply, none twice",
    all(working, both) === true && ma.user.length === 2 && mo.user.length === 2 && ma.assistant.length === 2 && mo.assistant.length === 2 && noneTwice(ma) && noneTwice(mo), `working: ${working}; A ${counts(ma)}; the owner ${counts(mo)}`);
  await waitFor("the second turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // Anyone who has the chat open can answer and send: an ask of A's message is answered by the owner, then the owner sends.
  await send(page, '[[ask Bash {"command":"pwd"}]] third');
  const ownerCard = owner.locator(q.permAllow, { hasText: /^Allow$/ });
  const shown = await ownerCard.waitFor({ timeout: 40000 }).then(() => true, (e) => e.message.split("\n")[0]);
  if (shown === true) await ui.click(owner, ownerCard);
  const approved = PHONE ? "Allowed" : "Approved"; // (the phone's answered card folds to one line, "Allowed · …")
  const answered = all(await replied(page, "third"), await holds("the card on A's page is decided", async () => (await ui.waitingCards(page)) === 0 && (await ui.decidedCards(page)).filter((t) => t === approved).length === 2));
  await check("7 a permission asked by the page's message is answered on the owner's page: the page's card is decided and its reply arrives", all(shown, answered), `the owner's card: ${shown}; ${one(await ui.decidedCards(page))}`);
  await waitFor("the third turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});
  await send(owner, "from the owner");
  const fromOwner = all(await replied(page, "from the owner"), await replied(owner, "from the owner"));
  const m4 = await msgs(page);
  await check("7 the owner sends in the same chat: the page's thread grows by the message and its reply", fromOwner === true && m4.user.length === 4 && m4.assistant.length === 4 && noneTwice(m4), counts(m4));
  await waitFor("the fourth turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // The draft: what A types is the chat's draft on B, the owner's composer gets it, and the row carries the mark once the chat is left.
  await box(page).click();
  await box(page).fill("a thought from A");
  const drafted = await holds("B has the text as the chat's draft", async () => (await draftOn(id)).text === "a thought from A");
  const mirrored = await holds("the owner's composer shows it", async () => (await boxText(owner)).trim() === "a thought from A");
  await ui.openRow(page, rowOf(side(page), "chat", HERE));
  await ui.openRow(owner, rowOf(side(owner), "chat", OWNER_CHAT));
  // (Home's rows carry no draft mark: at the phone the owner's page alone shows it)
  const marked = await holds("both rows carry the draft mark", async () => (PHONE || (await outline(page, B.name)).includes(`  chat ${IN_GROUP} [draft]`)) && (await outline(owner)).includes(`  chat ${IN_GROUP} [draft]`));
  await check("7 what the page types is the chat's draft on B, the owner's composer shows it, and the chat's row carries the draft mark on both pages", all(drafted, mirrored, marked), `${await bothTrees()}; B's draft ${one(await draftOn(id))}`);
  const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("aiwb.draft.")).map((k) => `${k}=${localStorage.getItem(k)}`));
  await check("7 the browser's storage holds no draft of the section's chat", kept.every((k) => !k.includes(id) && !k.includes("a thought from A")), one(kept));

  // Two writers in one draft: B's answers to A are held back while A saves, the owner saves meanwhile, and A's save,
  // which names the counter A typed on, is refused as stale when it arrives. A is told, and its text is not replaced silently.
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await ui.openRow(owner, rowOf(side(owner), "chat", IN_GROUP));
  await waitFor("both composers hold the draft", async () => (await boxText(page)).trim() === "a thought from A" && (await boxText(owner)).trim() === "a thought from A");
  const base = (await draftOn(id)).rev;
  const saves = callsFrom(page);
  const theirs = callsFrom(owner);
  const isSave = (c) => c.method === "PUT" && c.path.includes(`/chats/${id}/draft`);
  const pid = B.info.pid;
  process.kill(pid, "SIGSTOP"); // B takes nothing for a moment: both saves wait at its door, each on the counter its page typed on
  let stale = null;
  try {
    await box(owner).click();
    await box(owner).fill("the owner's words");
    await waitFor("the owner's save is on its way", async () => theirs().some(isSave), { timeout: 10000 });
    await box(page).click();
    await box(page).fill("A's later words");
    await waitFor("A's save is on its way", async () => saves().some(isSave), { timeout: 10000 });
  } finally { process.kill(pid, "SIGCONT"); }
  stale = await holds("one of the two saves is refused as stale", async () =>
    [...saves(), ...theirs()].filter((c) => isSave(c) && c.status === 409 && c.code === "stale").length === 1, { timeout: 20000 });
  await sleep(2500); // the refused one saved its text again on the counter it was told, or took the other's
  const end = await draftOn(id), a = (await boxText(page)).trim(), o = (await boxText(owner)).trim();
  const whose = saves().some((c) => c.status === 409 && c.code === "stale") ? "A's page" : "the owner's page";
  const told = whose === "A's page" ? "A's later words" : "the owner's words"; // the one that was told saved its text again on the counter it was told: it was typed after the draft it was told of
  await check("7 two writers in one draft: the later save is refused as stale and told the stored draft, no text is lost without a word, and both pages end with the draft B has",
    stale === true && end.rev === base + 2 && end.text === told && a === end.text && o === end.text,
    `refused: ${stale === true ? whose : stale}; B's draft ${one(end)} (counter was ${base}); A's box "${a}"; the owner's box "${o}"`);
  await box(page).fill("");
  await holds("the draft is gone on B", async () => (await draftOn(id)).text === "", { timeout: 15000 });
}

/** What one page changes of a chat shows on the other with no reload: the choices of a chat that has not started,
 *  and a Stop while its agent works. Each way: the owner's change on the client's page, the client's on the owner's. */
async function step7b() {
  const key = await selected(page, "chat", () => makeOnB("Chat", MY_GROUP));
  await box(page).waitFor();
  await renameChat(page, TWO);
  const id = own(key);
  await ui.openRow(owner, rowOf(side(owner), "chat", TWO));
  await box(owner).waitFor();
  const label = (p, title) => ui.chipLabel(p, title.toLowerCase());
  /** Picks, in a picker of a page's composer, the first option that is not the chat's, and answers its id. */
  const pickOther = async (p, title) => {
    await ui.openChip(p, title.toLowerCase());
    const opt = ui.otherOption(p, title.toLowerCase());
    const picked = await ui.optionId(opt);
    await ui.click(p, opt);
    await ui.closeMore(p);
    return picked;
  };
  await waitFor("both composers offer the effort", async () => !!(await label(page, "Effort")) && !!(await label(owner, "Effort")), { timeout: 20000 });
  const e0 = await label(page, "Effort");
  const effort = await pickOther(owner, "Effort");
  const eB = await holds("B's chat has the effort the owner picked", async () => (await chatOn(B, id))?.effort === effort);
  const eA = await holds("the page's composer shows the owner's pick", async () => { const a = await label(page, "Effort"); return !!a && a !== e0 && a === await label(owner, "Effort"); });
  await check("7 the owner picks another effort for a chat that has not started: the page's composer shows it with no reload", all(eB, eA), `effort ${effort}; the page's chip "${e0}" -> "${await label(page, "Effort")}"; the owner's "${await label(owner, "Effort")}"`);
  const m0 = await label(owner, "Model");
  const calls = callsFrom(page);
  const model = await pickOther(page, "Model");
  const mB = await holds("B's chat has the model the page picked", async () => (await chatOn(B, id))?.model === model);
  const mO = await holds("the owner's composer shows the page's pick", async () => { const o = await label(owner, "Model"); return !!o && o !== m0 && o === await label(page, "Model"); });
  const patch = calls().filter((c) => c.method !== "GET" && !/\/draft\b/.test(c.path));
  await check("7 the page picks another model for it: one call under the section's address, B has the model, and the owner's composer shows it with no reload",
    all(mB, mO) === true && patch.length === 1 && patch[0].method === "PATCH" && patch[0].server === ENTRY && patch[0].path.startsWith(`/api/chats/${id}`),
    `model ${model}; the owner's chip "${m0}" -> "${await label(owner, "Model")}"; the page's "${await label(page, "Model")}"; calls ${one(patch.map((c) => `${c.method} ${c.path} ${c.status}`))}`);

  // A Stop made on the other page: the agent sleeps far longer than the check waits, so only the Stop ends the turn.
  const stopOf = (p) => p.locator(q.stop);
  // (the phone's page has the chat on screen and Home's row under it: Stop alone is read there)
  const works = (p, scope) => holds("the page shows the chat at work, with Stop", async () => (await stopOf(p).count()) === 1 && (PHONE && p === page || ui.working(await ui.rowState(rowOf(scope, "chat", TWO)))), { timeout: 30000 });
  const rests = (p, scope) => holds("the page shows the chat stopped: no Stop, the row at rest", async () => (await stopOf(p).count()) === 0 && (PHONE && p === page || !ui.working(await ui.rowState(rowOf(scope, "chat", TWO)))), { timeout: 20000 });
  await send(page, "[[sleep 120]] a long one");
  const w1 = all(await works(page, section()), await works(owner, side(owner)));
  let t = Date.now();
  if (w1 === true) await ui.click(owner, stopOf(owner));
  const s1 = all(await rests(page, section()), await holds("B's chat is at rest", async () => (await chatOn(B, id))?.status === "ready", { timeout: 20000 }));
  await check("7 the owner presses Stop while the page's message is being answered: the page's chat stops with no reload", all(w1, s1) === true && Date.now() - t < 60000, `at work on both: ${w1}; stopped: ${s1}; after ${Date.now() - t} ms`);
  await send(owner, "[[sleep 120]] the owner's long one");
  const w2 = all(await works(owner, side(owner)), await works(page, section()));
  const stops = callsFrom(page);
  t = Date.now();
  if (w2 === true) await ui.click(page, stopOf(page));
  const s2 = all(await rests(owner, side(owner)), await holds("B's chat is at rest", async () => (await chatOn(B, id))?.status === "ready", { timeout: 20000 }));
  const call = stops().filter((c) => c.method !== "GET" && !/\/draft\b/.test(c.path)).map((c) => `${c.method} ${c.path.split("?")[0]} ${c.status}`);
  await check("7 the page presses Stop while the owner's message is being answered: one call under the section's address, and the owner's page stops with no reload",
    all(w2, s2) === true && Date.now() - t < 60000 && one(call) === one([`POST /api/chats/${id}/interrupt 200`]) && stops().some((c) => c.server === ENTRY && c.path.startsWith(`/api/chats/${id}/interrupt`)), `at work on both: ${w2}; stopped: ${s2}; after ${Date.now() - t} ms; calls ${one(call)}`);
  await ui.openRow(page, rowOf(side(page), "chat", HERE));
  await ui.openRow(owner, rowOf(side(owner), "chat", OWNER_CHAT));
}

/** The section while B is not connected: the state's words, the one line, no row and no "+". */
const awayLook = (state = "Unreachable") => PHONE ? awayHome(state) : holds(`the section says "${state}" and the one line, with no row`, async () => {
  const l = await sectionLook();
  return !!l && l.state === state && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one([ONE_LINE]);
}, { timeout: 30000 });
/** At the phone: Home's word of B (the chip's) is the state's word key. Home folds the states the Servers dialog names one by one ("Secret not
 *  accepted", ...) into "Unreachable" and keeps their words as the reason of the problem card; so a word the dialog has and Home has not is
 *  looked for in that card (`card`: the stack is left at Home, a chat open is closed). */
const HOME_KEY = { Unreachable: "unreachable", "Too old": "too-old", "Certificate changed": "cert-changed" };
async function awayHome(state, { card = false } = {}) {
  const key = HOME_KEY[state] ?? "unreachable";
  const word = await homeIs(B.name, key, 30000);
  if (!card || word !== true) return word;
  await ui.showHome(page, ENTRY);
  const text = await holds(`the problem card of B says "${state}"`, async () => ((await page.locator(`${q.problemCard}[data-server=${JSON.stringify(ENTRY)}]`).first().innerText().catch(() => "")) || "").includes(state), { timeout: 15000 });
  return text;
}
const hasRows = (l) => PHONE || l.rows > 0;

async function step8() {
  const id = own(chatGroup);
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await page.locator(q.msgAssistant).first().waitFor();
  await ui.openRow(owner, rowOf(side(owner), "chat", OWNER_CHAT)); // the owner is elsewhere: its composer saves nothing into this chat
  const thread = await msgs(page);
  // Text that is typed and not yet taken by B: nothing passes the link while it is typed, then the link is pulled.
  const typed = "typed just before the drop";
  const saves = callsFrom(page);
  setLink("stall");
  await box(page).click();
  await box(page).fill(typed);
  await waitFor("the save of the typed text is on its way", async () => saves().some((c) => c.method === "PUT" && c.path.includes("/draft")), { timeout: 10000 });
  setLink("cut");
  const bar = PHONE ? ui.offWarning(page) : page.locator(q.remoteBarOffText);
  // (the phone: V1's block in the toolbar's place, "<server> is offline since 14:02." and that the draft is kept)
  const warnedAs = (t) => PHONE ? t.startsWith(`${B_NAME} is offline`) && t.includes("Your draft is kept until it's back.") : t === `${AWAY}. This chat is shown as it was when the connection ended.`;
  const warned = await holds("the warning names B", async () => warnedAs(await bar.innerText().catch(() => "")), { timeout: 30000 });
  const m = await msgs(page);
  await check("8 the link is pulled with the chat open: the thread stays on screen as it was, under a warning that names the server", warned === true && one(m) === one(thread), `bar "${await bar.innerText().catch(() => "none")}"; ${counts(m)} (was ${counts(thread)})`);
  await check(PHONE ? "8 Home says that B is unreachable" : "8 the section says that B is not connected and the one line; no row is left, the open chat's neither", await awayLook(), one(await sectionLook()));
  await shot("not-connected-with-a-chat-open", page, true);
  const mine = await lookOf(A.name);
  await check("8 all the while this computer's section is connected, with its rows and its \"+\": the outage of B holds nothing of it up", mine?.state === "Connected" && (PHONE || (mine.rows > 0 && (await page.locator(`${q.newBtn}:not([disabled])`).count()) === 1)), one(mine)); // (Home's "+ New" is B's chip's: not read)
  const sendBtn = page.locator(q.send);
  if (PHONE) { // (the phone: the block stands in the toolbar's place, so there is no Send, and it says why)
    const why = { send: await sendBtn.count(), block: (await bar.innerText().catch(() => "")).replace(/\s+/g, " "), choices: await page.locator(q.choices).count() };
    await check("8 nothing can be sent or changed, and the composer says why: no Send, the block in the toolbar's place says that B is offline, and no choice is a choice",
      why.send === 0 && warnedAs(await bar.innerText().catch(() => "")) && why.choices === 0, one(why));
  } else {
    const why = { disabled: await sendBtn.isDisabled(), title: await sendBtn.getAttribute("title"), line: (await page.locator(q.agentReason).allInnerTexts()).join(" / "), choices: await page.locator(q.choices).count() };
    await check("8 nothing can be sent or changed, and the composer says why: Send is off with the reason, the line under the toolbar says it, and no choice is a choice",
      why.disabled === true && why.title === WHY && why.line === WHY && why.choices === 0, one(why));
  }
  // Read-only: the box keeps what was typed and takes no more.
  const during = callsFrom(page);
  await box(page).click({ force: true }).catch(() => {});
  await page.keyboard.press("End");
  await page.keyboard.type(" and more");
  await page.keyboard.press("ControlOrMeta+Enter");
  await sleep(800);
  const kept = (await boxText(page)).trim();
  const tried = during().filter((c) => c.method !== "GET");
  const ro = await box(page).getAttribute("aria-readonly");
  await check("8 the text typed before the drop stays in the box; the box is read-only and takes no more, and no call is made for it", kept === typed && ro === "true" && tried.length === 0 && (await msgs(page)).user.length === thread.user.length,
    `box "${kept}"; aria-readonly ${ro}; calls during the outage ${one(tried.map((c) => `${c.method} ${c.path} ${c.status}`))}`);
  await check("8 B has none of the typed text yet", (await draftOn(id)).text === "", `B's draft ${one(await draftOn(id))}`);

  // Meanwhile on B: the owner sends in that chat, and makes another one.
  await ui.openRow(owner, rowOf(side(owner), "chat", IN_GROUP));
  await send(owner, "while A was away");
  await replied(owner, "while A was away");
  await waitFor("its turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});
  await ui.openRow(owner, rowOf(side(owner), "chat", OWNER_CHAT));
  await selected(owner, "chat", async () => { await ui.headPlus(owner, "New chat"); });
  await box(owner).waitFor();
  await renameChat(owner, "Made meanwhile");
  await ui.openRow(owner, rowOf(side(owner), "chat", OWNER_CHAT));

  // Back: the section's tree as it is now, the open chat level with B, the warning gone, the composer at work, the typed text saved.
  setLink("pass");
  const tree = await holds("the section shows B's tree as it is now", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes("chat Made meanwhile"), { timeout: 60000 });
  await check("8 B is back: the section shows the tree as it is now, with what was made there meanwhile", all(tree, await sameTree()), await bothTrees());
  if (PHONE) await ui.openRow(page, rowOf(section(), "chat", IN_GROUP)); // (Home's outline left the chat: it is opened again, level with B and with its draft)
  const level = await holds("the open chat has what was sent there meanwhile, and no warning", async () => (await msgs(page)).user.some((t) => t.includes("while A was away")) && (await page.locator(WARN).count()) === 0, { timeout: 30000 });
  const m2 = await msgs(page);
  await check("8 the open chat is brought level with B and the warning goes", level === true && m2.user.length === thread.user.length + 1 && noneTwice(m2), `${counts(m2)}; bar ${await page.locator(WARN).count()}`);
  const saved = await holds("B has the typed text as the chat's draft", async () => (await draftOn(id)).text === typed, { timeout: 30000 });
  const editable = await holds("the box takes text again", async () => (await box(page).getAttribute("aria-readonly")) !== "true");
  await check("8 the text that was typed is saved on B once it is back, is still in the box, and the box takes text again", all(saved, editable) === true && (await boxText(page)).trim() === typed, `B's draft ${one(await draftOn(id))}; box "${(await boxText(page)).trim()}"`);
  await box(page).press("ControlOrMeta+Enter");
  const works = await replied(page, typed);
  await check("8 the composer works again: the text is sent and answered", works, counts(await msgs(page)));
  await waitFor("its turn ends", async () => (await chatOn(B, id))?.status === "ready", { timeout: 30000 }).catch(() => {});

  // Left during an outage, the chat cannot be opened again; a reload during the outage knows nothing of B.
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await ui.openRow(page, rowOf(side(page), "chat", HERE));
  const left = await holds("the chat of this computer is on screen and nothing of B", async () => (await sel(page)).chat === chat0 && (await page.locator(`${WARN}, ${q.chatHeadServer}`).count()) === 0);
  const look = await sectionLook();
  await shot("not-connected", page);
  await check("8 the chat is left during an outage: it is closed, the section has no row to open it from, and the selection names nothing of B", left === true && (PHONE || look.rows === 0) && !one(await sel(page)).includes(ENTRY), `${one(look)}; selection ${one(await sel(page))}`);
  await page.reload();
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  const blank = await awayLook();
  await holds("this computer's section is connected", async () => (await lookOf(A.name))?.state === "Connected" && hasRows(await lookOf(A.name)), { timeout: 60000 });
  const mineAgain = await lookOf(A.name);
  await check("8 a reload of the page during the outage: nothing of B is known, the section says so, and this computer's section is full", blank === true && (await page.locator(`${WARN}, ${q.chatHeadServer}`).count()) === 0 && mineAgain?.state === "Connected" && hasRows(mineAgain),
    `${one(await sectionLook())}; this computer's ${one(mineAgain)}`);
  setLink("pass");
  const again = await holds("the section has its rows again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 60000 });
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  // (the phone's thread is an inverted list that draws the newest items first and the older ones as it is scrolled up: the two messages of
  // this step are what is read there)
  const whole = (m) => PHONE ? m.user.some((t) => t.includes("while A was away")) && m.user.some((t) => t.includes(typed)) : m.user.length === thread.user.length + 2;
  const opens = await holds("the chat opens with its thread", async () => whole(await msgs(page)) && (await page.locator(WARN).count()) === 0, { timeout: 30000 });
  await check("8 B is back: the chat is in the section again and opens as usual", all(again, opens), `${counts(await msgs(page))}; warnings ${await page.locator(WARN).count()}`);

  // A reload during an outage with a chat of B selected: the chat that was open is closed.
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await page.reload();
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  await awayLook();
  const closed = (await page.locator(`${q.msg}, ${WARN}, ${q.chatHeadServer}`).count()) === 0;
  await check("8 a reload during an outage with a chat of B open: the chat is closed, and nothing of it is on screen", closed, `selection ${one(await sel(page))}; main: ${(await page.locator("main").first().innerText().catch(() => "")).slice(0, 120)}`);
  setLink("pass");
  await waitFor("the section has its rows again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 60000 });

  // Deleted on B during an outage: back, the view says that the chat is no longer on that server.
  const reads = callsFrom(page);
  await ui.openRow(page, rowOf(section(), "chat", "Made meanwhile"));
  await box(page).waitFor();
  if (!PHONE) await page.locator(q.chatHeadServer).waitFor(); // (the phone's head names the server only while it is in trouble)
  await waitFor("the chat's thread is read", async () => reads().some((c) => c.method === "GET" && /\/items\?/.test(c.path) && c.status === 200));
  setLink("cut");
  await bar.waitFor({ timeout: 30000 });
  await more(owner, rowOf(side(owner), "chat", "Made meanwhile"), "Delete");
  await dialogDo(owner, "Delete");
  await waitFor("B no longer has the chat", async () => !(await stateOf(B)).chats.some((c) => c.name === "Made meanwhile"));
  setLink("pass");
  const gone = page.locator(q.remoteGone);
  const says = await holds("the view says that the chat is no longer on B", async () => (await gone.first().innerText().catch(() => "")) === `This chat is no longer on ${B.name}.`, { timeout: 60000 });
  const row = await rowOf(section(), "chat", "Made meanwhile").count();
  await check("8 a chat deleted on B during the outage: back, its view says that it is no longer on that server, Send stays off, and no row is left for it",
    says === true && row === 0 && (await page.locator(q.send).isDisabled().catch(() => true)), `"${await gone.first().innerText().catch(() => "none")}"; rows ${row}`);
  await shot("a-chat-that-is-no-longer-on-its-server", page, true);
  await ui.openRow(page, rowOf(side(page), "chat", HERE));
}

/** "Test connection" of B's row in the Servers dialog, which makes an entry that waits for the user look again.
 *  true when the row then says `words` of the entry, else what it says. */
async function testEntry(words) {
  if (PHONE) { // (S2's screens: the detail's "Test connection"/"Test again" (`srv-test`, where the state offers one), then the list's row, whose label says the word and why)
    await ui.openServers(page);
    const prow = ui.serverRow(page, B.name);
    const detail = await ui.openServerDetail(page, B.name);
    const test = page.locator('[data-testid="srv-test"]').last();
    if (await test.count()) {
      await ui.click(page, test);
      await page.locator('[data-testid="srv-result"]').last().waitFor({ timeout: 60000 }).catch(() => {}); // (the answer in place; the row below is what is read)
    }
    void detail;
    await ui.stackBack(page);
    const label = async () => ((await prow.first().getAttribute("aria-label").catch(() => "")) ?? "").toLowerCase();
    const ok = await holds(`the row says "${words}"`, async () => (await label()).includes(words.toLowerCase()), { timeout: 60000 });
    const seen = await label();
    await ui.closeServers(page);
    return ok === true ? true : `the row says "${seen}"`;
  }
  await ui.openServers(page);
  const row = ui.serverRow(page, B.name);
  const said = () => row.locator(q.serversState).innerText().catch(() => "");
  await ui.click(page, ui.button(row, "Test connection"));
  const ok = await holds(`the row says "${words}"`, async () => (await said()).split(": ")[0] === words, { timeout: 60000 });
  const seen = await said();
  await ui.closeServers(page);
  return ok === true ? true : `the row says "${seen}"`;
}

/** A stand-in for a server behind the link: an HTTP/2 server with the given certificate (a client of the API speaks h2 alone).
 *  Answers { port, close() }. */
async function standIn(tls, answer) {
  const srv = http2.createSecureServer({ ...tls, allowHTTP1: false }, (req, res) => { const [status, type, body] = answer(req); res.writeHead(status, { "Content-Type": type }); res.end(body); });
  const sessions = new Set();
  srv.on("session", (s) => { sessions.add(s); s.on("close", () => sessions.delete(s)); s.on("error", () => {}); });
  srv.on("tlsClientError", () => {});
  const port = await freePort();
  await new Promise((resolve) => srv.listen(port, "127.0.0.1", resolve));
  return { port, close: () => new Promise((resolve) => { for (const s of sessions) s.destroy(); srv.close(resolve); }) };
}

/** The owner's app again (B's host), after it was closed for B to stay down. */
async function ownerHost() {
  host2 = await hostFor({ out: OUT, name: "owner", local: B, extra: { timing: parseAppWaits("backoff=3s,tooold=4s") } });
}

async function step9() {
  // This computer's server stops while the page is open, with a chat of B on screen: its section says so and the app starts it again by
  // itself, with no reload of the page; B's section does not move.
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await page.locator(q.msgAssistant).first().waitFor();
  await page.evaluate(() => { window.__notReloaded = true; });
  const aBefore = A.info?.pid ?? host1.client.localInfo()?.pid;
  await A.stop();
  const dipped = await holds("this computer's section says that its server is not connected", async () => (await lookOf(A.name))?.state !== "Connected", { timeout: 30000 });
  const during = await lookOf(A.name);
  const restarted = await holds("the app started this computer's server again: its section is connected", async () => (await lookOf(A.name))?.state === "Connected" && hasRows(await lookOf(A.name)), { timeout: 120000, every: 100 });
  const aAfter = host1.client.localInfo()?.pid;
  await check("9 this computer's server stops while the page is open: its section says so, the app starts it again by itself with the page not loaded again, and B's section did not move",
    all(dipped, restarted) === true && aAfter !== aBefore && (await page.evaluate(() => window.__notReloaded === true)) && (await sectionLook())?.state === "Connected",
    `during: ${one(during)}; pid ${aBefore} -> ${aAfter}; B: ${one(await sectionLook())}`);
  A.pids.push(aAfter);

  // B's own process stops: the same section, and B's own word in the list. (B's app is closed first: it would start B again.)
  const before = await census();
  await owner.context().close();
  owner = null;
  await host2.close();
  await B.stop();
  await check("9 B's process stops: the section says that B is not connected and the one line, with no row", await awayLook(), one(await sectionLook()));
  const kept = (await page.locator(q.msg).count()) > 0 && (await ui.offWarning(page).count()) === 1;
  await check("9 the open chat stays on screen under the warning", kept, `messages ${await page.locator(q.msg).count()}; bars ${await ui.offWarning(page).count()}`);

  // This computer's server stops during B's outage: it kept nothing of B, and the page that reloads knows nothing of B.
  await A.stop();
  await holds("this computer's section is connected again", async () => (await lookOf(A.name))?.state === "Connected", { timeout: 120000 });
  const named = fs.readdirSync(A.home, { recursive: true }).map(String).filter((f) => f.includes(own(chatGroup)) || f.includes(own(boardKey)));
  await page.reload();
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  const blank = await awayLook();
  await check("9 A's server restarts during the outage: its data folder has no file of a chat or a board of B, and the page shows B's section with no row",
    blank === true && named.length === 0 && (await page.locator(`${q.msg}, ${q.chatHeadServer}`).count()) === 0,
    `${one(await sectionLook())}; files that name a thing of B ${one(named)}`);

  // A server that is too old: a stand-in with B's certificate that reports level 5 and a version.
  const tls = { key: fs.readFileSync(path.join(B.home, "remote-key.pem")), cert: fs.readFileSync(path.join(B.home, "remote-cert.pem")) };
  const json = (status, o) => [status, "application/json", JSON.stringify(o)];
  const hello = (level, instanceId, version = "9.9.9") => json(200, { app: "ai-whiteboard", version, instanceId, featureLevel: level });
  const old = await standIn(tls, (req) => (req.url.startsWith("/api/hello") ? hello(5, B.instance, "0.4.0-old") : json(404, { error: "not found" })));
  const oldPort = old.port;
  link.target = oldPort;
  link.set("cut");
  link.set("pass");
  const tooOld = PHONE
    // (Home: the word "too-old", and the problem card names the version)
    ? await holds("Home says that the server is too old, with its version", async () => (await ui.homeWord(page, ENTRY)) === "too-old" && (await ui.showHome(page, ENTRY), (await page.locator(`${q.problemCard}[data-server=${JSON.stringify(ENTRY)}]`).first().innerText().catch(() => "")).includes("0.4.0-old")), { timeout: 60000 })
    : await holds("the section says that the server is too old, with its version", async () => {
      const l = await sectionLook();
      return l.state === "Too old" && l.tone === "bad" && l.rows === 0 && !l.add && one(l.lines) === one(["Update the server on that machine.", "Version 0.4.0-old"]);
    }, { timeout: 60000 });
  await check("9 a server below the level: the section says that it is too old and must be updated on that machine, with the version it reports, and shows nothing else", tooOld, one(await sectionLook()));
  await shot("too-old", page);

  // Every other state of the list that what answers behind the address can bring about, each with a stand-in there:
  // the section says the words the Servers dialog has for the entry and the one line, and shows nothing else. An
  // entry in one of these states waits for the user: "Test connection" of its row makes it look again.
  const elsewhere = path.join(OUT, "c", "home"); // a certificate that is not B's: of a set-up of its own
  execFileSync(B.bin, ["remote", "setup", "-home", elsewhere, "-port", String(await freePort()), "-name", "127.0.0.1"], { env: B.env, stdio: "ignore" });
  // (a hello is answered without the secret: the refusal of a secret comes at the stream that follows it)
  const STATES = [
    ["Secret not accepted", tls, (req) => (req.url.startsWith("/api/hello") ? hello(7, B.instance) : json(401, { error: "unauthorized" }))],
    ["Not an AI Whiteboard server", tls, () => [200, "text/html", "<html><body>It works!</body></html>"]],
    ["Another server", tls, (req) => (req.url.startsWith("/api/hello") ? hello(7, "0b9f4a52-6c1d-4e8a-9f3b-2d7c5a1e8f60") : json(404, { error: "not found" }))],
    ["Name not known there", tls, () => json(403, { error: "bad host" })],
    ["Certificate changed", { key: fs.readFileSync(path.join(elsewhere, "remote-key.pem")), cert: fs.readFileSync(path.join(elsewhere, "remote-cert.pem")) }, () => json(401, { error: "unauthorized" })],
  ];
  for (const [words, tlsOf, answer] of STATES) {
    const srv = await standIn(tlsOf, answer);
    const port = srv.port;
    link.set("cut"); // no connection to what stood there before is left
    link.target = port;
    link.set("pass");
    const listed = await testEntry(words);
    const look = PHONE ? await awayHome(words, { card: words !== "Certificate changed" }) : await awayLook(words);
    await check(`9 "${words}": the section says the words the Servers dialog has for the entry and the one line, and shows nothing else`, all(listed, look), `the dialog: ${listed}; ${one(await sectionLook())}`);
    await shot(words.toLowerCase().replace(/[^a-z]+/g, "-"), page);
    await srv.close();
  }
  // Updated: the real B is behind the address again, and the entry connects by itself.
  await B.launch();
  link.set("cut");
  link.target = B.port;
  link.set("pass");
  await old.close();
  // An entry that saw another certificate waits for the user: with B's own certificate behind the address again, a
  // test of the entry leaves it as it is (its row offers the fingerprint to accept). The app is started again (its host
  // is: the state of a connection is not kept): the entry then connects by itself.
  const waits = await testEntry("Certificate changed");
  await check('9 B\'s own certificate is behind the address again: the entry that saw another one still says "Certificate changed" after a test, and its section with it', all(waits, PHONE ? await awayHome("Certificate changed") : await awayLook("Certificate changed")), `the dialog: ${waits}; ${one(await sectionLook())}`);
  const hostPort = host1.port;
  await host1.close();
  host1 = await hostFor({ out: OUT, name: "page", local: A, extra: { dial: (o) => net.connect(o.port === A.port ? o : { host: "127.0.0.1", port: link.port }), timing: parseAppWaits("backoff=3s,tooold=4s"), port: hostPort } });
  await page.reload().catch((e) => { throw new Error(`${e.message.split("\n")[0]}; requests not over: ${[...page.pending].map((r) => r.url().slice(0, 100)).join(" ; ")}`); });
  await page.waitForSelector(ui.treeWait, { state: "attached" });
  const back = await holds("the section shows B's tree again", async () => (await sectionLook())?.state === "Connected" && (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`), { timeout: 90000 });
  await ownerHost();
  owner = await openPage(B); // (B's app again: its host connects, and B's own page shows B)
  const after = await census();
  await check("9 the updated server is behind the address again: the entry connects by itself, and the section shows B's tree as it is", back === true && one(before) === one(after), `${one(await sectionLook())}; B had ${one(before)}, has ${one(after)}`);
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  // (the phone's empty box has Talk, not Send: no warning is what is read there)
  const opens = await holds("the chat opens with its thread and no warning", async () => (await page.locator(q.msgAssistant).count()) > 0 && (await ui.anyWarning(page).count()) === 0 && (PHONE || !(await page.locator(q.send).getAttribute("title"))?.includes("not connected")), { timeout: 30000 });
  await check("9 a chat of the section opens as usual again", opens, `messages ${await page.locator(q.msg).count()}; bars ${await ui.anyWarning(page).count()}`);
}

/** Calls whose answers do not arrive: B takes them, and what it answers is held back by the link. */
async function stepLost() {
  const up = await connected();
  if (up !== true) await check("M A is connected to B", up);
  // A make: B makes the chat and A never hears the answer. The page says that B did not answer; nothing is cleaned up.
  const had = new Set((await stateOf(B)).chats.map((c) => c.id));
  setLink("mute");
  const t0 = Date.now();
  await makeOnB("Chat");
  const dlg = page.locator(q.dialog);
  const said = await holds("the page says that the chat could not be started", async () => (await dlg.innerText().catch(() => "")).includes("Couldn't start the chat"), { timeout: 60000, every: 250 });
  const text = (await dlg.innerText().catch(() => "")).replace(/\n/g, " / ");
  const made = (await stateOf(B)).chats.filter((c) => !had.has(c.id));
  await check("M a make whose answer is lost: the page says that B did not answer, with B's name", said === true && text.includes(`${B.name} did not answer.`) && made.length === 1, `after ${Math.round((Date.now() - t0) / 1000)} s: "${text}"; made on B: ${made.length}`);
  await page.keyboard.press("Escape");
  await dlg.waitFor({ state: "detached" }).catch(() => {});
  setLink("pass");
  const shows = await holds("the chat that was made shows in the section", async () => (await connected(1000)) === true && (PHONE ? (await outline(page, B.name)).filter((l) => l.trim().startsWith("chat ")).length : await section().locator(q.chatRow).count()) === (await stateOf(B)).chats.filter((c) => !c.board && !c.run && !c.archived).length, { timeout: 60000 });
  await sleep(3000);
  const still = (await stateOf(B)).chats.some((c) => c.id === made[0]?.id);
  await check("M the answers flow again: the chat that was made shows in the section like any other, and nothing deletes it", all(shows, still || "B no longer has the chat"), `on B: ${still}`);
}

async function step10() {
  // A chat of B is on screen when its entry is removed.
  await waitFor("the section has its rows", async () => (await sectionLook())?.state === "Connected" && (PHONE ? (await outline(page, B.name)).includes(`  chat ${IN_GROUP}`) : (await rowOf(section(), "chat", IN_GROUP).count()) === 1), { timeout: 60000 });
  await ui.openRow(page, rowOf(section(), "chat", IN_GROUP));
  await page.locator(q.msgAssistant).first().waitFor({ timeout: 20000 });
  const before = await census();
  const row = ui.serverRow(page, B.name);
  let ask;
  if (PHONE) { // (S2's detail: "Remove server…" asks in a confirm sheet; its title names the server, its body says what stays)
    await ui.openServerDetail(page, B.name);
    await ui.click(page, page.locator('[data-testid="srv-remove"]'));
    ask = page.locator('[data-testid="confirm-dialog"], [data-testid="confirm-sheet"]').last();
    await ask.waitFor();
    const title = (await ask.locator('[data-testid="confirm-title"]').innerText()).trim(), text = (await ask.locator('[data-testid="confirm-body"]').innerText()).trim();
    await check("10 the question before the removal says that everything stays on that server, and counts nothing",
      title.includes(B.name) && /stay there/.test(text) && /Nothing is deleted or stopped on /.test(text) && !/\d/.test(text.replace(B.name, "")), `${title} / ${text}`);
    await ui.click(page, ask.locator('[data-testid="confirm-go"]'));
  } else {
    await ui.openServers(page);
    await ui.click(page, ui.button(row, "Remove"));
    ask = page.locator(q.dialog).filter({ has: page.locator(q.dialogTitle, { hasText: /^Remove server$/ }) });
    const body = await ask.locator(q.dialogBody).innerText();
    await check("10 the question before the removal says that everything stays on that server, and counts nothing",
      body.includes(`"${B.name}"`) && /stay there/.test(body) && /Nothing is deleted or stopped on that server/.test(body) && !/\d/.test(body.replace(B.name, "")), body);
    await ui.click(page, ui.button(ask, "Remove"));
  }
  const removed = await holds("the entry is gone", async () => (await entry()) === null && (await row.count()) === 0, { timeout: 15000 });
  await ui.closeServers(page);
  const gone = await holds("the section is gone", async () => PHONE ? (await page.locator(q.serverChip).count()) === 0 : (await page.locator(q.section).count()) === 1, { timeout: 15000 }); // (one server left: Home draws no chips)
  const listAfter = JSON.parse(fs.readFileSync(path.join(host1.stateDir, "servers.json"), "utf8"));
  await check("10 the entry is removed: its section leaves the sidebar, this computer's stays, and the app's list holds no entry", all(removed, gone) === true && listAfter.servers.length === 0, `sections on the page ${PHONE ? "(phone: chips " + await page.locator(q.serverChip).count() + ")" : await page.locator(q.section).count()}; the app's list ${one(listAfter.servers.map((v) => v.name))}`);
  const shut = await holds("the chat of B that was open is closed", async () => (await page.locator(`${q.thread}, ${q.chatHeadServer}, ${q.composer}`).count()) === 0 && !one(await sel(page)).includes(ENTRY), { timeout: 10000 });
  await check("10 the chat of that server that was open is closed with it: a removed entry is no outage, and nothing of it stays on screen", shut, `selection ${one(await sel(page))}; main: ${(await page.locator("main").first().innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 100)}`);
  await sleep(1500);
  const after = await census();
  await check("10 B still has everything: its groups, boards and chats", one(before) === one(after) && after.chats > 0, `before ${one(before)}; after ${one(after)}`);
  const local = await outline(page);
  await check("10 the local part is as it was", one(local) === one(PHONE ? [`chat ${HERE}`] : [`chat ${HERE}`, `group ${LOCAL_GROUP}`]) && (PHONE || (await stored(page, "aiwb.collapsed")) === "[]"), `${lines(local)}; stored collapse ${await stored(page, "aiwb.collapsed")}`);
  const kept = await page.evaluate((entry) => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? "").includes(entry) || k.includes(entry)), ENTRY);
  await check("10 the browser's storage holds nothing of B", kept.length === 0, one(kept));
}

// ---- main

let code = 0;
onSignal(async () => { await browser?.close().catch(() => {}); await host1?.close().catch(() => {}); await host2?.close().catch(() => {}); await link?.close(); for (const s of [A, B]) if (s) await s.stop(); });
try {
  await prepare();
  console.log(`# A on https://127.0.0.1:${A.port}; B on https://127.0.0.1:${B.port}, behind the link on ${link.port}; the page's host on ${host1.url}, the owner's on ${host2.url}; files in ${OUT}`);
  browser = await (await loadChromium()).launch({ headless: true });
  page = await openPage(A);
  for (const s of [A]) { const pid = host1.client.localInfo()?.pid; if (pid) s.pids.push(pid); } // (the host started A)
  await step("1 the sidebar alone; add B; an empty section", step1);
  if (!ENTRY) throw new Error("B was not added to the page's server list: nothing else can be shown");
  await step("2 the owner's things", step2);
  await step("3 making from the section", step3);
  // (Home has no counterpart of steps 4 to 6: a group is renamed, moved, archived and deleted from the row's sheet, which H2 adds; there is no drag,
  // no fold of a section, no sections' lines for entries that never connect, and "Show archived" is a switch of Settings. The wide layouts run them.)
  if (!PHONE) {
    await step("4 groups", step4);
    await step("5 moving and dragging", step5);
    await step("6 collapse and Show archived", step6);
    await step("6 more entries, which never connect", step6b);
  }
  await step("7 a chat with two pages", step7);
  try { process.kill(B.info.pid, "SIGCONT"); } catch { /* running */ }
  await step("7 the other page's settings and Stop", step7b);
  try { process.kill(B.info.pid, "SIGCONT"); } catch { /* running */ }
  await step("8 the link is pulled", step8);
  setLink("pass");
  await step("9 stopped, connecting, too old", step9);
  link.target = B.port;
  setLink("pass");
  if (!(await B.status().then((s) => s.running, () => null))) await B.launch().catch(() => {});
  if (!host2) await ownerHost().catch(() => {});
  if (!owner) owner = await openPage(B).catch(() => null);
  await step("M answers that are lost", stepLost);
  setLink("pass");
  await step("10 remove the entry", step10);
  // Not checks: an outage is answered 503 by design, and the browser logs those.
  console.log(`# the page's console errors (${page.errors.length}): ${[...new Set(page.errors)].slice(0, 8).join(" ; ") || "none"}`);
  console.log(`# the page's requests that failed (${page.failedRequests.length}): ${[...new Set(page.failedRequests)].slice(0, 12).join(" ; ") || "none"}`);
  code = failed ? 1 : 0;
} catch (e) {
  console.log(`FAIL - the script could not go on: ${e.stack || e}`);
  code = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
  await host1?.close().catch(() => {});
  await host2?.close().catch(() => {});
  await link?.close();
}
if (B?.info?.pid && !B.pids.includes(B.info.pid)) B.pids.push(B.info.pid);
const end = A && B ? await finish([A, B]) : { alive: [], free: true };
page = null;
if (A?.port && !(await check("both servers are stopped and their ports are free", end.free && end.alive.length === 0, `ports ${A.port}, ${B.port}, ${link?.port}; processes left: ${end.alive.join(", ") || "none"}`)) && !code) code = 1;
if (code === 0 && process.env.AIWB_E2E_KEEP !== "1") fs.rmSync(OUT, { recursive: true, force: true });
else console.log(`# files kept in ${OUT}`);
console.log(code === 0 ? "# passed" : code === 2 ? "# could not run to the end" : `# failed (${failed} checks)`);
process.exit(code);
