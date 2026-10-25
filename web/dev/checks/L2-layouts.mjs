// L2 (new in the app, package U3): each width gives its layout, and the phone's stack follows the selection (AD-71, AD-72).
//   desktop and tablet: one split view: the sidebar's pane beside the stage, the chat panel between them for a board's chat, a
//     resizer on each pane's edge, no back control; a plain chat is the chat page; a board is the board stage with its bar.
//   phone: a stack: Home (package H1: the sidebar is the wide layouts') is the first screen with nothing beside it, no resizer; a board, a board's chat over its board and a
//     plain chat each replace the screen below, with the back control (`nav-back`); the saved selection (`aiwb.sel`) is what each screen
//     says (forward), and a back sets it (the chat or the board cleared) and shows the screen below (a board in a group: the group's
//     screen, whose `home-row`s list it, then Home), until Home is the screen.
//   the window: a desktop window made narrow is the phone layout with the selection it had, and wide again the split view;
//     a tablet window too narrow for the three at their least starts with the sidebar hidden, and shows it over the stage.
// The sidebar, the chat and the canvas inside the panes are the stand-ins of the shell (screens/shell/slots.tsx) until S1, S4 and B4;
// what is proved is the shell round them.
import { check, seed, until } from "../shot.mjs";
import { IDS, back, byTid, layoutNow, openBoard, openChat, press } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("aiwb.sel") ?? "null"));
const rect = async (loc) => { const b = await loc.first().boundingBox(); return b && b.width > 0 ? b : null; };
const visible = async (page, id, data) => byTid(page, id, data).last().isVisible().catch(() => false); // (last: on the phone the screen on top is the last)
const near = (a, b) => Math.abs(a - b) <= 1;

