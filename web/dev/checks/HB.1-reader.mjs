// New (headless-board W12): a window is a reader of the board it shows, and the button is the only way it becomes the writer (plans/headless-board/architecture.md,
// 2.3, 2.5, 2.6, 2.7, D19), at the desktop and the phone.
//   Opening a board takes nothing: the board comes up in view mode under the reader's bar and is followed (POST …/follow), not taken (no POST …/take,
//     and the mock's `heldBoards` is empty); switching to a chat and back, and a connection that is lost and comes back, take nothing either, and a
//     board that is left is unfollowed.
//   The bar's three texts (D19), by the writer knob of the mock: "View only." (nobody writes), "View only. Another window is editing this board." and
//     "View only. An agent is editing this board." (the headless writer), each with the button "Edit here" and the attributes `role` and `writer` of the bar;
//     a change of writer is told to the open board without a reload. A board that goes to another window under a writer shows "Another window took over this
//     board. View only."
//   The button takes (POST …/take): the bar gives way to the small "Editing" mark, the canvas can be drawn on, and the mock holds the board for the page.
//   A reader follows a save of another writer without a reload and keeps its place: the mock's `othersave` stores a new revision and tells `scene`; the
//     page reads the scene again (GET …/scene), the new shape is on the canvas (found by the colour of its stroke in a screenshot, as L24 finds the agent's),
//     the page and the canvas element are the same ones (not loaded again), and the scroll and zoom the reader had are the ones it has. Once the board is left
//     (unfollow) a save of another writer is not read.
//   A reader's paste is not saved: Excalidraw's clipboard text, pasted into the canvas of a reader, writes nothing (no PUT, the stored revision and shapes
//     as they were; Excalidraw's view mode refuses it on its own, the check's note says so); the same paste in the canvas of the writer is written (the
//     proof that the paste reaches the canvas).
// The phone (B1) has no reader's bar and no "Editing" mark: its reader's sign is the bottom row's button `board-take` (Edit here) and the bar's state
//   word (`state-word`, data-word `view` "View only", `taken` "Another window is editing", `agent` "An agent is editing", `editing` "Editing" for the writer),
//   so the texts above are checked by the word, the `role` and `writer` attributes of the bar by the word's `data-word` (none and none: `view`, a window
//   under a writer or a lost board: `taken`, the headless writer: `agent`), the writer's mark by the word `editing`, and a window that lost the board
//   also gets the toast "Another window took over this board" (data-kind `board-lost`, with the action Edit here). The role "lost" and "none" the bar's
//   attributes tell are not on the phone's screen: the word and the toast are what it says. The button's `Taking over…` form is not read here.
// The pixels of a screenshot are read by the browser's own decoder, in a page of its own (as P7.5-canvas.mjs and L24 do).
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, dragTo, openBoard, openChat, press, tidSel } from "./sel.mjs";
import { editHere, LIVE } from "./boarddraw.mjs";

export const viewports = ["desktop", "phone"];

const J = JSON.stringify;
const BOARD = "b_ui";
const READY = tidSel("board-canvas", { board: BOARD, state: "ready" });
const GREEN = [0, 200, 0], BLUE = [0, 0, 200];
const VIEW_ONLY = "View only.", OTHER = "View only. Another window is editing this board.", AGENT = "View only. An agent is editing this board.", LOST = "Another window took over this board. View only.";
const WORDS = { [VIEW_ONLY]: ["view", "View only"], [OTHER]: ["taken", "Another window is editing"], [AGENT]: ["agent", "An agent is editing"], [LOST]: ["taken", "Another window is editing"] }; // (the phone's state words for the bar's texts)

