// UX.F2-stack (package F2, ux-improvements): the phone's stack is derived from the store, whichever way a screen was reached
// (plans/ux-improvements/f2-design.md; PLAN §2 F2 "Checks"). On the phone, through the seam of a uicheck build (`window.__aiwbStack`: the
// entries, `goBack` (what the system's back calls), `select` (what a search result, a notification or a row does), `pushGroup`, `push`
// of the two stand-in screens `uicheck-place` and `uicheck-content`) and the controls themselves:
//   from a row     Home › a group (pushGroup) › its board (a `home-row` press): the stack is home, group, board; the board's back has no
//                  label (content), the group's is "Home" (place), and each back lands on the screen under it; `aiwb.home` follows
//   from a result  `select` of a board of a group with Home at its root: the same stack as from a row, and the back lands on the group
//                  first, then Home; a board of a nested group has both groups under it
//   from a chat    a board's chat selected: home, group, board, chat; the back clears the chat and keeps the board, then the group
//   labels         a place screen pushed over a chat names the chat in its back, a content screen over it has none
//   hold           holding the back on a deep stack opens the stack sheet (title "Go back to", a row for each screen up to its own); a pick
//                  pops to it at once
//   over a chat    a screen pushed over a chat and gone leaves that same chat page, not a new one
//   system back    `goBack()` does what the button does
//   select         other content selected while screens are pushed takes them away; the same content leaves them
// On the wide layouts the phone's stack is not drawn: no pushed screen, no back control; only that is asserted there.
import { check, mockEval, until } from "../shot.mjs";
import { IDS, byTid, layoutNow, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const WAIT = 15000;
const J = JSON.stringify;

const SHOP = "g_shop", DEEP = "g_deep";

await check("UX.F2-stack the phone's stack: the same entries by any way in, back to the place first, the hold sheet", async ({ url, layout, page, fail, note }) => {
  const stack = {
    entries: () => page.evaluate(() => window.__aiwbStack.entries()),
    keys: async () => (await stack.entries()).map((e) => e.key),
    call: (fn, ...args) => page.evaluate(({ fn, args }) => window.__aiwbStack[fn](...args), { fn, args }),
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const saved = (k) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), k);
  const shows = (id, data) => byTid(page, id, data).last().isVisible().catch(() => false); // (last: the screen on top is the last drawn)
  /** Waits for the stack's keys to be exactly `want`; fails with what they are. */
  const keysAre = async (what, want) => {
    const ok = await until(async () => same(await stack.keys(), want), WAIT);
    if (!ok) fail(`${what}: the stack is [${(await stack.keys()).join(", ")}], not [${want.join(", ")}]`);
    return ok;
  };
  /** Waits for a testID to be drawn on top (or gone, with `on` false). */
  const screenIs = async (what, id, data, on = true) => {
    const ok = await until(async () => (await shows(id, data)) === on, WAIT);
    if (!ok) fail(`${what}: ${id}${data ? " " + J(data) : ""} is ${on ? "not drawn" : "still drawn"}`);
    return ok;
  };
  /** The back control on top: its accessible name and the text it draws. */
  const backOf = async () => {
    const b = byTid(page, IDS.back).last();
    if (!(await b.isVisible().catch(() => false))) return null;
    return { name: await b.getAttribute("aria-label"), text: (await b.innerText()).trim() };
  };
  const backIs = async (what, name) => {
    const ok = await until(async () => { const b = await backOf(); return name === null ? b === null : b?.name === name && b.text === (name === "Back" ? "" : name.replace(/^Back to /, "")); }, WAIT);
    if (!ok) fail(`${what}: the back control is ${J(await backOf())}, not ${name === null ? "absent" : J(name)}`);
    return ok;
  };
  const back = async () => press(page, byTid(page, IDS.back).last());
  /** A finger held on the back control for `ms`, then taken off the way the system does when a screen opens under it (a cancel): a
   *  release (`longPress` of sel.mjs) makes the browser press where the finger was, which is now the sheet's backdrop. */
  const hold = async (ms = 800) => {
    const b = byTid(page, IDS.back).last();
    const box = await b.boundingBox();
    if (!box) throw new Error("the back control is not drawn to hold");
    const c = await page.context().newCDPSession(page);
    const at = [{ x: box.x + Math.min(30, box.width / 2), y: box.y + box.height / 2, id: 1 }];
    await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at });
    await page.waitForTimeout(ms);
    await byTid(page, "stack-sheet").last().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
    await c.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await c.detach();
  };

  if (layout !== "phone") {
    // the wide layouts keep their split view: nothing of the phone's stack is drawn, a pushed stand-in screen included
    if (!(await page.evaluate(() => !!window.__aiwbStack))) return fail("the uicheck build has no seam (window.__aiwbStack)");
    if (layoutNow(page) === "phone") return fail("a wide viewport is the phone layout");
    await stack.call("push", "uicheck-place", { title: "Wide" });
    await page.waitForTimeout(300);
    if (await byTid(page, "pushed-screen").count()) fail("a wide layout draws a pushed screen of the phone's stack");
    if (await byTid(page, IDS.back).count()) fail("a wide layout draws a back control");
    if (!(await byTid(page, "app").count())) fail("the wide layout does not draw the split view");
    note("the wide layout is the split view: no pushed screen, no back control");
    return;
  }

  // ---- the mock's world: Shop (g_shop) holds the board b_arch and the plain chats; a group inside it with a board of its own
  await mockEval(`
    groups.push({ id: ${J(DEEP)}, name: "Deep", parent: ${J(SHOP)} });
    boards.b_deep = { id: "b_deep", name: "deep board", group: ${J(DEEP)}, created: iso(T0 - 4000 * MIN) };
    send({ type: "snapshot", ...snapshot() });`, url);
  await byTid(page, "home").first().waitFor({ state: "visible", timeout: WAIT });
  await keysAre("on a fresh start", ["home"]);
  if (await byTid(page, "pushed-screen").count()) fail("a fresh start draws a pushed screen");
  if (await backOf()) fail("Home has a back control");

  // ---- 1. from a row
  await stack.call("pushGroup", SHOP);
  await keysAre("a group pushed from Home", ["home", `group:${SHOP}`]);
  await screenIs("the group screen", "home-row", { kind: "board", key: "b_arch" });
  await backIs("the group's back", "Back to Home");
  if (!(await until(async () => (await saved("aiwb.home"))?.groups?.[0] === SHOP, WAIT))) fail(`the saved Home place is ${J(await saved("aiwb.home"))} with the group browsed`);
  await press(page, byTid(page, "home-row", { kind: "board", key: "b_arch" }).last());
  await keysAre("a board opened from the group's row", ["home", `group:${SHOP}`, "board:b_arch"]);
  await screenIs("the board", IDS.boardBar);
  await backIs("the board's back", "Back");
  if ((await saved("aiwb.sel"))?.board !== "b_arch") fail(`the board opened from a row is saved as ${J(await saved("aiwb.sel"))}`);
  await back();
  await keysAre("back from the board", ["home", `group:${SHOP}`]);
  await screenIs("the group screen after the back", "home-row", { kind: "board", key: "b_arch" });
  await backIs("the group's back after the back from its board", "Back to Home");
  const sel1 = await saved("aiwb.sel");
  if (sel1?.board || sel1?.chat) fail(`after the back from the board the saved selection is ${J(sel1)}, not none`);
  if ((await saved("aiwb.home"))?.groups?.[0] !== SHOP) fail(`the group browsed is not kept after the back from its board: ${J(await saved("aiwb.home"))}`);
  await back();
  await keysAre("back from the group", ["home"]);
  await screenIs("Home after the back", "home");
  await backIs("Home's back", null);
  if (!(await until(async () => ((await saved("aiwb.home"))?.groups ?? ["?"]).length === 0, WAIT))) fail(`the saved Home place is ${J(await saved("aiwb.home"))} after the back to Home`);
  note("from a row: home › group › board; each back lands on the screen under it; Home's place is saved");

  // ---- 2. from a search result: Home at its root, the board selected
  await stack.call("select", { board: "b_arch", chat: null });
  await keysAre("a board selected from Home", ["home", `group:${SHOP}`, "board:b_arch"]);
  await screenIs("the board selected from Home", IDS.boardBar);
  await backIs("the board's back (selected)", "Back");
  await back();
  await keysAre("back from the selected board", ["home", `group:${SHOP}`]);
  await backIs("the group's back (selected)", "Back to Home");
  await back();
  await keysAre("back from the group of the selected board", ["home"]);
  await screenIs("Home after the selected board", "home");
  // a board of a group inside a group: both are under it, the inner one's back names the outer
  await stack.call("pushGroup", SHOP);
  await screenIs("the group Shop", "home-row", { kind: "group", key: DEEP });
  await press(page, byTid(page, "home-row", { kind: "group", key: DEEP }).last());
  await keysAre("a group pushed from a group row", ["home", `group:${SHOP}`, `group:${DEEP}`]);
  await backIs("the inner group's back", `Back to Shop`);
  await back();
  await keysAre("back from the inner group", ["home", `group:${SHOP}`]);
  await back();
  await keysAre("back to Home before the nested select", ["home"]);
  await stack.call("select", { board: "b_deep", chat: null });
  await keysAre("a board of a nested group selected from Home", ["home", `group:${SHOP}`, `group:${DEEP}`, "board:b_deep"]);
  await back();
  await keysAre("back from the nested board", ["home", `group:${SHOP}`, `group:${DEEP}`]);
  await backIs("the inner group's back (selected)", "Back to Shop");
  await back();
  await back();
  await keysAre("back through the nested groups", ["home"]);
  note("from a result: the board's groups are under it, as from a row; the back lands on the group, then Home");

  // ---- 3. from a board's chat
  await stack.call("select", { board: "b_arch", chat: "c_board" });
  await keysAre("a board's chat selected", ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board"]);
  await screenIs("the chat", IDS.chatHead);
  await back();
  await keysAre("back from the board's chat", ["home", `group:${SHOP}`, "board:b_arch"]);
  await screenIs("the board after the chat's back", IDS.boardBar);
  const sel3 = await saved("aiwb.sel");
  if (sel3?.chat) fail(`after the back from the chat the saved selection is ${J(sel3)}: the chat is not cleared`);
  if (sel3?.board !== "b_arch") fail(`after the back from the chat the board is not kept: ${J(sel3)}`);
  await back();
  await keysAre("back from the board (its chat gone)", ["home", `group:${SHOP}`]);
  await back();
  await keysAre("back to Home from the group (its chat gone)", ["home"]);
  note("from a board's chat: home › group › board › chat; the back clears the chat and keeps the board, then the group");

  // ---- 4. the back's label comes from the entry under it, on a place screen only
  const chatTitle = "Why is the build slow";
  await stack.call("select", { board: null, chat: "c_plain" });
  await keysAre("a plain chat selected", ["home", `group:${SHOP}`, "chat:c_plain"]);
  await screenIs("the plain chat", "chat-page");
  await backIs("the chat's back", "Back");
  const chatKeys = await stack.keys();
  const chatMark = await page.evaluate(() => { const e = [...document.querySelectorAll('[data-testid="chat-page"]')].pop(); e.dataset.f2mark = "kept"; return !!e; });
  const place = await stack.call("push", "uicheck-place", { title: "A place" });
  await keysAre("a place screen pushed over the chat", [...chatKeys, place]);
  await screenIs("the place screen", "uicheck-screen");
  await backIs("a place screen's back over a chat", `Back to ${chatTitle}`);
  const content = await stack.call("push", "uicheck-content", { title: "A content screen" });
  await keysAre("a content screen pushed over the place", [...chatKeys, place, content]);
  await backIs("a content screen's back", "Back");
  await back();
  await keysAre("back from the content screen", [...chatKeys, place]);
  await backIs("the place screen's back after its content screen's", `Back to ${chatTitle}`);
  note("labels: a place screen names the entry under it (the chat), a content screen has none");

  // ---- 6. a screen pushed over a chat returns to that chat
  await back();
  await keysAre("back from the place screen", chatKeys);
  await screenIs("the chat page after the pushed screen", "chat-page");
  await screenIs("the pushed screen gone", "pushed-screen", undefined, false);
  if ((await saved("aiwb.sel"))?.chat !== "c_plain") fail(`the chat is not kept over a pushed screen: ${J(await saved("aiwb.sel"))}`);
  if (chatMark && !(await page.evaluate(() => [...document.querySelectorAll('[data-testid="chat-page"]')].some((e) => e.dataset.f2mark === "kept")))) fail("the chat page was drawn anew after a screen pushed over it was gone");
  await backIs("the chat's back after the pushed screen", "Back");

  // ---- 5. the hold sheet pops several levels
  await stack.call("select", { board: "b_arch", chat: "c_board" });
  await keysAre("a board's chat selected for the hold", ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board"]);
  const top = await stack.call("push", "uicheck-place", { title: "Deep place" });
  const deep = ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board", top];
  await keysAre("the deep stack", deep);
  await screenIs("the deep place screen", "uicheck-screen");
  await hold();
  const sheet = byTid(page, "stack-sheet").last();
  if (!(await sheet.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("holding the back control did not open the stack sheet");
  else {
    if (!(await sheet.innerText()).includes("Go back to")) fail(`the stack sheet's title is not "Go back to": ${J(await sheet.innerText())}`);
    const rows = await byTid(page, "picker-row").evaluateAll((els) => els.map((e) => e.dataset.value));
    if (!same(rows, deep)) fail(`the stack sheet lists [${rows.join(", ")}], not [${deep.join(", ")}]`);
    const text = await sheet.innerText();
    for (const title of ["Home", "Shop", "arch", "Draw the pipeline", "Deep place"]) if (!text.includes(title)) fail(`the stack sheet does not name "${title}": ${J(text)}`);
    await press(page, byTid(page, "picker-row", { value: `group:${SHOP}` }).last());
    await keysAre("a pick of the group in the stack sheet", ["home", `group:${SHOP}`]);
    if (!(await sheet.waitFor({ state: "hidden", timeout: WAIT }).then(() => true, () => false))) fail("the stack sheet stays open after a pick");
    await screenIs("the group after the pick", "home-row", { kind: "board", key: "b_arch" });
    await screenIs("the pushed screen after the pick", "pushed-screen", undefined, false);
    const sel5 = await saved("aiwb.sel");
    if (sel5?.board || sel5?.chat) fail(`after the pick of the group the saved selection is ${J(sel5)}, not none`);
    // the group screen's own hold: Home and itself; the pick of Home
    await hold();
    const sheet2 = byTid(page, "stack-sheet").last();
    if (!(await sheet2.waitFor({ state: "visible", timeout: WAIT }).then(() => true, () => false))) fail("holding the group's back control did not open the stack sheet");
    else {
      const rows2 = await byTid(page, "picker-row").evaluateAll((els) => els.map((e) => e.dataset.value));
      if (!same(rows2, ["home", `group:${SHOP}`])) fail(`the group's stack sheet lists [${rows2.join(", ")}]`);
      await press(page, byTid(page, "picker-row", { value: "home" }).last());
      await keysAre("a pick of Home in the stack sheet", ["home"]);
      await screenIs("Home after the pick", "home");
    }
  }
  note("hold: the stack sheet lists the stack up to the screen; a pick pops to it");

  // ---- 7. the system's back (Android) does what the button does
  await stack.call("select", { board: "b_arch", chat: "c_board" });
  await keysAre("a board's chat selected for the system's back", ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board"]);
  const sys = await stack.call("push", "uicheck-place", { title: "System" });
  await keysAre("a place screen over the board's chat", ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board", sys]);
  await page.evaluate(() => window.__aiwbStack.goBack());
  await keysAre("the system's back from the pushed screen", ["home", `group:${SHOP}`, "board:b_arch", "chat:c_board"]);
  await screenIs("the chat after the system's back", IDS.chatHead);
  await page.evaluate(() => window.__aiwbStack.goBack());
  await keysAre("the system's back from the chat", ["home", `group:${SHOP}`, "board:b_arch"]);
  await screenIs("the board after the system's back", IDS.boardBar);
  if ((await saved("aiwb.sel"))?.chat) fail(`the system's back from the chat saved ${J(await saved("aiwb.sel"))}: the chat is not cleared`);
  await page.evaluate(() => window.__aiwbStack.goBack());
  await keysAre("the system's back from the board", ["home", `group:${SHOP}`]);
  await screenIs("the group after the system's back", "home-row", { kind: "board", key: "b_arch" });
  await page.evaluate(() => window.__aiwbStack.goBack());
  await keysAre("the system's back from the group", ["home"]);
  await screenIs("Home after the system's back", "home");
  await page.evaluate(() => window.__aiwbStack.goBack()); // (nothing under Home: nothing happens)
  await page.waitForTimeout(300);
  await keysAre("the system's back on Home", ["home"]);
  note("the system's back is the button's: one level at a time, as far as Home, and nothing on Home");

  // ---- 8. other content selected while screens are pushed takes them away
  await stack.call("select", { board: null, chat: "c_plain" });
  await keysAre("a plain chat selected for the select check", ["home", `group:${SHOP}`, "chat:c_plain"]);
  const p1 = await stack.call("push", "uicheck-place", { title: "One" });
  const p2 = await stack.call("push", "uicheck-content", { title: "Two" });
  await keysAre("two screens pushed", ["home", `group:${SHOP}`, "chat:c_plain", p1, p2]);
  await stack.call("select", { board: null, chat: "c_plain" }); // (the same content: the screens stay)
  await page.waitForTimeout(300);
  await keysAre("the same chat selected again", ["home", `group:${SHOP}`, "chat:c_plain", p1, p2]);
  await stack.call("select", { board: "b_arch", chat: null });
  await keysAre("other content selected over pushed screens", ["home", `group:${SHOP}`, "board:b_arch"]);
  await screenIs("the board over no pushed screen", IDS.boardBar);
  await screenIs("the pushed screens gone", "pushed-screen", undefined, false);
  note("select of other content clears the pushed screens; the same content leaves them");
}, { viewports });