await check("L2 each width gives its layout; the phone's stack follows the selection", async ({ url, viewport, layout, open, fail, note }) => {
  await seed(url, "A1");
  const { page, ctx } = await open({ sel: { board: "b_arch", chat: "c_board" } });
  const root = byTid(page, "app-root").first();
  if ((await root.getAttribute("data-layout")) !== layout) fail(`the root says layout "${await root.getAttribute("data-layout")}", not "${layout}"`);
  if (layoutNow(page) !== layout) fail(`the window's width gives "${layoutNow(page)}", not "${layout}"`);

  if (layout === "phone") {
    // a board's chat is the top of the stack: the chat over its board over the list
    await byTid(page, IDS.chatHead).first().waitFor({ state: "visible", timeout: 15000 });
    if (!await visible(page, IDS.back)) fail("a chat on the phone has no back control");
    if (await visible(page, IDS.home)) fail("Home shows over the chat on the phone");
    if (await byTid(page, "resizer").count()) fail("the phone draws a resizer");
    if (await byTid(page, "app").count()) fail("the phone draws the split view");
    if (await byTid(page, "board-panel").count()) fail("the phone draws the chat panel beside the board");
    await back(page);
    await byTid(page, IDS.boardBar).first().waitFor({ state: "visible", timeout: 15000 });
    if ((await saved(page))?.chat) fail(`after the back from the chat the saved selection is ${JSON.stringify(await saved(page))}: the chat is not cleared`);
    if ((await saved(page))?.board !== "b_arch") fail(`after the back from the chat the board is not kept: ${JSON.stringify(await saved(page))}`);
    if (!await visible(page, IDS.back)) fail("a board on the phone has no back control");
    await back(page);
    // (the board is in the group Shop: a back from content lands on the content's place, the group's screen, then on the list)
    await byTid(page, IDS.homeRow, { kind: "board", key: "b_arch" }).first().waitFor({ state: "visible", timeout: 15000 });
    if (await visible(page, IDS.home)) fail("Home shows after one back from a board in a group: the group's screen comes first");
    if (!await visible(page, IDS.back)) fail("the group's screen has no back control");
    const mid = await saved(page);
    if (mid?.board || mid?.chat) fail(`on the group's screen the saved selection is ${JSON.stringify(mid)}, not none`);
    await back(page);
    await byTid(page, IDS.home).first().waitFor({ state: "visible", timeout: 15000 });
    const s = await saved(page);
    if (s?.board || s?.chat) fail(`on Home the saved selection is ${JSON.stringify(s)}, not none`);
    if (await visible(page, IDS.back)) fail("Home has a back control");
    // forward: a row opens its screen, and the selection follows
    await openChat(page, "c_plain");
    if ((await saved(page))?.chat !== "c_plain") fail(`opening c_plain saved ${JSON.stringify(await saved(page))}`);
    if (await visible(page, IDS.home)) fail("Home shows over a chat");
    await back(page);
    await byTid(page, IDS.homeRow, { kind: "chat", key: "c_plain" }).first().waitFor({ state: "visible", timeout: 15000 }); // (c_plain is in the group Shop too)
    await back(page);
    await byTid(page, IDS.home).first().waitFor({ state: "visible", timeout: 15000 });
    await openBoard(page, "b_arch");
    if ((await saved(page))?.board !== "b_arch") fail(`opening b_arch saved ${JSON.stringify(await saved(page))}`);
    note("the stack follows the selection: board and chat pushed over the list, each back clears what it left");
    return;
  }

  // the wide layouts: one split view
  await byTid(page, "board-panel").first().waitFor({ state: "visible", timeout: 15000 });
  const side = await rect(byTid(page, "side-pane")), panel = await rect(byTid(page, "board-panel")), stage = await rect(byTid(page, "board-stage"));
  const win = page.viewportSize();
  if (!side || !panel || !stage) return fail(`the split view lacks a part: sidebar ${!!side}, panel ${!!panel}, stage ${!!stage}`);
  if (!near(side.x, 0) || !near(panel.x, side.x + side.width) || !near(stage.x, panel.x + panel.width) || !near(stage.x + stage.width, win.width)) fail(`the parts are not side by side from edge to edge: sidebar ${side.x}+${side.width}, panel ${panel.x}+${panel.width}, stage ${stage.x}+${stage.width} in ${win.width}`);
  if (await visible(page, IDS.back)) fail("a wide layout has a back control");
  if (await byTid(page, "resizer").count() !== 2) fail(`the wide layout has ${await byTid(page, "resizer").count()} resizers, not one on each of the sidebar and the panel`);
  if (stage.width < 320 - 1) fail(`the stage is ${stage.width} px wide, under its least, 320`);
  if (!await visible(page, IDS.boardBar)) fail("a board has no bar");
  if (!await visible(page, IDS.chatHead)) fail("a board's chat has no header in its panel");
  // a plain chat: the chat page, no panel, no board bar
  await openChat(page, "c_plain");
  if (!await until(() => visible(page, "chat-page"), 10000)) fail("a plain chat has no chat page");
  if (await byTid(page, "board-panel").count() || await byTid(page, IDS.boardBar).count()) fail("a plain chat has the panel or the board's bar");
  // a board with no chat: the stage alone
  await openBoard(page, "b_arch");
  note(`sidebar ${side.width} px, panel ${panel.width} px, stage ${stage.width} px in ${win.width}`);

  if (layout !== "desktop") return; // (the window is resized on the desktop viewport only: the devices' own widths are what the others test)

  // a desktop window made narrow is the phone layout, with the selection it had; wide again it is the split view
  await openChat(page, "c_plain");
  await page.setViewportSize({ width: 600, height: 800 });
  if (!await until(async () => layoutNow(page) === "phone" && await visible(page, IDS.back), 10000)) fail("a window 600 wide is not the phone's stack with the chat on top");
  if ((await saved(page))?.chat !== "c_plain") fail(`narrowing the window changed the selection to ${JSON.stringify(await saved(page))}`);
  await back(page);
  if (!await until(() => visible(page, IDS.homeRow, { kind: "chat", key: "c_plain" }), 10000)) fail("a back from a chat of a group in the narrow window did not show the group's screen");
  await back(page);
  if (!await until(() => visible(page, IDS.home), 10000)) fail("a back in the narrow window did not show Home");
  await page.setViewportSize({ width: 1280, height: 800 });
  if (!await until(async () => await visible(page, "app") && !await visible(page, IDS.back), 10000)) fail("a window made wide again is not the split view");
  if (await byTid(page, "chat-page").count() || await byTid(page, "board-stage").count()) fail("the split view shows a chat or a board after a back to the list");
  if (!await visible(page, "home")) fail("with nothing selected the wide layout does not show Home");

  // a tablet window too narrow for the three at their least: the sidebar starts hidden, and lies over the stage when shown
  await ctx.close(); // (the mock has one stream: two pages open take it from each other)
  const narrow = await open({ size: [760, 900], sel: { chat: "c_plain" } });
  const p = narrow.page;
  if (layoutNow(p) !== "tablet") fail(`a window 760 wide is "${layoutNow(p)}", not the tablet`);
  await byTid(p, "chat-page").first().waitFor({ state: "visible", timeout: 15000 });
  if (await visible(p, "side-pane") || !await visible(p, IDS.show)) fail("a tablet window 760 wide does not start with the sidebar hidden behind its rail");
  if (await p.evaluate(() => localStorage.getItem("aiwb.side")) !== null) fail("the narrow start saved a choice of the sidebar the user never made");
  const before = await rect(byTid(p, "chat-page"));
  await press(p, byTid(p, IDS.show).first());
  if (!await until(() => visible(p, "side-pane"), 10000)) fail("the rail's control did not show the sidebar");
  const over = await rect(byTid(p, "chat-page")), pane = await rect(byTid(p, "side-pane"));
  if (!over || !before || !near(over.width, before.width) || !near(over.x, before.x)) fail(`the sidebar shown moved the stage: ${before?.x}+${before?.width} before, ${over?.x}+${over?.width} after`);
  if (!pane || pane.x > 1 || pane.width < 200) fail(`the overlaid sidebar is ${pane?.width} px wide at ${pane?.x}`);
  await press(p, byTid(p, "side-backdrop").first(), { position: { x: 700, y: 400 } });
  if (!await until(async () => !await visible(p, "side-pane"), 10000)) fail("a press outside the overlaid sidebar did not hide it");
  note("a window 760 wide starts with the sidebar hidden, shows it over the stage, and a press outside hides it");
}, { viewports, page: false });