await check("HB.1 a window is a reader of the board it shows; the button makes it the writer", async ({ url, browser, open, fail, note, touch, viewport }) => {
  const phone = viewport === "phone";
  const decoder = await browser.newPage();
  await seed(url, "A2");
  const { ctx, page } = await open({ sel: { board: BOARD, chat: null }, wait: READY });
  await page.evaluate(() => { window.__mark = "same page"; });
  const calls = callsOf(page);
  const count = (re, method) => calls.filter((c) => c.method === method && re.test(c.path)).length;
  const takes = () => count(/\/boards\/b_ui\/take$/, "POST"), follows = () => count(/\/boards\/b_ui\/follow$/, "POST"), unfollows = () => count(/\/boards\/b_ui\/unfollow$/, "POST");
  const reads = () => count(/\/boards\/b_ui\/scene$/, "GET"), saves = () => count(/\/boards\/b_ui\/scene\?/, "PUT");
  const held = () => mockEval(`return heldBoards.has("${BOARD}");`, url);
  const rev = () => mockEval(`return scenes.${BOARD}.rev;`, url);
  const shapes = () => mockEval(`return scenes.${BOARD}.scene.elements.filter((e) => !e.isDeleted).length;`, url);
  const take = byTid(page, "board-take"), word = byTid(page, "state-word").first();
  const bar = phone ? take : byTid(page, "board-role"), mark = phone ? byTid(page, "state-word", { word: "editing" }) : byTid(page, "board-editing"); // (a reader's sign, the writer's mark)
  const raw = async () => ((await (phone ? word : bar.first()).textContent({ timeout: 1000 }).catch(() => "")) ?? "").replace(/\s+/g, " ").replace(/Edit here$/, "").trim();
  // (the text the screen says, in the bar's own words: on the phone the word found in WORDS)
  const barSays = async () => { const t = await raw(); return phone ? (Object.keys(WORDS).find((k) => WORDS[k][1] === t && k !== LOST) ?? t) : t; };
  const attrsAre = async (role, who, wordKey) => phone ? (await word.getAttribute("data-word")) === wordKey : (await bar.first().getAttribute("data-role")) === role && (await bar.first().getAttribute("data-writer")) === who;
  const writer = (kind) => mockEval(`writer("${BOARD}", ${J(kind)}); return 1;`, url);
  const view = () => page.evaluate(() => window.__aiwbView?.() ?? null);

  // ---- opening a board takes nothing; the board is followed, as a reader's, in view mode, under the bar
  if (!await until(() => bar.count(), 15000)) return fail("a board that was opened shows no reader's bar");
  if (!await until(() => mockEval(`return followed.has("${BOARD}");`, url), 10000)) fail("the board on screen was not followed (the mock has no follow of it)");
  if (!await until(() => page.locator(".excalidraw.excalidraw--view-mode canvas.interactive").count(), 15000)) fail("the board of a reader is not drawn in view mode");
  if (await page.locator(LIVE).count()) fail("the board's canvas can be drawn on before the button was pressed");
  if (takes() || await held()) fail(`opening the board took it (${takes()} takes, held by the page: ${await held()})`);
  if (await barSays() !== VIEW_ONLY) fail(`nobody writes the board and the bar says "${await barSays()}", not "${VIEW_ONLY}"`);
  if (!await attrsAre("none", "none", "view")) fail(phone ? `the bar's state word is ${await word.getAttribute("data-word")}, not view` : `the bar's role and writer are ${await bar.first().getAttribute("data-role")} and ${await bar.first().getAttribute("data-writer")}, not none and none`);
  if (await take.first().textContent() !== "Edit here") fail(`the button reads "${await take.first().textContent()}", not "Edit here"`);
  if (await mark.count()) fail('a reader shows the "Editing" mark');

  // ---- switching to a chat and back takes nothing, and a board that is left is unfollowed
  {
    await openChat(page, "c_plain");
    if (!await until(() => unfollows() >= 1, 10000)) fail("the board that was left was not unfollowed (no POST …/unfollow)");
    const f = follows();
    await openBoard(page, BOARD);
    if (!await until(() => follows() > f, 10000)) fail("the board that was shown again was not followed again");
    if (!await until(() => bar.count(), 15000)) fail("the board shown again has no reader's bar");
    await page.waitForTimeout(500);
    if (takes() || await held()) fail(`switching to a chat and back took the board (${takes()} takes)`);
  }

  // ---- the bar's three texts, told to the open board without a reload
  for (const [kind, text, writerAttr] of [["window", OTHER, "window"], ["headless", AGENT, "headless"], ["", VIEW_ONLY, "none"]]) {
    await writer(kind);
    if (!await until(async () => (await barSays()) === text, 10000)) fail(`the board is written by ${kind || "nobody"} and the bar says "${await barSays()}", not "${text}"`);
    if (!phone && await bar.first().getAttribute("data-writer") !== writerAttr) fail(`the bar's writer is ${await bar.first().getAttribute("data-writer")}, not ${writerAttr}`);
    if (!await take.count()) fail(`the bar has no button while ${kind || "nobody"} writes the board`);
  }
  if (takes() || await held()) fail("a change of writer made the reader take the board");

  // ---- a reader follows a save of another writer: no reload, its place kept
  {
    // (the reader pans its canvas: the mouse drags, a finger drags; the board of a reader is in view mode)
    const box = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
    const from = { x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 };
    const v0 = await view();
    if (!v0) return fail("the build shows no view (window.__aiwbView): it is not made for the checks");
    await dragTo(page, from, { x: from.x - 60, y: from.y - 40 }, { hold: 0, steps: 8 });
    if (!await until(async () => { const v = await view(); return v && (v.scrollX !== v0.scrollX || v.scrollY !== v0.scrollY); }, 10000)) fail(`the reader could not pan its canvas (${J(await view())})`);
    await page.waitForTimeout(400);
    const v1 = await view();
    await page.evaluate(() => { document.querySelector(".excalidraw").__same = "same canvas"; });
    const r0 = await rev(), g0 = reads(), n0 = await shapes(), s0 = saves();
    // a shape of another writer, in the part of the board the reader looks at, in a colour found on the screen
    const at = { x: Math.round(-v1.scrollX + 40), y: Math.round(-v1.scrollY + v1.height / v1.zoom / 2) };
    const made = { id: "hb1_green", type: "rectangle", x: at.x, y: at.y, width: 120, height: 70, strokeColor: "#00c800", backgroundColor: "transparent", strokeWidth: 2, roughness: 0 };
    if (await greenBox(page, decoder)) fail("the colour of the other writer's shape is on the screen before it was saved");
    const r1 = await mockEval(`return othersave("${BOARD}", [...scenes.${BOARD}.scene.elements, ${J(made)}]);`, url);
    if (r1 !== r0 + 1) fail(`the other writer's save is revision ${r1}, not ${r0 + 1}`);
    if (!await until(() => reads() > g0, 10000)) fail("the reader did not read the scene again after the other writer saved it");
    if (!await until(async () => !!(await greenBox(page, decoder)), 15000)) fail("the other writer's shape does not show on the reader's canvas");
    if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again");
    if (await page.evaluate(() => document.querySelector(".excalidraw")?.__same) !== "same canvas") fail("the reader's canvas was made anew (not updated in place)");
    const v2 = await view();
    if (!v2 || Math.abs(v2.scrollX - v1.scrollX) > 0.5 || Math.abs(v2.scrollY - v1.scrollY) > 0.5 || Math.abs(v2.zoom - v1.zoom) > 0.001) fail(`the reader's place moved with the other writer's save: ${J(v1)} then ${J(v2)}`);
    if (saves() !== s0 || await shapes() !== n0 + 1) fail(`the reader wrote while it followed (${saves() - s0} saves; the board has ${await shapes()} shapes, not ${n0 + 1})`);
    if (!await bar.count() || takes() || await held()) fail("the reader stopped being a reader when another writer saved");
    // a save again, by the headless writer, to the reader that is not looking: the board left is not followed (unfollow), so nothing is read
    await openChat(page, "c_plain");
    if (!await until(() => unfollows() >= 2, 10000)) fail("the board that was left the second time was not unfollowed");
    const g1 = reads();
    await mockEval(`othersave("${BOARD}", scenes.${BOARD}.scene);`, url);
    await page.waitForTimeout(800);
    if (reads() !== g1) fail("a board that is not on screen was read after another writer saved it");
    await openBoard(page, BOARD);
    await bar.first().waitFor({ state: "visible", timeout: 15000 });
  }

  // ---- a reader's paste is not saved
  {
    const s0 = saves(), r0 = await rev(), n0 = await shapes();
    await pasteElement(page, "hb1_pasted");
    const shown = await until(() => greenBox(page, decoder, BLUE), 2000);
    await page.waitForTimeout(3000); // (the view tells a change after 250 ms, the board side writes 500 ms after that: well past both)
    if (saves() !== s0) fail(`a reader's paste was written (${saves() - s0} saves)`);
    if (await rev() !== r0 || await shapes() !== n0) fail(`a reader's paste changed the stored board (revision ${await rev()}, not ${r0}; ${await shapes()} shapes, not ${n0})`);
    if (takes() || await held()) fail("a reader's paste made it the writer");
    note(shown ? "(Excalidraw let the paste into the reader's view; it was not kept)" : "(Excalidraw's view mode did not let the paste in at all)");
  }

  // ---- the button takes: the writer's mark, the canvas that can be drawn on
  {
    const t0 = takes();
    await editHere(page);
    if (takes() !== t0 + 1) fail(`the button made ${takes() - t0} takes, not 1`);
    if (!await held()) fail("the button was pressed and the mock does not hold the board for the page");
    if (await bar.count()) fail("the reader's bar stays after the board was taken");
    if (!await page.locator(`${READY} ${LIVE}`).count()) fail("the board that was taken cannot be drawn on");
    if (!await until(() => mark.count(), 10000)) fail(phone ? 'the bar\'s state word is not "Editing" for the writer' : "the writer shows no Editing mark");
    else if ((await mark.first().textContent())?.trim() !== "Editing") fail(`the writer's mark says "${await mark.first().textContent()}", not "Editing"`);
    if (await page.evaluate(() => window.__mark) !== "same page") fail("the page was loaded again by the take");
    // the same paste, in the canvas of the writer, is written
    const s0 = saves(), n0 = await shapes();
    await pasteElement(page, "hb1_pasted");
    if (!await until(async () => (await shapes()) === n0 + 1, 15000)) fail(`a paste in the canvas of the writer was not written (${await shapes()} shapes, not ${n0 + 1}): the reader's paste above proves nothing`);
    if (saves() === s0) fail("a paste in the canvas of the writer made no save");
  }

  // ---- the board goes to another window: the writer is told, and is a reader again; the button takes it back
  {
    await writer("window");
    if (!await until(() => bar.count(), 10000)) fail("the board went to another window and the writer's mark stays");
    else {
      if (!phone && await bar.first().getAttribute("data-role") !== "lost") fail(`the bar's role is ${await bar.first().getAttribute("data-role")}, not lost`);
      if (phone) {
        if (!await until(async () => /Another window took over this board/.test((await byTid(page, "toast", { kind: "board-lost" }).first().textContent().catch(() => "")) ?? ""), 10000)) fail("the board went to another window and the phone shows no toast that it took it over");
        if (!await attrsAre("lost", "window", "taken") || await raw() !== WORDS[LOST][1]) fail(`the board went to another window and the bar's word says "${await raw()}", not "${WORDS[LOST][1]}"`);
      } else if (await barSays() !== LOST) fail(`the board went to another window and the bar says "${await barSays()}", not "${LOST}"`);
      if (!await take.count()) fail("a window that lost the board has no button");
    }
    if (await page.locator(LIVE).count()) fail("the canvas of a window that lost the board can be drawn on");
    await editHere(page);
    if (!await held()) fail("the button did not take the board back");
  }

  // ---- a lost connection takes nothing back: the writer comes back as a reader, and the button is there
  {
    const t0 = takes();
    await mockEval('setServerState("local", "unreachable", { detail: "connection refused" });', url);
    await page.waitForTimeout(500);
    await mockEval('setServerState("local", "connected");', url);
    if (!await until(() => take.count(), 20000)) fail("back from an outage the board has no button (the window is still its writer, or the board is gone)");
    await page.waitForTimeout(800);
    if (takes() !== t0 || await held()) fail(`back from an outage the window took the board by itself (${takes() - t0} takes)`);
    if (await barSays() !== VIEW_ONLY) fail(`back from an outage the bar says "${await barSays()}", not "${VIEW_ONLY}"`);
    if (!await until(() => page.locator(".excalidraw.excalidraw--view-mode").count(), 10000)) fail("back from an outage the board is not in view mode");
  }
  await ctx.close();
  await decoder.close();
  note("a board opened, shown again after a chat and after an outage took nothing and was followed (and unfollowed when left); the bar's texts for nobody, another window and an agent, and \"another window took over\"; "
    + "a shape saved by another writer showed on the reader's canvas without a reload, in the same canvas, with its scroll and zoom; a reader's paste was not written, the same paste by the writer was; the button took");
}, { viewports, page: false, allowConsole: [/^saving board /] });

