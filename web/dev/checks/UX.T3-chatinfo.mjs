// UX.T3-chatinfo (package T3 of ux-improvements, plans/ux-improvements/PLAN.md §3 T3; goal 3.5): Chat info and what it opens, on the phone — Context and
// usage, the chat tree as a sheet, the images' viewer, an archived chat and a chat whose server is away — on the chats of the mock's section UXT3
// (dev/mock-ui.js: c_UXT3_chat "Fix the flaky cart test" with a context split, two branches, a label and a first message of two images;
// c_UXT3_arch "Old refund spike", archived; c_UXT3_remote "Check the staging deploy" on the server s_uxt3 "Design Mac", with a permission request that
// waits). On the phone, in the light and the dark theme, it asserts:
//   info       the title and the ⋯ of the header open `chat-info` (head: the chat's title and "Chat info · started today at HH:MM"); its rows in order
//              name, agent, folder, server, context, tree, archive, delete; Rename (shown) opens the name field; "Locked" and the note "Fixed after the
//              first message. Fork the chat to try another model."; the whole folder path (not cut) and Copy, which puts it on the clipboard and
//              toasts "Folder path copied"; the Server row's state word is the one the server's state is, and the row opens the server's detail
//   usage      Context closes the sheet and opens `usage-sheet` (title "Context and usage", the sub naming the chat and the agent, the big number 36 %,
//              legend rows of at least 38 pt, Messages expanding to its parts), and a plan limit from 80 % is amber (`usage-row` tone warn)
//   tree       Chat tree opens `tree-popup` (Done 44 pt, the filter 32 pt, the search 44 pt, rows 48 pt, one "You are here", "Labeled · 1" for the
//              seeded label); a hold on a row opens its P1 (`fk-row-sheet`) with the tree not drawn under it; Label… opens the form (`fk-label-form`,
//              the tree not drawn); Save sends the label and the tree comes back with its tag
//   archive    Archive closes the sheet and toasts "Chat archived" with Undo (44 pt); Undo unarchives, and the chat is not archived again
//   delete     Delete chat… opens the P4 `confirm-sheet` titled for the chat with "Delete chat" and Cancel; Cancel deletes nothing (no call, the chat stays)
//   archived   the archived chat's Chat info offers Unarchive; Rename is faded, disabled, and says "Unarchive the chat to rename it."; its header
//              sub-line starts "Archived"
//   offline    the remote chat, its server down: no `remote-bar`, the thread not dimmed (opacity 1), Chat info's Rename, Archive and Delete disabled
//              with "Design Mac is offline: you can do this when it is back.", the Server row live with the word "unreachable" and opening the
//              server's detail; the server back: the toast "Design Mac is back online"
//   images     the thumbnails are 116 × 140; the viewer is black, with the name, "Image 1 of 2 · your message", the dots, Share, Save and Ask about it
//              (44 pt) and no prev/next; a swipe changes the image; Ask about it puts the image in the composer and closes the viewer
//   pill       the branch pill under the message at the split ("Branch 1 of 2"): › switches the branch in place, ‹ brings it back and the middle opens the tree
// Every touch target it presses is at least 44 pt (the legend rows 38; the pill's parts are 36 high and reach 44 by a hit slop that is native only) and every text it reads at least 13 pt.
// On the tablet and the desktop only that the phone's parts are absent: `chat-info`, `usage-sheet`, `fk-done`, `image-large-dots` and `chat-more`
// never appear (the title still renames in place, the tree and the viewer are the wide ones): the wide layouts are unchanged.
//
// Run: `cd web && npm run uicheck -- UX.T3-chatinfo`, or alone: node web/dev/checks/UX.T3-chatinfo.mjs (VIEWPORT=phone, DIST=…).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { back, byTid, hold, press } from "./sel.mjs";

export const viewports = ["phone", "tablet", "desktop"];

const CHAT = "c_UXT3_chat", ARCH = "c_UXT3_arch", SERVER = "s_uxt3", REMOTE = `${SERVER}~c_UXT3_remote`;
const FOLDER = "/Users/ana/projects/acme/checkout-service";
const WAIT = 15000;
const J = JSON.stringify;
const A = "a".repeat(64), B = "b".repeat(64);

/** A PNG of one colour, small (the picture's size does not matter to what is asserted). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

/** A swipe of a finger from (x, y) by (dx, dy), through the DevTools session. */
let fingers = 0;
async function swipe(page, x, y, dx, dy) {
  const finger = ++fingers, c = await page.context().newCDPSession(page), at = (i) => [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8, id: finger }];
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= 8; i++) await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i) });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await c.detach();
}

