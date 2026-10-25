// The prompt library's popups of the app (app/, its web export) on real server processes, in a headless Chromium (S11): what the browser checks PL4.1 and
// PL5.2 prove on the mock, tried once more where the mock is only this repository's reading of the server
// (plans/prompt-library.md, section 10, lines 7 to 10 and 19 to 23 and 25, as far as the page goes). It is no check
// of dev/checks and `npm run uicheck` does not run it: it needs Go, to build the server.
//   node web/dev/reallibrary.mjs        builds the server and the app's web export (with `connect-src 'self'`, as the test host needs), runs, and removes what it made
// Two servers are started, each with a data folder of its own under the system's temporary folder and a free port: A,
// "this computer", which the test host (dev/host.mjs, which does for the page what the app's main process does) finds or
// starts with the server program, and B, another server, an entry of the host's list. A has the stand-in agent
// (internal/agenttest/fake-claude) and B none (the flags name programs that do not exist), so nothing here can call a paid
// model; A's agent gives the phone's chat its box (with no agent V1's block stands in its place), and nothing is sent from it. What another window or another machine's owner does is done by another host of
// its own (another app, another client of the server), with calls of the client API.
//   A alone: the popup opens on an empty library with no level of servers; a group, a prompt in it; a second prompt
//   of that name in another case is refused with the server's sentence and what was typed stays; a change made by
//   another client shows in the first window; deleting the group asks with the number of its prompts. Where an item
//   is, is the tree's: a right click on the space under the rows makes a group at the top level, one on a group a
//   prompt in it; a drop on a group moves a prompt and a group there, and the bar of the top level takes a group back;
//   a drop the server refuses for a name that is taken there, and for groups more than 16 deep, says the server's
//   sentence under the tree and moves nothing.
//   B joins the list: its library is in the open popup under its name, and a search for the server's name and a
//   prompt's name finds the prompt; a prompt made at its entry is in B's own library and not in A's; B refuses a
//   name that is taken, with its sentence; a change B's owner makes shows in the editor here. ⌘P in a chat's
//   composer lists both libraries and Enter puts B's prompt at the cursor.
//   B stops: its prompts stay in both popups, marked, can be inserted and cannot be changed; B is back: they can.
//   B is removed from the list: its prompts are gone, and the tree has no level of servers again.
// Then the same story on the phone (393 × 852, a finger, the viewport of the checks), through the phone's screens (package S4) on the same servers and the same
// host, with a fresh page: the servers' libraries are emptied first (the desktop pass leaves prompts in A and in B), and B has a new owner's app. The phone has
// no popups: the Library screen (pushed from Settings' Prompt library row, Settings from Home's gear),
// a group's screen, the editor and the group form as sheets, the Move picker, the Prompt sheet of a chat's composer.
//   A alone: the Library screen on an empty library has no section title; "+" > New group, a prompt in it by "New prompt here"; a second prompt of that name in
//   another case is refused with the server's sentence in the form and what was typed stays; a change by another client shows in the list and in an editor with
//   nothing unsaved; deleting the group asks "Delete group and 2 prompts". Moves by the Move picker (a swipe's Move, a long press's sheet): a prompt and a group
//   into another group, a group back to the top level; a name taken there and groups more than 16 deep are refused with the server's sentence in a toast, and
//   nothing moves.
//   B joins the list: one titled section per server, this computer first; a search finds B's prompt; a prompt made with the editor's Group row at B's top
//   level is in B's library and not in A's; B refuses a taken name with its sentence; a change by B's owner shows in the open editor. The Prompt sheet of a
//   chat's composer lists both libraries under their heads and a tap on B's prompt puts its text at the cursor.
//   B stops: its prompts stay on the Library screen with one notice and in the Prompt sheet, marked and insertable; its editor is read-only; B is back: it can
//   be changed. B is removed from the list: its section and prompts are gone, and no section is titled.
// The popups are read by `checks/library.mjs`; the pointer's drag is `pointerDragger` of `checks/sel.mjs`.
import fs from "node:fs";
import path from "node:path";
import { until, loadPlaywright, onEnd } from "./shot.mjs";
import { contextOptions } from "./viewports.mjs";
import { Scratch, hostApp, hostCall, hostFor, makeOut, pageDist, serverBinary, standInAgent } from "../e2e/lib/rig.mjs";
import { back, byTid, pointerDragger, press, showList, tidSel, touchDrag } from "./checks/sel.mjs";
import { atRest } from "./checks/settings.mjs";
import { waitConnected } from "../e2e/lib/ui.mjs";
import { holdOpen, openGroup, openLibrary, pressSheetRow, rowsOf, sectionsOf, sheetOf, texts, topScreen } from "./checks/libphone.mjs";
import { seen as libSeen, insertSeen } from "./checks/library.mjs";

const ROOT = makeOut("reallibrary");
const failures = [], fail = (line) => { failures.push(line); console.log(`FAIL ${line}`); }, pass = (line) => console.log(`ok   ${line}`), note = (line) => console.log(`     ${line}`);

let A, B, host, hostB, hostB2, hostOther, browser;
const tidy = async () => {
  await browser?.close().catch(() => {});
  for (const h of [host, hostB, hostB2, hostOther]) await h?.close().catch(() => {});
  for (const s of [A, B]) await s?.stop().catch(() => {});
  fs.rmSync(ROOT, { recursive: true, force: true });
};
onEnd(tidy);

/** A client of a server of its own: another app (a host with its own list and client id), which connects while it is subscribed.
 *  call(method, path, body, server): a call of the client API to `server` (default: its own server, "local"). */
