// Proves A1.4, its browser part: ⌘B (Ctrl+B off macOS) hides and shows the sidebar and reaches nothing else. With the keys in a
// board's stage, no listener of the document hears its keydown, which is where Excalidraw listens; the browser's own action is
// cancelled, and a key held down toggles once. Under a dialog (the confirm dialog, the Servers dialog, the chat's tree) it does
// nothing and is left alone, shown or hidden; ⌘⇧B is still the tree's and toggles no sidebar. That the desktop app's menu does not
// take ⌘B is checked by hand.
// Ports dev/checks/A1.4-key.mjs (U3) to the new build, at desktop and tablet (a tablet with a hardware keyboard has the shortcuts,
// AD-73; the keys come through the keys port, which on web is the window's own capture listener, so the check is the old one's).
// Deviations: ⌘N is also held to do nothing under a dialog (A-DL-05), and the confirm dialog is also the one a refused "New chat" shows, which
// the hidden sidebar can still make (the Delete menu of a row is in the sidebar). The canvas: the three shapes of `b_ui` stay selected through
// ⌘B and the document of the page hears nothing there (Excalidraw is in the page itself on the web build, listening on the document). The
// box with "abc" in it keeps its text, its caret and the focus through ⌘B and hears no keydown of it. ⌘⇧B opens the chat's tree
// (`tree-popup`) and ⌘B does nothing under it, shown or hidden; it is also the tree's to close.
import { check, seed, until } from "../shot.mjs";
import { act, byTid, IDS, press } from "./sel.mjs";
import { sideMenu } from "./side.mjs";

export const viewports = ["desktop", "tablet"];

const tid = (id) => `[data-testid="${id}"]`;