await check("UX.T3-chatinfo Chat info and what it opens: usage, the tree, images, an archived chat and a chat whose server is away", async (c) => {
  const { url, viewport, open, fail, note } = c;
  const phone = viewport === "phone";
  const expect = (ok, what) => { if (!ok) fail(what); return ok; };
  const T = (page, id, data, root) => byTid(root ?? page, id, data);
  const step = async (name, fn) => { try { await fn(); } catch (e) { fail(`${name}: ${String(e.message ?? e).split("\n")[0]}`); } };
  const seen = (loc) => loc.first().isVisible().catch(() => false);
  const shows = (page, id, data) => until(async () => seen(T(page, id, data)), WAIT);
  const gone = (page, id, data) => until(async () => (await T(page, id, data).count()) === 0 || !(await seen(T(page, id, data))), WAIT);
  const box = (loc) => loc.first().evaluate((e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const text = async (loc) => (((await loc.first().textContent().catch(() => "")) ?? "").replace(/\s+/g, " ")).trim();
  const toastSays = (page, re) => until(async () => re.test(await text(T(page, "toast"))), 8000);
  const mock = (code) => mockEval(code, url);
  // The Server row's destination. Wide: the Servers dialog, closed with Escape. Phone (S2, goal 3.8): the server's detail, a pushed screen whose body
  // `srv-facts` (dataSet server, place "screen") is the server's one place; it is closed with the stack's back, which lands on the chat again.
  const serverShown = async (page, server) => phone
    ? until(async () => (await T(page, "srv-facts", { place: "screen", server }).count()) > 0, WAIT)
    : until(async () => (await T(page, "servers-dialog").count()) > 0, WAIT);
  const serverClosed = async (page) => {
    if (phone) { await back(page); return until(async () => (await T(page, "srv-facts").count()) === 0, 5000); }
    await page.keyboard.press("Escape");
    return until(async () => (await T(page, "servers-dialog").count()) === 0, 5000);
  };

  /** A touch target the check presses is at least 44 pt high (and wide, unless it is a full row). */
  const target = async (loc, what, { high = 44, wide = 44 } = {}) => {
    const r = await box(loc);
    expect(r.h >= high - 0.5 && r.w >= wide - 0.5, `${what} is ${Math.round(r.w)} × ${Math.round(r.h)} pt, under ${wide} × ${high}`);
  };
  /** No visible text under `root` is drawn smaller than 13 px. */
  const noSmallText = async (page, rootId, what) => {
    const small = await T(page, rootId).last().evaluate((root) => {
      const out = [];
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode, e = n.parentElement;
        if (!n.textContent.trim() || !e) continue;
        const r = e.getBoundingClientRect(), s = getComputedStyle(e);
        if (r.width === 0 || r.height === 0 || s.visibility === "hidden") continue;
        if (parseFloat(s.fontSize) < 13) out.push(`${n.textContent.trim().slice(0, 24)} (${s.fontSize})`);
      }
      return out;
    }).catch(() => []);
    expect(!small.length, `${what} has text under 13 px: ${small.join(", ")}`);
  };
  /** Closes the top sheet with the key (the kit's Sheet takes Escape) or, failing that, a press on its backdrop. */
  const closeTop = async (page, id) => {
    await page.keyboard.press("Escape");
    if (await gone(page, id)) return true;
    await T(page, "overlay-backdrop").last().click({ force: true, position: { x: 8, y: 8 } }).catch(() => {});
    return gone(page, id);
  };
  const openInfo = async (page, via = "chat-more") => {
    await press(page, T(page, via).first());
    return shows(page, "chat-info");
  };
  const rows = (page) => T(page, "chat-info-row").evaluateAll((els) => els.map((e) => e.getAttribute("data-row")));
  const row = (page, name) => T(page, "chat-info-row", { row: name }).first();
  const head = (page) => text(T(page, "chat-head-name"));

  // ---- the wide layouts: nothing of the phone's is drawn, and the title renames in place
  if (!phone) {
    await seed(url, "UXT3");
    await mock(`ux3.plan = [{ kind: "session", label: "Current session", percent: 84, inMs: 3600000 }];`);
    const { page, ctx } = await open({ sel: { chat: CHAT }, wait: '[data-testid="chat-head"]' });
    await step("wide", async () => {
      await T(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
      expect(await T(page, "chat-more").count() === 0, `${viewport}: the header has the phone's ⋯`);
      await press(page, T(page, "chat-head-name").first());
      await page.waitForTimeout(500);
      expect(await T(page, "chat-info").count() === 0, `${viewport}: the title opened Chat info`);
      expect(await shows(page, "chat-name-input"), `${viewport}: the title does not rename in place (no name field)`);
      await page.keyboard.press("Escape");
      await gone(page, "chat-name-input");
      // the context meter's popover, not the sheet; the tree's dialog, not the sheet
      await press(page, T(page, "ctx-meter").first());
      await page.waitForTimeout(600);
      expect(await T(page, "usage-sheet").count() === 0, `${viewport}: the context meter opened the usage sheet`);
      expect(await shows(page, "usage-pop"), `${viewport}: the context meter opened no popover`);
      await page.keyboard.press("Escape");
      await gone(page, "usage-pop");
      await press(page, T(page, "fk-tree-btn").first());
      expect(await shows(page, "fk-nav"), `${viewport}: the tree button opened no tree`);
      expect(await T(page, "fk-done").count() === 0, `${viewport}: the tree has the phone's Done (fk-done)`);
      await page.keyboard.press("Escape");
      await gone(page, "fk-nav");
      expect(await T(page, "chat-info").count() === 0 && await T(page, "usage-sheet").count() === 0, `${viewport}: a phone sheet is drawn`);
    });
    await step("wide images", async () => {
      await ctx.route("**/host/picture/local/*/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
      await page.reload({ waitUntil: "domcontentloaded" });
      await T(page, "image-thumb").first().waitFor({ state: "visible", timeout: WAIT });
      await press(page, T(page, "image-thumb").first());
      expect(await shows(page, "image-large"), `${viewport}: a thumbnail opened no viewer`);
      expect(await T(page, "image-large-dots").count() === 0, `${viewport}: the viewer has the phone's page dots`);
      await page.keyboard.press("Escape");
    });
    await mock("ux3.plan = null;");
    await ctx.close();
    return;
  }

  // ---- the phone, in both themes
  for (const theme of ["light", "dark"]) {
    const bad = (line) => fail(`${theme}: ${line}`);
    const ex = (ok, what) => { if (!ok) bad(what); return ok; };
    const tstep = async (name, fn) => { try { await fn(); } catch (e) { bad(`${name}: ${String(e.message ?? e).split("\n")[0]}`); } };
    await seed(url, "UXT3");
    await mock(`ux3.plan = [
      { kind: "weekly_scoped", label: "Current week (Fable)", percent: 33, inMs: 2.5 * 86400000 },
      { kind: "weekly_all", label: "Current week (all models)", percent: 62, inMs: 1.5 * 86400000 },
      { kind: "session", label: "Current session", percent: 84, inMs: 4 * 3600000 }];`);
    const o = await open({ sel: { chat: CHAT }, ls: { "aiwb.theme": theme }, wait: '[data-testid="chat-head"]' });
    const { page, ctx } = o;
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
    await ctx.route("**/host/picture/local/*/*", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
    await Promise.all([
      ctx.addInitScript(() => {
        Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
        Object.defineProperty(navigator, "share", { configurable: true, value: async () => {} });
      }),
    ]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await T(page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
    const calls = callsOf(page);

    // ---- Chat info from the title and from ⋯: its head, its rows in order, their words
    await tstep("info opens", async () => {
      // (the title is a text; what a finger presses is the button around it, as high as the bar)
      const press44 = await T(page, "chat-head-name").first().evaluate((e) => { for (let n = e; n && n !== document.body; n = n.parentElement) { if (n.getAttribute("role") === "button" || n.tagName === "BUTTON") { const r = n.getBoundingClientRect(); return { w: r.width, h: r.height }; } } return null; });
      ex(!!press44 && press44.h >= 43.5 && press44.w >= 44, `the header's title is pressed by ${J(press44)}, not a button of 44 pt`);
      ex(await openInfo(page, "chat-head-name"), "the title did not open Chat info");
      const sheet = T(page, "chat-info").last();
      ex(await text(T(page, "sheet-title", undefined, sheet)) === "Fix the flaky cart test", `Chat info's title is ${J(await text(T(page, "sheet-title", undefined, sheet)))}`);
      ex(/^Chat info · started today at \d{2}:\d{2}$/.test(await text(T(page, "sheet-sub", undefined, sheet))), `Chat info's sub-line is ${J(await text(T(page, "sheet-sub", undefined, sheet)))}`);
      ex(await closeTop(page, "chat-info"), "Escape did not close Chat info");
      ex(await openInfo(page, "chat-more"), "the ⋯ did not open Chat info");
      ex(J(await rows(page)) === J(["name", "agent", "folder", "server", "context", "tree", "archive", "delete"]), `Chat info's rows are ${J(await rows(page))}`);
      const body = await text(T(page, "chat-info-body"));
      for (const w of ["Name", "Agent · model · effort", "Claude Code · Opus 5.5 · High", "Locked", "Folder", "Server", "Context", "Chat tree", "2 branches", "Archive", "Delete chat…"]) ex(body.includes(w), `Chat info does not say ${J(w)}: ${J(body)}`);
      ex(/Fixed after the first message\.\s*Fork the chat to try another model\./.test(await text(T(page, "chat-info"))), "Chat info does not carry the lock note");
      ex(body.includes("36% · 72k of 200k"), `the Context row says ${J(body.match(/Context[^C]*/)?.[0])}, not 36% · 72k of 200k`);
      await noSmallText(page, "chat-info", "Chat info");
      for (const r of ["name", "agent", "folder", "server", "context", "tree", "archive", "delete"]) await target(row(page, r), `the ${r} row`, { high: 44, wide: 200 });
    });

    // ---- Rename is shown and opens the name field
    await tstep("rename", async () => {
      const rename = T(page, "chat-info-rename").first();
      ex(await seen(rename), "Rename is not shown on the Name row");
      await target(rename, "Rename");
      ex(await row(page, "name").getAttribute("data-disabled") === null, "the Name row is faded in a chat that can be renamed");
      await press(page, rename);
      ex(await gone(page, "chat-info"), "Rename did not close Chat info");
      const field = page.locator('[data-testid="chat-name-input"], [data-testid="form-sheet"] input, [data-testid="rename-input"]').first();
      ex(await until(async () => seen(field), WAIT), "Rename opened no name field");
      await page.keyboard.press("Escape");
      await until(async () => !(await seen(field)) , 5000);
    });

    // ---- the folder: the whole path, Copy and its toast; the lock note; the Server row
    await tstep("folder and server", async () => {
      ex(await openInfo(page), "Chat info did not open again");
      const folder = await text(row(page, "folder"));
      ex(folder.replace(/[\s\u200b]/g, "").includes(FOLDER), `the Folder row says ${J(folder)}, not the whole path ${FOLDER}`);
      const cut = await row(page, "folder").evaluate((r) => [...r.querySelectorAll("*")].some((e) => e.scrollWidth > e.clientWidth + 1 && ["hidden", "clip"].includes(getComputedStyle(e).overflowX)));
      ex(!cut, "the folder path is cut off");
      await page.evaluate(() => navigator.clipboard.writeText(""));
      await target(T(page, "chat-info-copy"), "Copy");
      await press(page, T(page, "chat-info-copy").first());
      ex(await toastSays(page, /^Folder path copied$/), `Copy's toast says ${J(await text(T(page, "toast")))}`);
      ex(await until(async () => (await page.evaluate(() => navigator.clipboard.readText())) === FOLDER, 5000), "Copy did not put the folder path on the clipboard");
      // (the toast sits over the sheet: Chat info is still open)
      ex(await seen(T(page, "chat-info")), "Copy closed Chat info");
      // the server's state word is the server's state
      const word = T(page, "state-word", undefined, row(page, "server")).first();
      const state = await mock(`return entryById("local").state;`);
      ex(await word.getAttribute("data-word") === state && await text(word) !== "", `the Server row's word is ${J(await word.getAttribute("data-word"))} (${J(await text(word))}) while the server is ${J(state)}`);
      ex(/This computer/.test(await text(row(page, "server"))), `the Server row says ${J(await text(row(page, "server")))}`);
      await press(page, row(page, "server"));
      ex(await gone(page, "chat-info"), "the Server row did not close Chat info");
      ex(await serverShown(page, "local"), "the Server row opened no server detail");
      ex(await serverClosed(page), "the server detail did not close");
      await page.waitForTimeout(300);
    });

    // ---- Context and usage
    await tstep("usage", async () => {
      ex(await openInfo(page), "Chat info did not open for Context");
      await press(page, row(page, "context"));
      ex(await gone(page, "chat-info") && await shows(page, "usage-sheet"), "Context did not close Chat info and open the usage sheet");
      const sheet = T(page, "usage-sheet").last();
      ex(await text(T(page, "sheet-title", undefined, sheet)) === "Context and usage", `the usage sheet's title is ${J(await text(T(page, "sheet-title", undefined, sheet)))}`);
      const sub = await text(T(page, "sheet-sub", undefined, sheet));
      ex(sub.includes("Fix the flaky cart test") && sub.includes("Claude Code"), `the usage sheet's sub-line is ${J(sub)}, not the chat and the agent`);
      await T(page, "usage-split-bar").first().waitFor({ state: "visible", timeout: WAIT });
      ex(await text(T(page, "usage-big")) === "36%", `the big number is ${J(await text(T(page, "usage-big")))}, not 36%`);
      const legend = await T(page, "usage-legend").evaluateAll((els) => els.map((e) => ({ cat: e.getAttribute("data-cat"), h: e.getBoundingClientRect().height })));
      ex(legend.length >= 5, `the legend has ${legend.length} rows`);
      ex(legend.every((l) => l.h >= 38 - 0.5), `a legend row is under 38 pt: ${J(legend)}`);
      await press(page, T(page, "usage-legend", { cat: "messages" }).first());
      ex(await until(async () => (await T(page, "usage-legend", { cat: "tool_results" }).count()) > 0, 5000), "Messages did not expand to its parts");
      await press(page, T(page, "usage-legend", { cat: "messages" }).first());
      await T(page, "usage-row").first().waitFor({ state: "visible", timeout: WAIT });
      const limits = await T(page, "usage-row").evaluateAll((els) => els.map((e) => [e.getAttribute("data-kind"), e.getAttribute("data-tone")]).sort((a, b) => a[0].localeCompare(b[0])));
      ex(J(limits) === J([["session", "warn"], ["weekly_all", "ok"], ["weekly_scoped", "ok"]]), `the plan limits' tones are ${J(limits)}: the one at 84 % is amber (warn) and the others are not`);
      await noSmallText(page, "usage-sheet", "the usage sheet");
      ex(await closeTop(page, "usage-sheet"), "the usage sheet did not close");
    });

    // ---- the chat tree as a sheet
    await tstep("tree", async () => {
      ex(await openInfo(page), "Chat info did not open for the tree");
      await press(page, row(page, "tree"));
      ex(await gone(page, "chat-info") && await shows(page, "tree-popup"), "Chat tree did not close Chat info and open the tree sheet");
      await T(page, "fk-row").first().waitFor({ state: "visible", timeout: WAIT });
      await target(T(page, "fk-done"), "Done");
      ex(await text(T(page, "fk-done")) === "Done", `Done says ${J(await text(T(page, "fk-done")))}`);
      ex(Math.round((await box(T(page, "fk-filters"))).h) === 32, `the filter is ${(await box(T(page, "fk-filters"))).h} pt high, not 32`);
      ex(Math.round((await box(T(page, "fk-search"))).h) === 44, `the search is ${(await box(T(page, "fk-search"))).h} pt high, not 44`);
      const heights = await T(page, "fk-row").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
      ex(heights.length >= 2 && heights.every((h) => h === 48), `the rows are ${J(heights)} pt high, not 48`);
      ex(await T(page, "fk-here").count() === 1 && await text(T(page, "fk-here")) === "You are here", `"You are here": ${await T(page, "fk-here").count()} of them, saying ${J(await text(T(page, "fk-here")))}`);
      ex(await text(T(page, "fk-filter", { id: "labeled" })) === "Labeled · 1", `the Labeled filter says ${J(await text(T(page, "fk-filter", { id: "labeled" })))}, not "Labeled · 1"`);
      ex(/Root cause found/.test(await text(T(page, "fk-tag"))), `the row's tag says ${J(await text(T(page, "fk-tag")))}`);
      ex(/Fix the flaky cart test/.test(await text(T(page, "fk-nav-sub"))), `the sheet's sub-line says ${J(await text(T(page, "fk-nav-sub")))}`);
      await noSmallText(page, "tree-popup", "the tree sheet");
      // a hold on a row: its P1, and the tree is not drawn while it is open
      const first = (await T(page, "fk-row", { kind: "user" }).count()) ? T(page, "fk-row", { kind: "user" }).first() : T(page, "fk-row").first();
      await hold(page, first, { until: T(page, "fk-row-sheet").first() });
      ex(await shows(page, "fk-row-sheet"), "a hold on a row opened no action sheet (fk-row-sheet)");
      ex(await T(page, "fk-nav").count() === 0, "the tree is drawn under the row's action sheet: two sheets at once");
      await page.waitForTimeout(400);
      const label = T(page, "action-row", { action: "label" }).first();
      ex(await seen(label) && /Label…|Relabel…/.test(await text(label)), `the row's sheet has no Label…: ${J(await text(label))}`);
      await target(label, "Label…", { high: 44, wide: 100 });
      await press(page, label);
      ex(await shows(page, "fk-label-form"), "Label… did not open the label form");
      ex(await T(page, "fk-nav").count() === 0, "the tree is drawn under the Label form: two sheets at once");
      const input = T(page, "fk-label-input").first();
      await input.fill("Retry flake");
      const save = T(page, "sheet-right").last();
      await target(save, "Save", { high: 44, wide: 44 });
      ex(/Save/.test(await text(save)), `the form's action says ${J(await text(save))}, not Save`);
      await press(page, save);
      ex(await gone(page, "fk-label-form"), "Save did not close the label form");
      ex(await shows(page, "fk-nav") || await shows(page, "tree-popup"), "the tree did not come back after Save");
      ex(await until(async () => /Retry flake/.test(await text(T(page, "fk-tag"))), WAIT) || await until(async () => /Retry flake/.test(await text(T(page, "tree-popup"))), WAIT), "the saved label is not a tag on the tree's row");
      await press(page, T(page, "fk-done").first());
      ex(await gone(page, "tree-popup"), "Done did not close the tree sheet");
    });

    // ---- Archive with Undo, and Delete with its confirmation
    await tstep("archive", async () => {
      ex(await openInfo(page), "Chat info did not open for Archive");
      await press(page, row(page, "archive"));
      ex(await gone(page, "chat-info"), "Archive did not close Chat info");
      ex(await toastSays(page, /^Chat archived/), `the archive's toast says ${J(await text(T(page, "toast")))}`);
      const undo = T(page, "toast-action").first();
      ex(/Undo/.test(await text(undo)), `the toast's action says ${J(await text(undo))}, not Undo`);
      await target(undo, "Undo");
      ex(await mock(`return !!chats.${CHAT}.archived;`) === true, "Archive did not archive the chat");
      await press(page, undo);
      ex(await until(async () => (await mock(`return !!chats.${CHAT}.archived;`)) === false, WAIT), "Undo did not unarchive the chat");
      await page.waitForTimeout(1500);
      ex(await mock(`return !!chats.${CHAT}.archived;`) === false, "the chat is archived again after Undo");
      ex(!/^Archived/.test(await text(T(page, "chat-head-sub"))), `the header says ${J(await text(T(page, "chat-head-sub")))} after Undo`);
    });
    await tstep("delete", async () => {
      ex(await openInfo(page), "Chat info did not open for Delete");
      await press(page, row(page, "delete"));
      ex(await gone(page, "chat-info") && await shows(page, "confirm-dialog"), "Delete chat… did not open the confirmation");
      const confirm = T(page, "confirm-dialog").last();
      ex(/Fix the flaky cart test/.test(await text(T(page, "confirm-title", undefined, confirm))) || /Delete/.test(await text(T(page, "confirm-title", undefined, confirm))), `the confirmation's title is ${J(await text(T(page, "confirm-title", undefined, confirm)))}`);
      ex(await text(T(page, "confirm-go", undefined, confirm)) === "Delete chat", `the confirm button says ${J(await text(T(page, "confirm-go", undefined, confirm)))}, not "Delete chat"`);
      ex(await text(T(page, "confirm-cancel", undefined, confirm)) === "Cancel", `the cancel button says ${J(await text(T(page, "confirm-cancel", undefined, confirm)))}`);
      await target(T(page, "confirm-go"), "Delete chat", { high: 44, wide: 200 });
      await target(T(page, "confirm-cancel"), "Cancel", { high: 44, wide: 200 });
      const was = calls.length;
      await press(page, T(page, "confirm-cancel").first());
      ex(await gone(page, "confirm-dialog"), "Cancel did not close the confirmation");
      await page.waitForTimeout(500);
      ex(!calls.slice(was).some((x) => x.method === "DELETE"), "Cancel sent a DELETE");
      ex(await mock(`return !!chats.${CHAT};`) === true, "Cancel deleted the chat");
    });

    // ---- the images: thumbnails, the black viewer, a swipe, Ask about it
    await tstep("images", async () => {
      await T(page, "image-thumb").first().waitFor({ state: "visible", timeout: WAIT });
      const sizes = await T(page, "image-thumb").evaluateAll((els) => els.map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
      ex(sizes.length === 2 && sizes.every((s) => s === "116x140"), `the thumbnails are ${J(sizes)}, not two of 116x140`);
      await press(page, T(page, "image-thumb").first());
      ex(await shows(page, "image-large"), "a thumbnail opened no viewer");
      const viewer = T(page, "image-large").last();
      const ground = await viewer.evaluate((e) => { for (let n = e; n; n = n.parentElement) { const b = getComputedStyle(n).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(b)) return b; } return "none"; });
      ex(/^rgb\(0, 0, 0\)$|^rgba\(0, 0, 0, (0\.9\d*|1)\)$/.test(ground), `the viewer's ground is ${ground}, not black`);
      ex(await text(T(page, "image-large-name")) === "one.png", `the viewer's name is ${J(await text(T(page, "image-large-name")))}`);
      ex(await text(T(page, "image-large-sub")) === "Image 1 of 2 · your message", `the viewer's sub-line is ${J(await text(T(page, "image-large-sub")))}`);
      ex(await T(page, "image-large-dots").first().getAttribute("data-count") === "2", "the viewer has no two page dots");
      for (const a of ["share", "save", "ask"]) { ex(await T(page, `image-large-${a}`).count() === 1, `the viewer has no ${a} action`); if (await T(page, `image-large-${a}`).count()) await target(T(page, `image-large-${a}`), `the ${a} action`, { high: 44, wide: 44 }); }
      ex(await T(page, "image-large-prev").count() === 0 && await T(page, "image-large-next").count() === 0, "the viewer has prev/next buttons");
      await target(T(page, "image-large-close"), "the viewer's close");
      await noSmallText(page, "image-large", "the viewer");
      const w = page.viewportSize().width, h = page.viewportSize().height;
      await swipe(page, w * 0.75, h * 0.5, -w * 0.5, 0);
      ex(await until(async () => (await text(T(page, "image-large-name"))) === "two.png" && (await text(T(page, "image-large-sub"))) === "Image 2 of 2 · your message", 8000), `a swipe left leaves the viewer at ${J(await text(T(page, "image-large-name")))} / ${J(await text(T(page, "image-large-sub")))}`);
      await swipe(page, w * 0.25, h * 0.5, w * 0.5, 0);
      ex(await until(async () => (await text(T(page, "image-large-name"))) === "one.png", 8000), "a swipe right did not go back to one.png");
      await press(page, T(page, "image-large-ask").first());
      ex(await gone(page, "image-large"), "Ask about it did not close the viewer");
      ex(await until(async () => (await T(page, "composer-images").locator('[data-testid="image-thumb"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).includes("one.png"), WAIT), "Ask about it did not put the image in the composer");
    });

    // ---- the branch pill (chunk 6), where the build has it
    await tstep("pill", async () => {
      ex(await until(async () => (await T(page, "fk-marker").count()) > 0, WAIT), "the message at the split has no branch pill");
      const marker = T(page, "fk-marker").first();
      await marker.scrollIntoViewIfNeeded();
      const n = () => marker.getAttribute("data-n");
      ex(await n() === "1" && /Branch 1 of 2/.test((await marker.getAttribute("aria-label")) ?? ""), `the pill says ${J(await marker.getAttribute("aria-label"))}, not "Branch 1 of 2"`);
      // (the pill is drawn 150 × 36, as the mockup has it, and its parts reach 44 pt by their hit slop: the slop is native only, react-native-web draws none, so
      // here the drawn parts are read: the arrows 30 wide, the middle the rest)
      const pill = await box(marker);
      ex(Math.round(pill.h) === 36 && pill.w >= 150 - 0.5, `the pill is ${Math.round(pill.w)} × ${Math.round(pill.h)} pt, not 150 × 36`);
      for (const id of ["fk-marker-prev", "fk-marker-next"]) ex(Math.round((await box(T(page, id))).w) === 30, `${id} is ${(await box(T(page, id))).w} pt wide, not 30`);
      await press(page, T(page, "fk-marker-next").first());
      ex(await until(async () => (await n()) === "2", 10000), `› did not switch the branch in place: the pill says branch ${await n()}`);
      ex(await T(page, "tree-popup").count() === 0, "› opened the tree");
      await marker.scrollIntoViewIfNeeded();
      await press(page, T(page, "fk-marker-prev").first());
      ex(await until(async () => (await n()) === "1", 10000), "‹ did not bring the first branch back");
      await marker.scrollIntoViewIfNeeded();
      await press(page, T(page, "fk-marker-open").first());
      ex(await shows(page, "tree-popup"), "the pill's middle did not open the tree");
      await press(page, T(page, "fk-done").first());
      ex(await gone(page, "tree-popup"), "Done did not close the tree opened from the pill");
    });
    await ctx.close();

    // ---- the archived chat's Chat info
    {
      const a = await open({ sel: { chat: ARCH }, ls: { "aiwb.theme": theme }, wait: '[data-testid="chat-head"]' });
      await tstep("archived", async () => {
        ex(/^Archived/.test(await text(T(a.page, "chat-head-sub"))), `the archived chat's header says ${J(await text(T(a.page, "chat-head-sub")))}, not "Archived · …"`);
        ex(await openInfo(a.page), "the archived chat's ⋯ did not open Chat info");
        const r = await rows(a.page);
        ex(r.includes("unarchive") && !r.includes("archive"), `the archived chat's rows are ${J(r)}: Unarchive, not Archive`);
        ex(/Unarchive/.test(await text(row(a.page, "unarchive"))), `the row says ${J(await text(row(a.page, "unarchive")))}`);
        ex(await row(a.page, "name").getAttribute("data-disabled") === "true", "the Name row of an archived chat is not faded");
        const rename = T(a.page, "chat-info-rename").first();
        ex((await rename.getAttribute("aria-disabled")) === "true" || (await rename.getAttribute("disabled")) !== null, "Rename of an archived chat is not disabled");
        ex(/Unarchive the chat to rename it\./.test(await text(row(a.page, "name"))), `the Name row says ${J(await text(row(a.page, "name")))}, not why Rename is off`);
        await noSmallText(a.page, "chat-info", "the archived chat's Chat info");
      });
      await a.ctx.close();
    }

    // ---- the chat on a server that goes away and comes back
    {
      const r = await open({ sel: { chat: REMOTE }, ls: { "aiwb.theme": theme }, wait: '[data-testid="chat-head"]' });
      await tstep("offline", async () => {
        await T(r.page, "msg").first().waitFor({ state: "visible", timeout: WAIT });
        await mock(`return setServerState("${SERVER}", "unreachable", { detail: "connection refused" });`);
        ex(await until(async () => /offline/.test(await text(T(r.page, "chat-head-sub"))), WAIT), `the header's sub-line is ${J(await text(T(r.page, "chat-head-sub")))}, not "● Design Mac · offline"`);
        ex(await T(r.page, "remote-bar").count() === 0, "a bar is drawn on the phone under a chat whose server dropped");
        const opacity = await T(r.page, "thread").first().evaluate((e) => { let o = 1; for (let n = e; n && n !== document.body; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; });
        ex(opacity === 1, `the thread is drawn at opacity ${opacity}, not 1`);
        ex(await openInfo(r.page), "Chat info did not open for a chat whose server is away");
        for (const name of ["name", "archive", "delete"]) {
          ex(await row(r.page, name).getAttribute("data-disabled") === "true", `the ${name} row is live while its server is away`);
          ex(/Design Mac is offline: you can do this when it is back\./.test(await text(row(r.page, name))), `the ${name} row says ${J(await text(row(r.page, name)))}`);
        }
        const rename = T(r.page, "chat-info-rename").first();
        ex((await rename.getAttribute("aria-disabled")) === "true" || (await rename.getAttribute("disabled")) !== null, "Rename is live while its server is away");
        ex(await row(r.page, "server").getAttribute("data-disabled") === null, "the Server row is faded while its server is away");
        const word = T(r.page, "state-word", undefined, row(r.page, "server")).first();
        ex(await word.getAttribute("data-word") === "unreachable", `the Server row's word is ${J(await word.getAttribute("data-word"))}, not "unreachable"`);
        ex(/Design Mac/.test(await text(row(r.page, "server"))), `the Server row says ${J(await text(row(r.page, "server")))}`);
        await press(r.page, row(r.page, "server"));
        ex(await serverShown(r.page, SERVER), "the Server row opened no server detail while its server is away");
        ex(await serverClosed(r.page), "the server detail did not close while its server is away");
        await mock(`return setServerState("${SERVER}", "connected");`);
        ex(await toastSays(r.page, /^Design Mac is back online$/), `the toast after the return says ${J(await text(T(r.page, "toast")))}, not "Design Mac is back online"`);
      });
      await r.ctx.close();
    }
    await mock("ux3.plan = null;");
  }
  note("Chat info, usage, tree, archive, delete, images, an archived chat and a chat whose server drops, in the light and the dark theme");
}, { viewports, page: false });