async function client(h, server = "local") {
  const sub = h.client.subscribe(() => {});
  await until(async () => (await hostCall(h, server, "GET", "/api/state")).status === 200, 60000);
  return { call: async (method, at, body, to = server) => { const r = await hostCall(h, to, method, at, body); return { status: r.status, body: r.json }; }, close: () => sub.close() };
}
/** A server's own library, as it answers a read. */
const libraryOf = async (h, server = "local") => {
  const r = await hostCall(h, server, "GET", "/api/library");
  if (!r.json?.libraries) throw new Error(`a read of ${server}'s library on ${h.name} was answered ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.libraries[0];
};

/** In the page: what the two popups show (the readers of checks/library.mjs, put together; the page evaluates this text). */
const READ = `(() => {
  const l = (${libSeen})(), i = (${insertSeen})();
  return { open: !!l.open, rows: l.rows, off: l.off, says: l.says, treeErr: l.treeErr, ask: l.ask,
    form: l.form && { head: l.form.head, name: l.form.name, text: l.form.text, fixed: l.form.fixed, err: l.form.err, notice: l.form.notice, off: l.form.off, where: l.form.where },
    insert: i.open ? { rows: i.rows, off: i.off } : null };
})()`;

/** In the page: what the Prompt sheet of a composer shows (its section heads and rows, in the order drawn). */
const SHEET = `(() => {
  const Q = (id) => '[data-testid="' + id + '"]', pop = document.querySelector(Q("insert-popup"));
  if (!pop) return null;
  const t = (e) => e?.textContent?.trim() ?? "";
  return { items: [...pop.querySelectorAll(Q("insert-section") + ", " + Q("insert-row"))].map((e) => e.dataset.testid === "insert-section" ? { head: t(e) }
    : { row: t(e.querySelector(Q("lib-pname"))), server: e.dataset.server, off: t(e.querySelector(Q("lib-off"))) }) };
})()`;

/** The phone's pass: the story of the desktop pass through the phone's screens (see the header). A fresh page of the phone's viewport on the same host and the same
 *  servers; the libraries of A and B are emptied first, since the desktop pass left prompts in both. */
async function phonePass({ ofA, dist }) {
  const ok = (s) => pass(`phone: ${s}`), bad = (s) => fail(`phone: ${s}`), say = (s) => note(`phone: ${s}`), J = JSON.stringify;
  const WAIT = 30000;
  const LONG = "a".repeat(80);
  const playwright = await loadPlaywright();
  const errs = [];
  let ctx;
  try {
    // ---- the libraries start empty; B has an owner's app of its own again (the first was closed when B stopped in the desktop pass)
    hostB2 = await hostFor({ out: ROOT, name: "b-owner-2", local: B, extra: { dist } });
    const ofB = await client(hostB2);
    const wipe = async (h, of) => {
      const l = await libraryOf(h);
      for (const g of l.groups.filter((x) => !x.parent)) await of.call("DELETE", `/api/library/local/groups/${g.id}`);
      for (const p of l.prompts.filter((x) => !x.parent)) await of.call("DELETE", `/api/library/local/prompts/${p.id}`);
      const after = await libraryOf(h);
      if (after.groups.length || after.prompts.length) throw new Error(`a library was not emptied: ${J(after)}`);
    };
    await wipe(host, ofA);
    await wipe(hostB2, ofB);
    await ofB.call("POST", "/api/library/local/prompts", { name: "standup", parent: "", text: "What did you do?" });

    // ---- a page of the phone
    ctx = await browser.newContext(contextOptions(playwright, "phone"));
    const P = await ctx.newPage();
    P.on("pageerror", (e) => errs.push(e.message));
    P.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
    await P.goto(host.url);
    // (the phone's first screen is Home since H1: its gear pushes Settings, whose Prompt library row pushes the Library screen)
    await P.waitForSelector(tidSel("home-gear"), { timeout: 90000, state: "visible" });
    await waitConnected(P, "local"); // (Home's word for this computer: its library is in the page)

    // ---- what the page shows, and the ways to act on it
    const view = async () => {
      const [top, rows, secs] = await Promise.all([topScreen(P), rowsOf(P), sectionsOf(P)]);
      return { screen: top.testId, rows: rows.map((r) => ({ kind: r.kind, name: r.name, server: r.server, id: r.id, sub: r.sub })), secs };
    };
    const names = (v) => v.rows.map((r) => r.name);
    /** Waits for the page to show what `want` says, and says so; fails with what it shows. */
    const shows = async (what, want) => {
      let v;
      if (await until(async () => { try { return want(v = await view()); } catch { return false; } }, WAIT)) ok(what); else bad(`${what}: the page shows ${J(v)}`);
      return v;
    };
    const idsOf = async (h = host) => { const l = await libraryOf(h); return Object.fromEntries([...l.groups, ...l.prompts].map((x) => [x.name, x.id])); };
    const parentOf = async (name, h = host) => { const l = await libraryOf(h), x = [...l.prompts, ...l.groups].find((i) => i.name === name); return x ? x.parent : null; };
    const see = (t) => byTid(P, t).last();
    const gone = (id) => until(async () => (await byTid(P, id).count()) === 0 || !(await see(id).isVisible().catch(() => false)), WAIT);
    const sheetUp = async (id = "action-sheet") => {
      await see(id).waitFor({ state: "visible", timeout: WAIT });
      await atRest(P, id === "action-sheet" ? "action-row" : "confirm-go");
      await P.waitForFunction((id) => { const s = [...document.querySelectorAll(`[data-testid="${id}"]`)].pop(), last = [...s.querySelectorAll('[data-testid="action-row"], [data-testid="confirm-go"]')].pop(); return !!last && last.getBoundingClientRect().bottom <= innerHeight; }, id, { timeout: WAIT });
      return sheetOf(P, id);
    };
    const toLibrary = async () => {
      if ((await topScreen(P)).testId === "lib-screen") return;
      // (Home's gear, then Settings' Prompt library row: libphone.openLibrary, which needs no seam while the gear is on screen)
      await showList(P);
      return openLibrary(P);
    };
    const upToLibrary = async () => {
      for (let i = 0; i < 8 && (await topScreen(P)).testId !== "lib-screen"; i++) { await back(P); await P.waitForTimeout(450); }
      await atRest(P, "lib-screen");
    };
    const rowOf = (kind, id) => byTid(P, kind === "group" ? "lib-group-row" : "lib-prompt-row", { id }).last();
    const swipeOf = (id) => P.locator(`[data-testid="swipe-row"][data-id=${J(id)}]`).last();
    const swipeTo = async (id, action) => {
      const row = swipeOf(id);
      await until(async () => (await row.locator('[data-testid="swipe-action"]').count()) === 0, WAIT); // (a row used just now is closed by then)
      await row.scrollIntoViewIfNeeded();
      const b = await row.boundingBox();
      await touchDrag(P, { x: b.x + b.width * 0.7, y: b.y + b.height / 2 }, { x: b.x + b.width * 0.3, y: b.y + b.height / 2 }, { hold: 0 });
      const act = row.locator(`[data-testid="swipe-action"][data-action=${J(action)}]`).first();
      await act.waitFor({ state: "visible", timeout: WAIT });
      await press(P, act);
    };
    /** Move: by the swipe or by the row's sheet (a long press); `value` is the picker row's (`server|group`). */
    const move = async (how, kind, id, value) => {
      if (how === "swipe") await swipeTo(id, "move");
      else { await holdOpen(P, rowOf(kind, id)); await sheetUp(); await pressSheetRow(P, "action-sheet", "move"); }
      await atRest(P, "move-picker");
      await press(P, see("move-picker").locator(tidSel("picker-row", { value })).first());
      if (!await gone("move-picker")) bad(`the Move picker stays after a pick (${value})`);
    };
    const toast = async () => {
      let t = "";
      await until(async () => (t = await see("toast").innerText().catch(() => "")) !== "", WAIT);
      return { text: t.replace(/\s+/g, " ").trim(), kind: await see("toast").getAttribute("data-kind").catch(() => null) };
    };
    const field = (id) => see(id);
    const saveBtn = () => see("sheet-right");
    const off = async (loc) => (await loc.getAttribute("aria-disabled")) === "true";
    const sentenceOf = (r) => r.body?.error ?? r.body?.message ?? "";
    /** A sheet closed by its Save or its Cancel. */
    const closedEditor = (what) => gone("prompt-editor").then((g) => { if (!g) bad(`${what}: the editor stays`); return g; });

    // ======== A alone
    await toLibrary();
    {
      // (the server's snapshot brings its library a moment after Home says it is connected)
      let v, empty;
      const fine = await until(async () => { v = await view(); empty = await texts(P, "lib-phone-empty"); return v.screen === "lib-screen" && !v.rows.length && !v.secs.some((s) => s.title) && !!empty[0]?.includes("No prompts yet"); }, WAIT);
      if (fine) ok("a new server: the Library screen opens on an empty library with no section title");
      else bad(`the Library screen on an empty library shows ${J({ ...v, empty })}`);
    }
    await press(P, see("lib-plus"));
    await sheetUp();
    await pressSheetRow(P, "action-sheet", "new-group");
    await atRest(P, "group-form");
    await field("group-form-name").fill("git");
    await press(P, saveBtn());
    await gone("group-form");
    await shows("\"+\" > New group makes a group, at the top level", (v) => names(v).join("|") === "git" && v.rows[0].kind === "group");
    const gitId = (await idsOf()).git;
    await openGroup(P, gitId);
    await press(P, see("lib-new-here"));
    await atRest(P, "prompt-editor");
    await field("editor-name").fill("review");
    await field("editor-text").fill("Review this change.\n\n- say why");
    await press(P, saveBtn());
    await closedEditor("Save of a new prompt");
    await shows("\"New prompt here\" makes a prompt in the group", (v) => v.screen === "lib-group-screen" && names(v).join("|") === "review");
    {
      const mine = await libraryOf(host), p = mine.prompts.find((x) => x.name === "review");
      if (mine.groups.length === 1 && p?.parent === gitId && p.text === "Review this change.\n\n- say why") ok("the server holds what the screens made, the text with its line breaks"); else bad(`A's library is ${J(mine)}`);
    }
    // a second prompt of that name in another case: refused, and what was typed stays
    const dup = await ofA.call("POST", "/api/library/local/prompts", { name: "REVIEW", parent: gitId, text: "x" });
    if (dup.status < 400) bad(`the server took a second prompt of that name in another case: ${J(dup)}`);
    await press(P, see("lib-new-here"));
    await atRest(P, "prompt-editor");
    await field("editor-name").fill("REVIEW");
    await field("editor-text").fill("typed");
    await press(P, saveBtn());
    {
      let said = "";
      await until(async () => (said = await see("form-error").innerText().catch(() => "")) !== "", WAIT);
      const kept = [await field("editor-name").inputValue(), await field("editor-text").inputValue()];
      if (said && (!sentenceOf(dup) || said.includes(sentenceOf(dup))) && kept[0] === "REVIEW" && kept[1] === "typed") ok("a second prompt of that name in another case is refused with the server's sentence in the form, and what was typed stays");
      else bad(`the refused save shows ${J(said)} (the server says ${J(sentenceOf(dup))}), the fields hold ${J(kept)}`);
      say(`the server's sentence: ${said}`);
    }
    await field("editor-name").fill(LONG);
    await press(P, saveBtn());
    await closedEditor("Save of a name of 80 characters");
    await shows("a name of 80 characters is saved", (v) => names(v).includes(LONG) && names(v).includes("review"));
    // another client renames the prompt; the list shows it, and an editor on it has nothing unsaved
    const reviewId = (await idsOf()).review;
    const renamed = await ofA.call("PATCH", `/api/library/local/prompts/${reviewId}`, { name: "review twice" });
    if (renamed.status !== 200) bad(`the other client's rename was answered ${J(renamed)}`);
    await shows("a change made by another client shows on the screen with no reload", (v) => names(v).includes("review twice") && !names(v).includes("review"));
    await press(P, rowOf("prompt", reviewId));
    await atRest(P, "prompt-editor");
    {
      const before = [await field("editor-name").inputValue(), await field("editor-text").inputValue()];
      const patched = await ofA.call("PATCH", `/api/library/local/prompts/${reviewId}`, { text: "Changed by another client." });
      if (patched.status !== 200) bad(`the other client's change of the text was answered ${J(patched)}`);
      const followed = await until(async () => (await field("editor-text").inputValue()) === "Changed by another client.", WAIT);
      if (before[0] === "review twice" && followed && await off(saveBtn())) ok("a change by another client shows in an editor with nothing unsaved, and Save stays off");
      else bad(`the editor held ${J(before)} and now holds ${J(await field("editor-text").inputValue())}; Save off: ${await off(saveBtn())}`);
    }
    await press(P, see("sheet-left"));
    if (!await closedEditor("Cancel of an editor with nothing unsaved") || await byTid(P, "confirm-sheet").count()) bad("Cancel of an editor with nothing unsaved asks");
    // deleting the group asks with the number of its prompts
    await upToLibrary();
    await holdOpen(P, rowOf("group", gitId));
    await sheetUp();
    await pressSheetRow(P, "action-sheet", "delete");
    await sheetUp("confirm-sheet");
    {
      const asked = await P.evaluate(() => [document.querySelector('[data-testid="confirm-title"]')?.textContent, document.querySelector('[data-testid="confirm-go"]')?.textContent]);
      if (asked[1] === "Delete group and 2 prompts") ok("deleting the group asks \"Delete group and 2 prompts\""); else bad(`the question before the group is deleted: ${J(asked)}`);
    }
    await press(P, see("confirm-cancel"));
    await gone("confirm-sheet");
    if (!(await libraryOf(host)).groups.some((g) => g.id === gitId)) bad("Cancel deleted the group");

    // ======== where an item is: the Move picker
    const made = await ofA.call("POST", "/api/library/local/groups", { name: "misc", parent: "" });
    const miscId = made.body?.group?.id;
    const twice = await ofA.call("POST", "/api/library/local/prompts", { name: "Review Twice", parent: miscId, text: "A prompt that takes the name." });
    if (!miscId || twice.status >= 400) throw new Error(`the fixtures were not made: ${J([made, twice])}`);
    await shows("the library as the moves start", (v) => names(v).join("|") === "git|misc");
    await openGroup(P, gitId);
    const lib0 = await idsOf(), longId = lib0[LONG];
    // a name taken there: the server's sentence as a toast, and nothing moves
    const refused = await ofA.call("PATCH", `/api/library/local/prompts/${reviewId}`, { parent: miscId });
    if (refused.status < 400) bad(`the server took a prompt into a group that has its name: ${J(refused)}`);
    await move("swipe", "prompt", reviewId, `local|${miscId}`);
    {
      const t = await toast();
      if (t.kind === "error" && t.text && (!sentenceOf(refused) || t.text.includes(sentenceOf(refused))) && await parentOf("review twice") === gitId) ok("a move the server refuses for a name taken there shows its sentence as a toast, and nothing moves");
      else bad(`the refused move shows ${J(t)} (the server says ${J(sentenceOf(refused))}); the prompt is in ${J(await parentOf("review twice"))}`);
      say(`the server's sentence: ${t.text}`);
    }
    await P.waitForTimeout(600);
    // a prompt into another group by the swipe's Move
    await move("swipe", "prompt", longId, `local|${miscId}`);
    await shows("the swipe's Move moves a prompt into another group", (v) => v.screen === "lib-group-screen" && names(v).join("|") === "review twice");
    if (await parentOf(LONG) !== miscId) bad(`the server has the moved prompt in ${J(await parentOf(LONG))}`);
    // a group into another group, by the long press's sheet
    await upToLibrary();
    await move("sheet", "group", gitId, `local|${miscId}`);
    await shows("the long press's Move moves a group into another group", (v) => v.screen === "lib-screen" && names(v).join("|") === "misc");
    if (await parentOf("git") !== miscId) bad(`the server has the moved group in ${J(await parentOf("git"))}`);
    // and back to the top level
    await openGroup(P, miscId);
    await shows("the group's new place lists it, with what is in it", (v) => v.screen === "lib-group-screen" && v.rows[0]?.name === "git" && v.rows.length === 3);
    await move("swipe", "group", gitId, "local|");
    await shows("Move to Top level takes the group back", (v) => names(v).join("|") === [LONG, "Review Twice"].join("|"));
    if (await parentOf("git") !== "") bad(`the server has the group in ${J(await parentOf("git"))}, not at the top level`);
    await upToLibrary();
    await shows("the Library screen lists both groups again", (v) => names(v).join("|") === "git|misc");
    // groups more than 16 deep: the server's rule
    let deep = "", d16 = "";
    for (let i = 1; i <= 16; i++) { deep = (await ofA.call("POST", "/api/library/local/groups", { name: "d" + i, parent: deep })).body?.group?.id ?? ""; if (i === 16) d16 = deep; }
    const tooDeep = await ofA.call("PATCH", `/api/library/local/groups/${miscId}`, { parent: d16 });
    if (tooDeep.status < 400) bad(`the server took a group into the 16th: ${J(tooDeep)}`);
    await shows("16 groups inside one another are on the Library screen", (v) => names(v).includes("d1"));
    await move("sheet", "group", miscId, `local|${d16}`);
    {
      const t = await toast();
      if (t.kind === "error" && t.text && (!sentenceOf(tooDeep) || t.text.includes(sentenceOf(tooDeep))) && await parentOf("misc") === "") ok("a group moved into groups 16 deep is refused with the server's sentence as a toast, and has not moved");
      else bad(`the refused move shows ${J(t)} (the server says ${J(sentenceOf(tooDeep))}); the group is in ${J(await parentOf("misc"))}`);
      say(`the server's sentence: ${t.text}`);
    }
    await ofA.call("DELETE", `/api/library/local/groups/${(await idsOf()).d1}`);
    await shows("the library as it was before the deep groups", (v) => names(v).join("|") === "git|misc");

    // ======== another server joins the list
    const address = `https://127.0.0.1:${B.port}`;
    const tested = await hostApp(host, "servers.test", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: "" } });
    const added = await hostApp(host, "servers.add", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: tested.json?.fingerprint } });
    if (!added.json?.saved) throw new Error(`B was not added to the page's list: ${J(added.json)} (its test: ${J(tested.json)})`);
    const entry = added.json.server.id;
    await shows("the other server joins: one titled section per server, this computer first", (v) => v.secs.length === 2 && v.secs[0].server === "local" && v.secs[0].title === "This computer" && v.secs[1].server === entry && v.secs[1].title === "Studio" && v.secs[1].rows === 1);
    const search = see("lib-phone-search");
    await search.fill("studio stand");
    await shows("a search for the server's name and a prompt's name finds the prompt", (v) => v.rows.length === 1 && v.rows[0].kind === "hit" && v.rows[0].name === "standup" && v.rows[0].server === entry && v.rows[0].sub.startsWith("Studio"));
    await search.fill("");
    await shows("the search emptied, the sections are back", (v) => v.secs.length === 2);
    // a prompt made with the editor's Group row set to the other server's top level
    const pickStudio = async () => {
      await press(P, see("editor-group-row"));
      await atRest(P, "move-picker");
      await press(P, see("move-picker").locator(tidSel("picker-row", { value: `${entry}|` })).first());
      await gone("move-picker");
    };
    await press(P, see("lib-plus"));
    await sheetUp();
    await pressSheetRow(P, "action-sheet", "new-prompt");
    await atRest(P, "prompt-editor");
    await field("editor-name").fill("retro");
    await field("editor-text").fill("What went well?");
    await pickStudio();
    {
      const where = (await see("editor-group-row").innerText()).replace(/\s+/g, " ").trim();
      if (where === "Group Studio › Top level") ok("the Group row says the other server's top level after the pick"); else bad(`the Group row says ${J(where)}`);
    }
    await press(P, saveBtn());
    await closedEditor("Save of a prompt for the other server");
    const theirs = await libraryOf(host, entry), retro = theirs.prompts.find((p) => p.name === "retro");
    if (retro?.text === "What went well?" && !(await libraryOf(host)).prompts.some((p) => p.name === "retro")) ok("the prompt is in the other server's own library, and not in this computer's"); else bad(`B's own library is ${J(theirs)}`);
    await shows("it is on the Library screen under the server", (v) => v.rows.some((r) => r.name === "retro" && r.server === entry));
    // the other server refuses a name that is taken
    const taken = await ofB.call("POST", "/api/library/local/prompts", { name: "Retro", parent: "", text: "x" });
    if (taken.status < 400) bad(`B took a second prompt of that name in another case: ${J(taken)}`);
    await press(P, see("lib-plus"));
    await sheetUp();
    await pressSheetRow(P, "action-sheet", "new-prompt");
    await atRest(P, "prompt-editor");
    await field("editor-name").fill("Retro");
    await pickStudio();
    await press(P, saveBtn());
    {
      let said = "";
      await until(async () => (said = await see("form-error").innerText().catch(() => "")) !== "", WAIT);
      if (said && (!sentenceOf(taken) || said.includes(sentenceOf(taken))) && await field("editor-name").inputValue() === "Retro") ok("the other server refuses a name that is taken, and the form shows its sentence");
      else bad(`B's refusal shows ${J(said)} (the server says ${J(sentenceOf(taken))})`);
      say(`its sentence: ${said}`);
    }
    await press(P, see("sheet-left"));
    await sheetUp("confirm-sheet");
    await press(P, see("confirm-go"));
    await closedEditor("Discard of the refused prompt");
    // a change B's owner makes shows in the editor here
    await press(P, rowOf("prompt", retro.id));
    await atRest(P, "prompt-editor");
    {
      const patched = await ofB.call("PATCH", `/api/library/local/prompts/${retro.id}`, { text: "Changed by the owner." });
      if (patched.status !== 200) bad(`the owner's change was answered ${J(patched)}`);
      if (await until(async () => (await field("editor-text").inputValue()) === "Changed by the owner." && await off(saveBtn()), WAIT)) ok("a change the server's owner makes shows in the editor here, with no reload"); else bad(`the editor holds ${J(await field("editor-text").inputValue())}`);
    }
    await press(P, see("sheet-left"));
    await closedEditor("Cancel of the editor");

    // ======== the Prompt sheet in a chat's composer
    await showList(P);
    // (Home's "+ New" and its sheet's Chat tile, since H2)
    await press(P, byTid(P, "home-new").first());
    await press(P, byTid(P, "home-new-sheet").last().locator(tidSel("new-chat")).first());
    const box = byTid(P, "composer-input").first(), held = async () => (await box.evaluate((e) => e.innerText)).replace(/\n+$/, "");
    await box.waitFor({ state: "visible", timeout: 30000 });
    await press(P, box);
    await P.keyboard.type("Hello world");
    for (let i = 0; i < 6; i++) await P.keyboard.press("ArrowLeft");
    const sheetNow = () => P.evaluate(SHEET);
    const sheetShows = async (what, want) => {
      let s;
      if (await until(async () => want((s = await sheetNow())), WAIT)) ok(what); else bad(`${what}: the sheet shows ${J(s)}`);
      return s;
    };
    const rowsFor = (s, server) => s.items.filter((i) => i.row !== undefined && i.server === server).map((i) => i.row);
    await P.keyboard.press("ControlOrMeta+p");
    await sheetShows("the Prompt sheet lists both libraries under their heads", (s) => {
      if (!s) return false;
      const heads = s.items.filter((i) => i.head !== undefined).map((i) => i.head), rows = s.items.filter((i) => i.row !== undefined);
      const lastLocal = rows.map((r) => r.server).lastIndexOf("local"), firstTheirs = rows.findIndex((r) => r.server === entry);
      return J(rowsFor(s, "local").sort()) === J([LONG, "Review Twice", "review twice"].sort()) && J(rowsFor(s, entry)) === J(["retro", "standup"]) && lastLocal < firstTheirs
        && heads.some((h) => h.startsWith("This computer")) && heads.some((h) => h === "Studio") && !rows.some((r) => r.off);
    });
    await press(P, byTid(P, "insert-row", { server: entry }).filter({ hasText: "retro" }).first());
    if (await until(async () => await held() === "HelloChanged by the owner. world", WAIT)) ok("a tap on the other server's prompt puts its text at the cursor"); else bad(`after the insertion the box holds ${J(await held())}`);

    // ======== the other server stops, and is back
    ofB.close();
    await hostB2.close(); // (B's own app would start it again)
    hostB2 = null;
    await B.stop();
    await press(P, box);
    await P.keyboard.press("ControlOrMeta+p");
    await sheetShows("the server stopped: the Prompt sheet still lists its prompts, marked", (s) => !!s && J([...new Set(s.items.filter((i) => i.off).map((i) => i.row))].sort()) === J(["retro", "standup"]) && s.items.filter((i) => i.row !== undefined && i.server === entry).every((i) => /not connected/i.test(i.off)) && s.items.filter((i) => i.row !== undefined && i.server === "local").every((i) => !i.off)); // (retro is also under Recent: it was inserted)
    await press(P, byTid(P, "insert-row", { server: entry }).filter({ hasText: "standup" }).first());
    if (await until(async () => (await held()).includes("What did you do?"), WAIT)) ok("a prompt of the server that stopped is inserted"); else bad(`after the insertion the box holds ${J(await held())}`);
    await press(P, box);
    await P.keyboard.press("ControlOrMeta+p");
    await sheetShows("the sheet is there again for the way to the library", (s) => !!s);
    await press(P, byTid(P, "insert-library"));
    await atRest(P, "lib-screen");
    {
      const [secs, notices] = [await sectionsOf(P), await texts(P, "lib-off-notice")];
      const v = await view();
      if (notices.length === 1 && secs.find((s) => s.server === entry)?.notice.length === 1 && !secs.find((s) => s.server === "local")?.notice.length && v.rows.some((r) => r.name === "retro" && r.server === entry)) ok("the server that stopped: its prompts stay on the Library screen, with one not-connected notice");
      else bad(`the Library screen shows ${J({ secs, notices, rows: names(v) })}`);
      say(`the notice: ${notices[0]}`);
    }
    await press(P, rowOf("prompt", retro.id));
    await atRest(P, "prompt-editor");
    {
      const readOnly = async (id) => field(id).evaluate((e) => e.readOnly || e.disabled);
      const s = { notices: await byTid(P, "editor-off-notice").count(), name: await readOnly("editor-name"), text: await readOnly("editor-text"), save: await off(saveBtn()), group: await off(see("editor-group-row")), del: await off(see("editor-delete")) };
      if (s.notices === 1 && s.name && s.text && s.save && s.group && s.del) ok("its editor is read-only: the fields locked, Save, the Group row and Delete off"); else bad(`the editor of a prompt of the server that stopped shows ${J(s)}`);
      say(`the editor says: ${(await see("editor-off-notice").innerText()).replace(/\s+/g, " ")}`);
    }
    const refused503 = await hostCall(host, entry, "DELETE", `/api/library/local/prompts/${retro.id}`);
    if (refused503.status === 503 && refused503.json?.code === "server_unreachable") ok(`a call past the screens is refused: ${refused503.json.error}`); else bad(`a change while the server is away was answered ${J(refused503.json)}`);
    await press(P, see("sheet-left"));
    await closedEditor("Cancel of the read-only editor");
    await B.launch();
    if (await until(async () => !(await texts(P, "lib-off-notice")).length, 90000)) ok("the server is back: the notice is gone"); else bad("the notice stays after the server came back");
    await press(P, rowOf("prompt", retro.id));
    await atRest(P, "prompt-editor");
    await field("editor-text").fill("Saved after it came back.");
    await press(P, saveBtn());
    await closedEditor("Save after the server came back");
    if (await until(async () => (await libraryOf(host, entry)).prompts.some((p) => p.text === "Saved after it came back."), 20000)) ok("the server is back: its prompt can be changed again, and a save reaches it"); else bad("the save after the server came back did not reach it");

    // ======== removed from the list
    await hostApp(host, "servers.remove", { id: entry });
    await shows("removed from the list, the server takes its prompts with it, and no section is titled", (v) => v.screen === "lib-screen" && names(v).join("|") === "git|misc" && v.secs.length === 1 && !v.secs[0].title);
    for (const e of errs) bad(`page error: ${e}`);
  } catch (e) { bad(String(e?.stack ?? e)); }
  await ctx?.close().catch(() => {});
}

