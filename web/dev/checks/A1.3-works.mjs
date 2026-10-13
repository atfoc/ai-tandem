// Proves A1.3: with the sidebar hidden, what does not need it works as before. ⌘N makes a chat of this computer at
// once and opens it, also with other servers in the list: nothing asks where it should live. The "Servers…" of the
// warning over a chat whose server dropped opens the dialog, which the hidden sidebar's button still draws, and whose
// Escape leaves the chat under it; ⌘J hides the chat panel and
// shows it; the panel's resizer drags, and stops where the stage would get narrower than its least (it reads the
// stage as the child of .app). Home's "New whiteboard" makes a board of this computer and selects it at once, with no
// server but this computer and with others in the list, and when the sidebar is shown the board's row is there, lit, and not in rename mode;
// with the sidebar shown the same click puts the row in rename mode, so the check would see one. The same for a run
// and a group made from the sidebar's own "+" and answered only after the sidebar was hidden: no rename box that
// nobody sees waits in it.
import { check, dragResizer, mockEval, openPage, seed, until } from "../shot.mjs";

const SIDE = 264, PANEL = 400, HIDDEN = { "aiwb.side": "hidden" };

await check("A1.3 with the sidebar hidden the page works as before", async ({ url, browser, fail, note }) => {
  const frames = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => ok()))));
  const saved = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
  const width = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e && e.getClientRects().length ? e.getBoundingClientRect().width : null; }, sel);
  const railThere = (page) => page.evaluate(() => !!document.querySelector(".app > .side-rail") && !document.querySelector(".app > .side-pane").getClientRects().length);
  const open = async (o, body) => {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, errors, wait: ".app", ...o });
    try { await body(page); } finally { for (const e of errors) fail(`page error: ${e}`); await ctx.close(); }
  };
  const boardCount = () => mockEval("return Object.keys(boards).length;", url);

  /** Home's "New whiteboard": the board is made at once, on this computer, and nothing asks where it should live. The
   *  row is looked at with the sidebar shown: at once when it was never hidden, else after ⌘B. */
  const newBoard = async (name, { hidden }) => open({ sel: {}, ls: hidden ? HIDDEN : {} }, async (page) => {
    const before = await boardCount();
    await page.waitForSelector("main.home h2");
    if (await railThere(page) !== hidden) return fail(`${name}: the sidebar is ${hidden ? "shown" : "hidden"} when the page opens`);
    await page.locator("main.home button", { hasText: "New whiteboard" }).click();
    // the board is selected: its stage is on screen and the selection names it
    const board = await until(async () => (await page.locator(".app > main.board-stage").count()) && (await saved(page, "aiwb.sel"))?.board, 15000);
    if (!board) return fail(`${name}: no board was selected after "New whiteboard": the selection is ${JSON.stringify(await saved(page, "aiwb.sel"))}`);
    if (await boardCount() !== before + 1) fail(`${name}: the mock has ${await boardCount()} boards of this computer, ${before} before`);
    if (await page.locator("main.board-choice, .board-choice-box").count()) fail(`${name}: the page asks where the board should live`);
    if (String(board).includes("~")) fail(`${name}: the board selected is one of a section: ${board}`);
    await frames(page);
    if (hidden) {
      if (!await railThere(page)) fail(`${name}: making the board showed the sidebar`);
      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(async () => !await railThere(page) && await width(page, ".app > .side-pane"), 10000)) return fail(`${name}: ⌘B did not show the sidebar`);
    }
    const row = page.locator(".side-row.is-board.on");
    if (!await until(async () => await row.count() === 1, 10000)) return fail(`${name}: ${await row.count()} board rows are lit in the sidebar, not the new board's alone`);
    const editing = await until(() => page.locator(".side .name-input").count(), hidden ? 0 : 10000);
    if (hidden && editing) fail(`${name}: the new board's row is in rename mode when the sidebar is shown`);
    if (!hidden && !editing) fail(`${name}: with the sidebar shown the new board's row is not in rename mode: the check would not see one`);
    if (hidden && !(await row.locator(".side-name").textContent())?.trim()) fail(`${name}: the new board's row has no name`);
    return board;
  });

  // ---- nothing seeded: no server but this computer, and "New whiteboard" makes the board at once
  if (await mockEval("return !!extra.servers?.some((s) => !s.local);", url)) note("(a board with no other server: not run, this mock has other servers already)");
  else {
    await newBoard("a board with no other server, sidebar shown", { hidden: false });
    await newBoard("a board with no other server", { hidden: true });
  }

  // ---- with other servers in the list: the same, on this computer, and no server gets a board
  await seed(url, "A1");
  await newBoard("a board with other servers in the list, sidebar shown", { hidden: false });
  await newBoard("a board with other servers in the list", { hidden: true });
  if (await mockEval('return Object.keys(worlds).filter((id) => id !== "local").reduce((n, id) => n + Object.keys(worlds[id].boards).length, 0);', url)) fail('"New whiteboard" made a board on another server');

  // ---- made from the sidebar's "+", the answer held until the sidebar is hidden (hidden: false: it is not hidden)
  const heldNew = async (what, { hidden, item, path, made }) => open({ sel: {}, wait: ".side-tree" }, async (page) => {
    const name = `${what} answered ${hidden ? "after the sidebar was hidden" : "with the sidebar shown"}`;
    let release;
    const gate = new Promise((ok) => { release = ok; });
    const mine = (r) => r.method() === "POST" && new URL(r.url()).pathname === path;
    await page.route((u) => u.pathname === path, async (route) => { if (mine(route.request())) await gate; await route.continue(); });
    const before = await page.locator(made).count(), asked = page.waitForRequest(mine, { timeout: 15000 }), answered = page.waitForResponse((r) => mine(r.request()), { timeout: 30000 });
    await page.locator(".side-head .icon-btn.new").click();
    await page.locator(".side-head .menu .menu-item", { hasText: item }).click();
    await asked;
    if (hidden) {
      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(() => railThere(page), 10000)) { release(); return fail(`${name}: ⌘B did not hide the sidebar`); }
    }
    release();
    await answered;
    if (!await until(async () => await page.locator(made).count() === before + 1, 15000)) return fail(`${name}: the sidebar has ${await page.locator(made).count()} of ${made}, ${before} before`);
    await frames(page);
    if (hidden) {
      await page.keyboard.press("ControlOrMeta+b");
      if (!await until(async () => !await railThere(page) && await width(page, ".app > .side-pane"), 10000)) return fail(`${name}: ⌘B did not show the sidebar`);
      await frames(page);
      if (await page.locator(".side .name-input").count()) fail(`${name}: its row is in rename mode when the sidebar is shown`);
    } else if (!await until(() => page.locator(".side .name-input").count(), 10000)) fail(`${name}: its row is not in rename mode: the check would not see one`);
  });
  for (const hidden of [false, true]) {
    await heldNew("a run", { hidden, item: "New run", path: "/api/runs", made: ".side-row.is-run" });
    await heldNew("a group", { hidden, item: "New group", path: "/api/groups", made: ".side-group-head" });
  }

  // ---- ⌘N: a chat of this computer, at once, with other servers in the list
  await open({ sel: { chat: "c_plain" }, ls: HIDDEN }, async (page) => {
    await page.waitForSelector(".chat-page .composer-box");
    const before = await mockEval("return Object.keys(chats).length;", url);
    await page.keyboard.press("ControlOrMeta+n");
    const chat = await until(async () => { const c = (await saved(page, "aiwb.sel"))?.chat; return c && c !== "c_plain" ? c : null; }, 15000);
    if (!chat) return fail(`⌘N: no new chat was opened: the selection is ${JSON.stringify(await saved(page, "aiwb.sel"))}`);
    if (await page.locator("main.board-choice, .board-choice-box").count()) fail("⌘N asks where the chat should live");
    if (String(chat).includes("~") || await mockEval("return Object.keys(chats).length;", url) !== before + 1) fail(`⌘N: the new chat is ${chat}, and this computer has ${await mockEval("return Object.keys(chats).length;", url)} chats, ${before} before`);
    if (!await railThere(page)) fail("the new chat showed the sidebar");
    note(`⌘N made ${chat} on this computer and opened it, with other servers in the list and no question`);
  });

  // ---- the "Servers…" of the warning over a chat whose server dropped: the dialog the hidden sidebar's button draws
  await mockEval('onServer("s_lab", () => { chats.c_A1_lab = chat("c_A1_lab", { name: "On the lab box", group: "__ungrouped__" }); items.c_A1_lab = [{ kind: "user", text: "Is the GPU free?" }, say("It is."), { kind: "end" }]; }); send({ type: "snapshot", ...snapshot() });', url);
  await open({ sel: { chat: "s_lab~c_A1_lab" }, ls: HIDDEN }, async (page) => {
    await page.waitForSelector(".chat-page .thread .msg.user");
    await mockEval('setServerState("s_lab", "unreachable", { detail: "connection refused" });', url);
    const bar = page.locator(".chat-page .remote-bar.off");
    if (!await until(() => bar.count(), 10000)) return fail("the chat whose server dropped shows no warning");
    await bar.locator("button", { hasText: "Servers…" }).click();
    const dialog = page.locator('.servers-dialog[role="dialog"]');
    if (!await until(() => dialog.isVisible(), 10000)) return fail('the warning\'s "Servers…" opened no dialog');
    const hit = await dialog.evaluate((d) => { const r = d.getBoundingClientRect(); return r.width > 200 && r.height > 100 && d.contains(document.elementFromPoint(r.left + r.width / 2, r.top + 20)); });
    if (!hit) fail("the Servers dialog is not what is at its own place on screen");
    if (await dialog.locator("text=Office Mac").count() < 1) fail("the Servers dialog does not list the seeded servers");
    await page.keyboard.press("Escape");
    if (!await until(async () => await dialog.count() === 0, 10000)) fail("Esc did not close the Servers dialog");
    if (!await railThere(page)) fail("the Servers dialog showed the sidebar");
    if (!await bar.count() || !await page.locator(".chat-page .thread .msg.user").count()) fail("the dialog's Escape dropped the chat under it");
    await mockEval('setServerState("s_lab", "connected");', url);
    note('the "Servers…" of a dropped server\'s warning opened the dialog with the sidebar hidden, and Esc left the chat');
  });

  // ---- ⌘J and the panel's resizer, in a window where the stage's least is what stops the drag
  await open({ sel: { board: "b_arch", chat: "c_board" }, size: [1000, 700], ls: { ...HIDDEN, "aiwb.widths": JSON.stringify({ side: SIDE, panel: PANEL }) } }, async (page) => {
    await page.waitForSelector(".board-panel .composer-box");
    const rail = await width(page, ".app > .side-rail"), win = 1000;
    if (!rail) return fail("the panel: the page opened with no rail");
    const sizes = async () => ({ panel: await width(page, ".app > .board-panel"), stage: await width(page, ".app > main") });
    let s = await sizes();
    if (s.panel !== PANEL || Math.abs(rail + s.panel + s.stage - win) > 0.5) fail(`the panel is ${s.panel} px and the stage ${s.stage} px beside a rail of ${rail} px in a window of ${win}`);

    await page.keyboard.press("ControlOrMeta+j");
    if (!await until(async () => await width(page, ".app > .board-panel") === null, 10000)) fail("⌘J did not hide the chat panel");
    s = await sizes();
    if (Math.abs(rail + s.stage - win) > 0.5) fail(`with the panel hidden the stage is ${s.stage} px beside a rail of ${rail} px in a window of ${win}`);
    await page.keyboard.press("ControlOrMeta+j");
    if (!await until(async () => await width(page, ".app > .board-panel") === PANEL, 10000)) fail(`⌘J did not show the chat panel again at ${PANEL} px`);

    await dragResizer(page, ".board-panel .resizer", 80);
    if (!await until(async () => (await sizes()).panel === PANEL + 80, 5000)) fail(`a drag of the resizer by 80 px left the panel at ${(await sizes()).panel} px, not ${PANEL + 80}`);
    let w = await saved(page, "aiwb.widths");
    if (w?.panel !== PANEL + 80 || w?.side !== SIDE) fail(`after the drag the saved widths are ${JSON.stringify(w)}`);
    // (the room is the panel and the stage less the stage's least, 320 px: here under the panel's own most, 760)
    const most = win - rail - 320;
    await dragResizer(page, ".board-panel .resizer", 400, 20);
    if (!await until(async () => (await sizes()).panel === most, 5000)) fail(`a drag far to the right left the panel at ${(await sizes()).panel} px: the stage's least gives it ${most}`);
    s = await sizes();
    if (Math.abs(s.stage - 320) > 0.5) fail(`after the drag far to the right the stage is ${s.stage} px, not its least, 320`);
    w = await saved(page, "aiwb.widths");
    if (w?.panel !== most || w?.side !== SIDE) fail(`after the second drag the saved widths are ${JSON.stringify(w)}`);
    if (!await railThere(page)) fail("⌘J or the resizer showed the sidebar");

    // shown again, the sidebar has its saved width, and the panel keeps what it was dragged to
    await page.keyboard.press("ControlOrMeta+b");
    if (!await until(async () => await width(page, ".app > .side-pane") === SIDE, 10000)) fail(`shown again the sidebar is ${await width(page, ".app > .side-pane")} px wide, not its saved ${SIDE}`);
    if ((await sizes()).panel !== most) fail(`shown again the sidebar changed the panel to ${(await sizes()).panel} px`);
    note(`⌘J hid and showed the panel; its resizer dragged it from ${PANEL} to ${PANEL + 80} px and no further than ${most}, the stage at 320`);
  });
});