await check("A1.4 ⌘B reaches neither the canvas nor the composer, and does nothing under a dialog", async ({ url, open, fail, note }) => {
  await seed(url, "A1");
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const side = (page) => page.evaluate(() => ({ hidden: document.querySelector('[data-testid="app"]').dataset.side === "hidden", saved: localStorage.getItem("aiwb.side") }));
  const isHidden = async (page) => (await side(page)).hidden;
  /** Every keydown from now on, as three listeners hear it: the window first (after the page's own listener there,
   *  so it knows whether that one cancelled it), the document, and the element `at`. */
  const listen = (page, at) => page.evaluate((at) => {
    const heard = (window.__keys = { window: [], document: [], at: [] });
    const say = (e) => `${e.metaKey ? "⌘" : ""}${e.ctrlKey ? "⌃" : ""}${e.shiftKey ? "⇧" : ""}${e.code}${e.repeat ? " repeat" : ""}${e.defaultPrevented ? " cancelled" : ""}`;
    window.addEventListener("keydown", (e) => heard.window.push(say(e)), true);
    for (const capture of [true, false]) document.addEventListener("keydown", (e) => heard.document.push(say(e)), capture);
    if (at) document.querySelector(at).addEventListener("keydown", (e) => heard.at.push(say(e)));
  }, at);
  /** What they heard since the last call. */
  const heard = (page) => page.evaluate(() => { const k = window.__keys, was = { window: k.window, document: k.document, at: k.at }; Object.assign(k, { window: [], document: [], at: [] }); return was; });
  const B = (list) => list.filter((k) => k.includes("KeyB"));
  const run = async (o, body) => { const { ctx, page } = await open({ wait: tid("app"), ...o }); try { await body(page); } finally { await ctx.close(); } };
  /** ⌘B while `dialog` is open: the sidebar stays as it is, nothing is saved, the keydown is not cancelled. */
  const underOf = (page) => async (name, dialog) => {
    if (!await until(() => page.locator(dialog).isVisible(), 10000)) return fail(`${name}: it did not open`);
    const before = await side(page);
    await heard(page);
    await page.keyboard.press("ControlOrMeta+b");
    await frames(page);
    const after = await side(page), k = await heard(page);
    if (after.hidden !== before.hidden || after.saved !== before.saved) fail(`${name}: ⌘B under it ${after.hidden ? "hid" : "showed"} the sidebar (saved: ${JSON.stringify(after.saved)})`);
    if (B(k.window).length !== 1 || B(k.window)[0].includes("cancelled")) fail(`${name}: ⌘B under it was heard as ${JSON.stringify(B(k.window))}: not one keydown, left alone`);
    const calls = await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("path=%2Fapi%2Fchats")).length);
    await heard(page);
    await page.keyboard.press("ControlOrMeta+n");
    await frames(page);
    const k2 = await heard(page);
    if (k2.window.some((x) => x.includes("KeyN") && x.includes("cancelled"))) fail(`${name}: ⌘N under it was taken (heard as ${JSON.stringify(k2.window)}): it is left alone`);
    if (await page.evaluate(() => performance.getEntriesByType("resource").filter((r) => r.name.includes("path=%2Fapi%2Fchats")).length) !== calls) fail(`${name}: ⌘N under it asked the server for a chat`);
    if (!await page.locator(dialog).isVisible()) fail(`${name}: ⌘B closed it`);
    await page.keyboard.press("Escape");
    if (!await until(async () => await page.locator(dialog).count() === 0, 10000)) fail(`${name}: Esc did not close it`);
  };
  /** One press of the key that must toggle: the sidebar is then `want`, and the keydown went no further than the window. */
  const toggle = async (page, name, want, hasAt) => {
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => await isHidden(page) === want, 10000)) fail(`${name}: ⌘B did not ${want ? "hide" : "show"} the sidebar`);
    const k = await heard(page);
    if (B(k.window).length !== 1 || !B(k.window)[0].endsWith("cancelled")) fail(`${name}: the window heard ${JSON.stringify(B(k.window))} for one ⌘B: not one keydown, cancelled`);
    if (B(k.document).length) fail(`${name}: the document heard ⌘B (${B(k.document).join(", ")}): the canvas listens there`);
    if (hasAt && B(k.at).length) fail(`${name}: the element with the focus heard ⌘B (${B(k.at).join(", ")})`);
  };

  // ---- the canvas of a board this window may edit, its three shapes selected
  await run({ sel: { board: "b_ui" } }, async (page) => {
    await byTid(page, "board-canvas", { state: "ready" }).first().waitFor({ state: "attached", timeout: 20000 }); // (a select-all before the scene is drawn selects nothing)
    await act(page, "select");
    // (the shapes are selected when Excalidraw draws the panel of their properties, or, in its narrow layout, shows the bottom bar's Edit button, which is
    // hidden while nothing is selected; the hidden sidebar widens the stage to the wide layout, which has the panel)
    const picked = page.locator('.excalidraw .selected-shape-actions, .excalidraw button[aria-label="Edit"]:not([class*="--hide"])');
    if (!await until(() => picked.count(), 10000)) return fail("the canvas: the shapes are not selected before the key is pressed: the check would not see them lost");
    await listen(page);
    await page.keyboard.press("Shift");
    const first = await heard(page);
    if (!first.document.some((k) => k.includes("Shift"))) return fail(`the canvas: a key pressed there is not heard at the document (${JSON.stringify(first)}): the check would hear no ⌘B either`);
    await toggle(page, "the canvas", true);
    await toggle(page, "the canvas, hidden", false);
    await toggle(page, "the canvas, again", true);
    await frames(page);
    if (!await picked.count()) fail("the canvas: the shapes are no longer selected after ⌘B");
    // a key held down: the keydowns that repeat toggle nothing
    await page.keyboard.down("ControlOrMeta");
    for (let i = 0; i < 4; i++) await page.keyboard.down("b");
    await page.keyboard.up("b"); await page.keyboard.up("ControlOrMeta");
    await frames(page);
    const held = await heard(page);
    if (B(held.window).length !== 4 || B(held.window).filter((k) => k.includes("repeat")).length !== 3) fail(`the canvas: four keydowns of a held ⌘B were heard as ${JSON.stringify(B(held.window))}`);
    if (await isHidden(page)) fail("the canvas: ⌘B held down toggled the sidebar more than once");
    if (B(held.document).length) fail(`the canvas: the document heard a repeated ⌘B (${B(held.document).join(", ")})`);
    note(`the canvas, three shapes selected: ⌘B hid and showed the sidebar, cancelled, and the document heard no keydown of it`);
  });

  // ---- the stage of a board: the key reaches the window and goes no further
  await run({ sel: { board: "b_arch" } }, async (page) => {
    await page.waitForSelector(tid("board-stage"));
    await listen(page);
    await page.keyboard.press("Shift");
    const first = await heard(page);
    if (!first.document.some((k) => k.includes("Shift"))) return fail(`the stage: a key pressed there is not heard at the document (${JSON.stringify(first)}): the check would hear no ⌘B either`);
    await toggle(page, "the stage", true);
    await toggle(page, "the stage, hidden", false);
    await toggle(page, "the stage, again", true);
    await frames(page);
    // a key held down: the keydowns that repeat toggle nothing
    await page.keyboard.down("ControlOrMeta");
    for (let i = 0; i < 4; i++) await page.keyboard.down("b");
    await page.keyboard.up("b"); await page.keyboard.up("ControlOrMeta");
    await frames(page);
    const held = await heard(page);
    if (B(held.window).length !== 4 || B(held.window).filter((k) => k.includes("repeat")).length !== 3) fail(`the stage: four keydowns of a held ⌘B were heard as ${JSON.stringify(B(held.window))}`);
    if (await isHidden(page)) fail("the stage: ⌘B held down toggled the sidebar more than once");
    if (B(held.document).length) fail(`the stage: the document heard a repeated ⌘B (${B(held.document).join(", ")})`);
    note("the stage: ⌘B hid and showed the sidebar, cancelled, and the document heard no keydown of it");
  });

  // ---- the composer's box
  await run({ sel: { chat: "c_plain" } }, async (page) => {
    const box = page.locator(`${tid("chat-page")} ${tid("composer-input")}`);
    await box.click();
    await page.keyboard.type("abc");
    await listen(page, `${tid("chat-page")} ${tid("composer-input")}`);
    const state = () => box.evaluate((b) => ({ text: b.textContent, html: b.innerHTML, focus: document.activeElement === b, caret: getSelection().rangeCount ? getSelection().getRangeAt(0).endOffset : -1 }));
    for (const [name, want] of [["the composer", true], ["the composer, hidden", false]]) {
      await toggle(page, name, want, true);
      await frames(page);
      const s = await state();
      if (s.text !== "abc" || /<(b|strong)\b/i.test(s.html)) fail(`${name}: after ⌘B the box holds ${JSON.stringify(s.html)}`);
      if (!s.focus || s.caret !== 3) fail(`${name}: after ⌘B the box ${s.focus ? "has" : "has lost"} the focus, its caret at ${s.caret}`);
    }
    await page.keyboard.type("d");
    if (!await until(async () => (await state()).text === "abcd", 5000)) fail(`the composer: typing on after ⌘B gave ${JSON.stringify((await state()).text)}, not "abcd"`);
    note("the composer's box: ⌘B hid and showed the sidebar; the box heard no keydown of it and kept its text, its caret and the focus");
  });

  // ---- under the dialogs of the sidebar (the old check's): the confirm dialog of the open chat's Delete, and the Servers dialog
  await run({ sel: { chat: "c_plain" } }, async (page) => {
    await listen(page);
    const under = underOf(page);
    await sideMenu(page, byTid(page, IDS.row, { kind: "chat", key: "c_plain" }).first(), "More", "Delete");
    await under("the confirm dialog of Delete", tid("confirm-dialog"));
    await press(page, byTid(page, "servers-btn").first());
    await under("the Servers dialog of the sidebar's foot", tid("servers-dialog"));
    note("under the confirm dialog of a chat's Delete and the Servers dialog ⌘B and ⌘N did nothing and were not cancelled");
  });

  // ---- under a dialog, shown or hidden sidebar: nothing, and the key is left alone. The dialog is the one a refused "New chat" shows.
  await run({ sel: {} }, async (page) => {
    await listen(page);
    await page.route((u) => u.pathname === "/host/call" && u.searchParams.get("method") === "POST" && u.searchParams.get("path") === "/api/chats",
      (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "A chat cannot be made now", code: "busy" }) }));
    const under = underOf(page);
    await press(page, byTid(page, "home-new-chat").first());
    await under("the confirm dialog", tid("confirm-dialog"));
    await press(page, byTid(page, "servers-btn").first());
    await under("the Servers dialog", tid("servers-dialog"));

    await page.keyboard.press("ControlOrMeta+Shift+b");
    if ((await side(page)).saved !== null) fail(`⌘⇧B saved the sidebar as ${JSON.stringify((await side(page)).saved)}: it is the tree's key`);
    if ((await side(page)).hidden) fail("⌘⇧B hid the sidebar: it is the tree's key");
    await heard(page);

    // the same with the sidebar hidden: it stays hidden
    await toggle(page, "after the dialog", true);
    await press(page, byTid(page, "home-new-chat").first());
    await under("the confirm dialog, sidebar hidden", tid("confirm-dialog"));
    if (!await isHidden(page)) fail("the dialog showed the hidden sidebar");
    await toggle(page, "after the dialog, hidden", false);
    note("under the confirm dialog and the Servers dialog ⌘B and ⌘N did nothing and were not cancelled; ⌘⇧B toggled nothing");
  });

  // ---- under the chat's tree: the same, and ⌘⇧B is what opens it (and closes it)
  await run({ sel: { chat: "c_plain" } }, async (page) => {
    await listen(page);
    const under = underOf(page);
    await page.keyboard.press("ControlOrMeta+Shift+b");
    if ((await side(page)).saved !== null) fail(`⌘⇧B saved the sidebar as ${JSON.stringify((await side(page)).saved)}: it is the tree's key`);
    await under("the chat's tree", tid("tree-popup"));
    // the same with the sidebar hidden: it stays hidden
    await toggle(page, "after the tree", true);
    await page.keyboard.press("ControlOrMeta+Shift+b");
    await under("the chat's tree, sidebar hidden", tid("tree-popup"));
    if (!await isHidden(page)) fail("the tree showed the hidden sidebar");
    await toggle(page, "after the tree, hidden", false);
    // ⌘⇧B toggles it: a second press closes it
    await page.keyboard.press("ControlOrMeta+Shift+b");
    if (!await until(() => page.locator(tid("tree-popup")).isVisible(), 10000)) fail("⌘⇧B did not open the tree again");
    await page.keyboard.press("ControlOrMeta+Shift+b");
    if (!await until(async () => await page.locator(tid("tree-popup")).count() === 0, 10000)) fail("⌘⇧B did not close the tree it opened");
    note("under the chat's tree ⌘B and ⌘N did nothing and were not cancelled; ⌘⇧B opened it and closed it, and toggled no sidebar");
  });
}, { viewports, page: false });