try {
  const bin = serverBinary(ROOT);
  const dist = pageDist(ROOT);
  // (A has the stand-in agent: on the phone a chat with no agent installed shows V1's block in the box's place, and the Prompt sheet needs the box)
  A = new Scratch({ out: ROOT, bin, agent: standInAgent(ROOT), tag: "a", name: "This computer" });
  B = new Scratch({ out: ROOT, bin, agent: null, tag: "b", name: "Studio" });
  await A.setUp();
  await B.setUp();
  await B.launch();
  // (B's own app, which is B's owner here, and another app of A's owner: other clients of the servers, not pages)
  hostB = await hostFor({ out: ROOT, name: "b-owner", local: B, extra: { dist } });
  hostOther = await hostFor({ out: ROOT, name: "other", extra: { dist } });
  host = await hostFor({ out: ROOT, name: "page", local: A, extra: { dist } });
  const ofB = await client(hostB);
  browser = await (await loadPlaywright()).chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/^Failed to load resource/.test(m.text())) errors.push("console: " + m.text()); });
  await page.goto(host.url);
  await page.waitForSelector(tidSel("library-btn"), { timeout: 30000 });
  await page.waitForSelector(tidSel("side-section-state", { server: "local", tone: "ok" }), { timeout: 90000 }); // (this computer's server is found or started and connected)
  const read = () => page.evaluate(READ);
  /** Waits for the page to show what `want` says, and says so; fails with what it shows. */
  const shows = async (what, want) => {
    let s;
    if (await until(async () => want((s = await read())), 30000)) pass(what); else fail(`${what}: the page shows ${JSON.stringify(s)}`);
    return s;
  };
  const esc = (l) => new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  const D = byTid(page, "library-dialog"), libBtn = byTid(page, "library-btn");
  const row = (label) => D.locator(`${tidSel("lib-row")}:not([data-new="true"])`).filter({ has: page.locator(tidSel("lib-name"), { hasText: esc(label) }) });
  const button = (label) => D.locator('[role="button"]').filter({ hasText: esc(label) });
  const name = byTid(D, "lib-name-input"), text = byTid(D, "lib-text-input"), LONG = "a".repeat(80), search = byTid(D, "lib-search");
  const answer = (label) => byTid(page, "confirm-dialog").locator('[role="button"]').filter({ hasText: esc(label) }).click();

  // ---- this computer's library alone
  await libBtn.click();
  await shows("a new server: the popup opens on an empty library", (s) => s.open && !s.rows.length && s.says === "The library has no prompts yet.");
  await button("New group").click(); await name.fill("git"); await button("Save").click();
  await shows("a group is made", (s) => s.rows.join("|") === "git" && s.form?.head === "Group");
  await button("New prompt").click(); await name.fill("review"); await text.fill("Review this change.\n\n- say why"); await button("Save").click();
  await shows("a prompt is made in the chosen group; the tree has no level of servers", (s) => s.rows.join("|") === "git|  review" && s.form?.head === "Prompt" && s.form.where === "In git");
  await button("New prompt").click(); await name.fill("REVIEW"); await text.fill("typed"); await button("Save").click();
  let s = await shows("a second prompt of that name in another case is refused, and what was typed stays", (x) => !!x.form?.err && x.form.name === "REVIEW" && x.form.text === "typed");
  note(`the server's sentence: ${s.form?.err}`);
  await name.fill(LONG); await button("Save").click();
  await shows("a name of 80 characters is saved", (x) => x.rows.length === 3 && x.form?.head === "Prompt" && !x.form.err);
  const mine = await libraryOf(host);
  if (mine.groups.length === 1 && mine.prompts.length === 2 && mine.prompts.some((p) => p.text === "Review this change.\n\n- say why")) pass("the server holds what the popup made, the text with its line breaks"); else fail(`A's library is ${JSON.stringify(mine)}`);
  // another client of A (another app: its host has A as an entry of its list) renames the prompt, as a second window would
  const addedA = await hostApp(hostOther, "servers.add", { force: true, form: { name: "A", address: `https://127.0.0.1:${A.port}`, secret: A.secret, selfSigned: true, pin: A.fingerprint } });
  const entryA = addedA.json?.server?.id;
  if (!entryA) throw new Error(`A was not added to the other app's list: ${JSON.stringify(addedA)}`);
  const ofA = await client(hostOther, entryA);
  const renamed = await ofA.call("PATCH", `/api/library/local/prompts/${mine.prompts.find((x) => x.name === "review")?.id}`, { name: "review twice" });
  if (renamed.status !== 200) fail(`the other client's rename was answered ${JSON.stringify(renamed)}`);
  await shows("a change made by another client shows in the window with no reload", (x) => x.rows.includes("  review twice") && !x.rows.includes("  review"));
  await row("git").click(); await button("Delete").click();
  const asked = await until(async () => (await read()).ask?.body, 10000);
  if (asked === "“git” is deleted with everything in it: 2 prompts.") pass("deleting the group asks with the number of its prompts"); else fail(`the question before the group is deleted: ${JSON.stringify(asked)}`);
  await answer("Cancel");

  // ---- where an item is, is the tree's: the menu of a right click, and a drag
  const d = await pointerDragger(page, { steps: 6 });
  const centre = async (t) => { if ("x" in t) return t; await t.scrollIntoViewIfNeeded(); const b = await t.boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };
  const entryOf = (label) => byTid(page, "lib-menu").locator(tidSel("lib-menu-item")).filter({ hasText: esc(label) }), bar = byTid(D, "lib-top");
  const dragTo = async (label, to) => { const p = await centre(row(label)); await d.start(p); await d.move({ x: p.x + 9, y: p.y + 5 }); await d.move(await centre(to)); await d.end(); };
  const parentOf = async (label) => { const l = await libraryOf(host), x = [...l.prompts, ...l.groups].find((i) => i.name === label); return l.groups.find((q) => q.id === x?.parent)?.name ?? (x ? "" : null); };
  const list = await byTid(D, "lib-list-frame").boundingBox();
  await page.mouse.click(list.x + list.width / 2, list.y + list.height - 10, { button: "right" });
  await entryOf("New group").click(); await name.fill("misc"); await button("Save").click();
  await shows("a right click on the space under the rows makes a group at the top level", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc"].join("|") && x.form?.head === "Group" && x.form.where === "At the top level");
  await row("misc").click({ button: "right" });
  await entryOf("New prompt").click(); await name.fill("Review Twice"); await button("Save").click();
  await shows("a right click on a group makes a prompt in it", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|") && x.form?.where === "In misc");
  await dragTo("review twice", row("misc"));
  s = await shows("a drop the server refuses for the name says so under the tree, and nothing moves", (x) => !!x.treeErr && x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|"));
  note(`the server's sentence: ${s.treeErr}`);
  if (await parentOf("review twice") !== "git") fail(`after the refused drop the prompt is in ${JSON.stringify(await parentOf("review twice"))}`);
  await dragTo(LONG, row("Review Twice")); // (on a prompt: beside it)
  await shows("a drop on a prompt of another group moves the dragged prompt beside it", (x) => x.rows.join("|") === ["git", "  review twice", "misc", "  " + LONG, "  Review Twice"].join("|") && !x.treeErr);
  await dragTo("git", row("misc"));
  await shows("a drop on a group moves a group there, with what is in it", (x) => x.rows.join("|") === ["misc", "  git", "    review twice", "  " + LONG, "  Review Twice"].join("|"));
  if (await parentOf(LONG) === "misc" && await parentOf("git") === "misc") pass("the server holds both where they were dropped"); else fail(`after the drops the server has them in ${JSON.stringify([await parentOf(LONG), await parentOf("git")])}`);
  await dragTo("git", bar);
  await dragTo(LONG, row("git"));
  await shows("the bar of the top level takes the group back, and the prompt goes back into it", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice", "misc", "  Review Twice"].join("|") && !x.treeErr);
  // groups more than 16 deep: the server's own rule, for a group made there and for one moved there
  const maker = ofA;
  for (let i = 1, parent = ""; i <= 16; i++) parent = (await maker.call("POST", "/api/library/local/groups", { name: "d" + i, parent })).body?.group?.id ?? "";
  await shows("16 groups inside one another are in the tree", (x) => x.rows.includes("  ".repeat(15) + "d16"));
  await row("d16").click({ button: "right" });
  await entryOf("New group").click(); await name.fill("d17"); await button("Save").click();
  s = await shows("a 17th group in them is refused, and what was typed stays", (x) => !!x.form?.err && x.form.name === "d17");
  note(`the server's sentence: ${s.form?.err}`);
  await button("Cancel").click();
  await dragTo("misc", row("d16"));
  s = await shows("a group dropped into them is refused under the tree, and has not moved", (x) => !!x.treeErr && x.rows.at(-2) === "misc");
  note(`the server's sentence: ${s.treeErr}`);
  await dragTo("Review Twice", row("d16"));
  await shows("a prompt dropped into the 16th group is taken", (x) => x.rows.includes("  ".repeat(16) + "Review Twice") && !x.treeErr);
  const made = await libraryOf(host);
  for (const id of [made.groups.find((x) => x.name === "d1")?.id, made.groups.find((x) => x.name === "misc")?.id]) await maker.call("DELETE", `/api/library/local/groups/${id}`);
  await shows("the library as it was before the moves", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice"].join("|"));

  // ---- another server joins the list
  const address = `https://127.0.0.1:${B.port}`;
  await ofB.call("POST", "/api/library/local/prompts", { name: "standup", parent: "", text: "What did you do?" });
  const tested = await hostApp(host, "servers.test", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: "" } });
  const added = await hostApp(host, "servers.add", { form: { name: "Studio", address, secret: B.secret, selfSigned: true, pin: tested.json?.fingerprint } });
  if (!added.json?.saved) throw new Error(`B was not added to the page's list: ${JSON.stringify(added.json)} (its test: ${JSON.stringify(tested.json)})`);
  const entry = added.json.server.id;
  await shows("the other server's library is in the open popup under its name, after this computer's", (x) => x.rows.join("|") === ["This computer", "  git", "    " + LONG, "    review twice", "Studio", "  standup"].join("|") && !x.off.length);
  await search.fill("studio stand");
  await shows("a search for the server's name and a prompt's name finds the prompt", (x) => x.rows.join("|") === "Studio/standup");
  await search.fill("");
  await row("Studio").click(); await button("New prompt").click();
  await shows("a new prompt at the server's entry is to go to that server", (x) => x.form?.head === "New prompt" && x.form.where === "In Studio");
  await name.fill("retro"); await text.fill("What went well?"); await button("Save").click();
  await shows("it is in the tree under the server", (x) => x.rows.includes("  retro") && x.form?.head === "Prompt" && x.form.name === "retro");
  const theirs = await libraryOf(host, entry), retro = theirs.prompts.find((p) => p.name === "retro");
  if (retro?.text === "What went well?" && !(await libraryOf(host)).prompts.some((p) => p.name === "retro")) pass("the prompt is in the other server's own library, and not in this computer's"); else fail(`B's own library is ${JSON.stringify(theirs)}`);
  await button("New prompt").click(); await name.fill("Retro"); await button("Save").click();
  s = await shows("the other server refuses a name that is taken, and the popup shows its sentence", (x) => !!x.form?.err && x.form.name === "Retro");
  note(`its sentence: ${s.form?.err}`);
  await button("Cancel").click();
  await row("retro").click();
  await shows("the prompt is chosen", (x) => x.form?.name === "retro" && x.form.text === "What went well?");
  const patched = await ofB.call("PATCH", `/api/library/local/prompts/${retro?.id}`, { text: "Changed by the owner." });
  if (patched.status !== 200) fail(`the owner's change was answered ${JSON.stringify(patched)}`);
  await shows("a change the server's owner makes shows in the editor here, with no reload", (x) => x.form?.text === "Changed by the owner.");

  // ---- the insert popup, in a chat's composer
  await page.keyboard.press("Escape");
  await byTid(page, "side-new").first().click();
  await byTid(page, "menu-item").filter({ hasText: /^\s*New chat\s*$/ }).first().click();
  const box = byTid(page, "composer-input").first(), held = async () => (await box.evaluate((e) => e.innerText)).replace(/\n+$/, "");
  await box.click({ timeout: 15000 });
  await page.keyboard.type("Hello world");
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ControlOrMeta+p");
  await shows("⌘P in a chat's composer lists both libraries", (x) => x.insert?.rows.join("|") === [`This computer/git/${LONG}`, "This computer/git/review twice", "Studio/retro", "Studio/standup"].join("|") && !x.insert.off.length);
  await page.keyboard.type("studio retro");
  await page.keyboard.press("Enter");
  if (await until(async () => await held() === "HelloChanged by the owner. world", 10000)) pass("Enter puts the other server's prompt at the cursor"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);

  // ---- the other server stops, and is back
  await libBtn.click();
  await row("retro").click();
  ofB.close();
  await hostB.close(); // (B's own app would start it again)
  hostB = null;
  await B.stop();
  s = await shows("the server stopped: its prompts are still listed, it is marked, and nothing of it can be changed", (x) => x.off.join() === "Studio" && x.rows.includes("  retro") && x.form?.fixed === true && ["Save", "Delete"].every((l) => x.form.off.includes(l)));
  note(`the editor says: ${s.form?.notice}`);
  const refused = await hostCall(host, entry, "DELETE", `/api/library/local/prompts/${retro?.id}`);
  if (refused.status === 503 && refused.json?.code === "server_unreachable") pass(`a call past the popup is refused: ${refused.json.error}`); else fail(`a change while the server is away was answered ${JSON.stringify(refused.json)}`);
  await page.keyboard.press("Escape");
  await box.click();
  await page.keyboard.press("ControlOrMeta+p");
  await shows("the insert popup still lists them, marked", (x) => x.insert?.off.join("|") === "Studio/retro|Studio/standup");
  await page.keyboard.type("standup");
  await page.keyboard.press("Enter");
  if (await until(async () => (await held()).includes("What did you do?"), 10000)) pass("a prompt of the server that stopped is inserted"); else fail(`after the insertion the box holds ${JSON.stringify(await held())}`);
  await libBtn.click();
  await row("retro").click();
  await B.launch();
  await shows("the server is back: its prompt can be changed again", (x) => !x.off.length && x.form?.name === "retro" && x.form.fixed === false);
  await text.fill("Saved after it came back."); await button("Save").click();
  if (await until(async () => (await libraryOf(host, entry)).prompts.some((p) => p.text === "Saved after it came back."), 20000)) pass("a save after it came back reaches it"); else fail("the save after the server came back did not reach it");

  // ---- removed from the list
  await hostApp(host, "servers.remove", { id: entry });
  await shows("removed from the list, the server takes its prompts with it, and the tree has no level of servers", (x) => x.rows.join("|") === ["git", "  " + LONG, "  review twice"].join("|") && !x.form);
  for (const e of errors) fail(`page error: ${e}`);
  // (the page's stream keeps this computer's server connected to the host while it is open: another subscriber takes its place, as a page of the phone will)
  const keep = await client(host);
  await ctx.close();

  // ======== the same on the phone
  await phonePass({ ofA, dist });
  keep.close();
  ofA.close();
} catch (e) { fail(String(e?.stack ?? e)); }
await tidy();
console.log(failures.length ? `\n${failures.length} failed` : "\nthe prompt library's popups work on real servers, in the new build");
process.exit(failures.length ? 1 : 0);