/** Excalidraw's own clipboard text for one rectangle, pasted into the board's canvas as the browser does: a `paste` event with the text (a DataTransfer). */
async function pasteElement(page, id) {
  const box = await page.locator(".excalidraw canvas.interactive").first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5); // (Excalidraw pastes where the pointer last was, inside its container)
  await page.evaluate((id) => {
    const el = { id, type: "rectangle", x: 20, y: 20, width: 90, height: 60, angle: 0, strokeColor: "#0000c8", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 3, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
    const data = new DataTransfer();
    data.setData("text/plain", JSON.stringify({ type: "excalidraw/clipboard", elements: [el], files: {} }));
    document.querySelector(".excalidraw")?.focus(); // (Excalidraw pastes when the focus is in its container)
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, id);
}

/** The bounds of the pixels of a screenshot that are `color` (green), in CSS pixels, or null (decoded by `decoder`, a page of the browser of its own). */
async function greenBox(page, decoder, color = GREEN) {
  const png = (await page.screenshot({ scale: "css" })).toString("base64");
  return decoder.evaluate(async ([png, green]) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const { data, width, height } = g.getImageData(0, 0, img.width, img.height);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (Math.abs(data[i] - green[0]) < 50 && Math.abs(data[i + 1] - green[1]) < 50 && Math.abs(data[i + 2] - green[2]) < 50) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    }
    return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  }, [png, color]);
}
