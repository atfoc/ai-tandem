// The phone half (package H2, chunk 6; goal 3.3) is Home's: the phone has no sidebar, a finger held 0.5 s on a row and lifted opens the row's sheet,
// held and then moved 10 pt it drags the row onto a group row of the screen (lit while it is over it, dropped into it); a finger that moves at once
// scrolls the list or swipes the row and starts no drag. See `phoneHalf` below. The rest of this comment is the wide halves'.
// Proves what the old page's drag and drop never had to say, because the browser made it (S2, AD-70), on the sidebar of a long list: a drag by
// the viewport's pointer works at every viewport (here the tablet's and the desktop's); a finger that moves at once scrolls the list and starts no
// drag, and one that is held first drags and does not scroll it (the window sees no pointercancel); a long press that moves nowhere opens nothing, and the
// press that follows a drag opens its row; a mouse that moves a few pixels is still a click, and one that moves farther on its own row starts a drag that
// opens nothing; a row in rename mode is not dragged; the label under the pointer names what is dragged and the dragged row is dimmed; a pointer held near
// the top or the bottom of the list scrolls it. New check (no old one): the B-rows of the drag that no browser check could see: A-DD-01, A-DD-02 (touch),
// A-DD-06, A-DD-09, with the touch halves of the rows the Note for the app names.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, openMenu, pointerDragger, press, showList, touchDrag, touchNow } from "./sel.mjs";
import { dragReader } from "./drag.mjs";
import { rowNamed } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

/** The phone's Home, on Studio Mac of the seed UXH1: every scene opens a page of its own, on the server as the seed made it (a drop changes the server's
 *  tree, so the scenes that drop come last), and closes it. */
async function phoneHalf({ url, open, fail, note }) {
  const STUDIO = "h1_studio", J = JSON.stringify;
  const ls = { "aiwb.uicheck.nolocal": "1", "aiwb.home": J({ server: STUDIO, groups: [] }) };
  await seed(url, "UXH1");
  const seen = [];
  /** A page on Home, the studio server only (the fillers: more chats than a screen holds, for a list that scrolls). */
  const scene = async (name, body, { fillers = 0 } = {}) => {
    const bad = (line) => fail(`${name}: ${line}`);
    await mockEval(`uxh1Show(${J([STUDIO])}); onServer(${J(STUDIO)}, () => { for (let i = 0; i < ${fillers}; i++) { const id = "c_L14_" + i; chats[id] = chat(id, { name: "Filler " + i, group: UNGROUPED, cwd: "/Users/studio/work" }); items[id] = []; } });`, url);
    const o = await open({ ls, wait: "" });
    const { page } = o;
    try {
      await byTid(page, "home-row", { key: `${STUDIO}~g_infra` }).first().waitFor({ state: "visible", timeout: 20000 });
      await page.waitForTimeout(300);
      const calls = callsOf(page);
      const writes = () => calls.filter((c) => c.method !== "GET");
      const row = (kind, text) => byTid(page, "home-row", { kind }).filter({ hasText: text }).first();
      const place = (key) => byTid(page, "home-row-place", { key: `${STUDIO}~${key}` }).first();
      const ghost = () => byTid(page, "drag-ghost").count();
      const sheet = () => byTid(page, "row-sheet").first();
      const sheetShown = (ms = 5000) => sheet().waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
      /** The list's scroll: the nearest scrolling element above Home's list. */
      const top = () => byTid(page, "home-list").first().evaluate((e) => { for (let n = e.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n.scrollTop; return 0; });
      await body({ page, bad, calls, writes, row, place, ghost, sheet, sheetShown, top });
    } catch (e) { bad(String(e.message).split("\n")[0]); }
    await o.ctx.close();
  };
  // ---- a finger held 0.5 s opens nothing while it is held, and the sheet when it is lifted
  await scene("hold and lift", async ({ page, bad, writes, row, ghost, sheetShown, sheet }) => {
    const d = await pointerDragger(page, { hold: 700, steps: 6 });
    await d.start(row("chat", "Rename the env vars"));
    if (await sheet().isVisible()) bad("the sheet opened while the finger was still down: it opens on the release");
    if (await ghost()) bad("a held finger that moved nowhere started a drag");
    await d.end();
    if (!await sheetShown()) bad("a finger held 0.5 s and lifted opened no row sheet (row-sheet)");
    if (await ghost()) bad("a drag label is drawn after a hold and a lift");
    if (writes().length) bad(`a hold and a lift made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  });

  // ---- held, moved 6 pt (under the 10): still no drag, the sheet on the lift; held, moved 14 pt: a drag; back to where it was and lifted over no group: no sheet, no call
  await scene("a small move and a large one", async ({ page, bad, writes, row, ghost, sheetShown }) => {
    const r = row("chat", "Rename the env vars"), b = await r.boundingBox();
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const d = await pointerDragger(page, { hold: 700, steps: 4 });
    await d.start(at);
    await d.move({ x: at.x, y: at.y + 6 });
    if (await ghost()) bad("a move of 6 pt after the hold started a drag");
    await d.end();
    if (!await sheetShown()) bad("a move of 6 pt after the hold, lifted, opened no row sheet");
  });
  await scene("a move past 10 pt", async ({ page, bad, writes, row, ghost, sheet, sheetShown }) => {
    const r = row("chat", "Rename the env vars"), b = await r.boundingBox();
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const d = await pointerDragger(page, { hold: 700, steps: 4 });
    await d.start(at);
    await d.move({ x: at.x, y: at.y + 14 });
    if (!await until(async () => (await ghost()) > 0, 5000)) bad("a move of 14 pt after the hold started no drag (no label)");
    else if (!(await byTid(page, "drag-ghost").first().textContent()).includes("Rename the env vars")) bad("the label does not name the row dragged");
    if (!(Number(await r.evaluate((e) => getComputedStyle(e).opacity)) < 0.9)) bad("the row dragged is not dimmed");
    await d.end();
    await page.waitForTimeout(500);
    if (await sheet().isVisible()) bad("the sheet opened after a drag that ended over no group");
    if (await ghost()) bad("the label stays after the drop");
    if (writes().length) bad(`a drag released over no group made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  });

  // ---- a finger that moves at once scrolls the list (and starts no drag); one that moves sideways at once swipes the row
  await scene("a move at once", async ({ page, bad, writes, row, ghost, sheet, top }) => {
    const r = row("chat", "Rename the env vars"), b = await r.boundingBox();
    const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    const start = await top();
    await touchDrag(page, at, { x: at.x, y: at.y - 160 }, { hold: 0, steps: 12 });
    if (!await until(async () => (await top()) > start + 40, 10000)) bad(`a finger that moved at once did not scroll the list (${start} → ${await top()})`);
    if (await ghost()) bad("a finger that moved at once started a drag");
    if (await sheet().isVisible()) bad("a finger that moved at once opened the row sheet");
    if (writes().length) bad(`a scroll made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  }, { fillers: 14 });
  await scene("a swipe", async ({ page, bad, writes, row, ghost, sheet }) => {
    const r = row("board", "Onboarding flow"), b = await r.boundingBox();
    const at = { x: b.x + b.width - 40, y: b.y + b.height / 2 };
    await touchDrag(page, at, { x: at.x - 200, y: at.y }, { hold: 0, steps: 12 });
    if (!await until(async () => (await byTid(page, "swipe-action").count()) > 0, 5000)) bad("a quick sideways move on a row showed no swipe buttons");
    if (await ghost()) bad("a quick sideways move started a drag");
    if (await sheet().isVisible()) bad("a quick sideways move opened the row sheet");
    if (writes().length) bad(`a swipe made the calls ${J(writes().map((c) => `${c.method} ${c.path}`))}`);
  });

  // ---- held and moved onto a group row: the row is lit while the finger is over it; the lift drops the item into the group
  const into = async (name, kind, text, group, groupName, expect, after) => scene(name, async ({ page, bad, writes, row, place, ghost, sheet, calls }) => {
    const target = place(group);
    const d = await pointerDragger(page, { hold: 700, steps: 10 });
    await d.start(row(kind, text));
    await d.move(target);
    if (!await until(async () => (await target.getAttribute("data-drop")) === "true", 5000)) bad(`the group row "${groupName}" is not lit while the finger is over it`);
    if (await sheet().isVisible()) bad("the sheet opened during the drag");
    const shot = process.env.SHOTS;
    if (shot) await page.screenshot({ path: `${shot}/${name.replace(/\W+/g, "-")}.png` });
    await d.end();
    if (!await until(() => writes().some(expect), 8000)) bad(`the lift made the calls ${J(writes().map((c) => `${c.method} ${c.path} ${J(c.body)}`))}, not ${what(expect)}`);
    if (await target.getAttribute("data-drop")) bad(`the group row "${groupName}" stays lit after the drop`);
    if (await sheet().isVisible()) bad("the sheet opened after the drop");
    await after({ page, bad, row });
  });
  const what = (f) => String(f).replace(/\s+/g, " ");
  await into("a chat dropped on a group", "chat", "Rename the env vars", "g_infra", "Infra",
    (c) => c.method === "PATCH" && /c_rename$/.test(c.path) && /g_infra/.test(JSON.stringify(c.body)),
    async ({ page, bad, row }) => {
      if (!await until(async () => (await row("chat", "Rename the env vars").count()) === 0, 8000)) bad("the chat is still on Home after it was dropped into Infra");
      await press(page, row("group", "Infra"));
      await byTid(page, "group-screen", { key: `${STUDIO}~g_infra` }).last().waitFor({ state: "visible", timeout: 10000 });
      if (!await until(async () => (await byTid(page, "group-screen").last().getByText("Rename the env vars").count()) > 0, 8000)) bad("Infra's screen does not list the chat dropped into it");
    });
  await into("a group dropped on a group", "group", "Mobile app", "g_infra", "Infra",
    (c) => c.method === "POST" && /\/groups\/g_mobile\/move$/.test(c.path) && c.body?.parent === "g_infra",
    async ({ bad, row }) => {
      if (!await until(async () => (await row("group", "Mobile app").count()) === 0, 8000)) bad("the group Mobile app is still on Home after it was dropped into Infra");
    });
  note("a hold and a lift opens the sheet, a move of 6 pt still does, a move past 10 pt drags, a move at once scrolls or swipes, a drop on a group row moves the chat and the group into it");
}

await check("L14 a drag by the pointer of each viewport: scroll and drag apart, the label, the edges of the list", async ({ url, open, fail, note, viewport }) => {
  if (viewport === "phone") return phoneHalf({ url, open, fail, note });
  await seed(url, "A3");
  // a long list: forty chats with no group, below the seed's tree
  await mockEval(`for (let i = 0; i < 40; i++) { const id = "c_L14_" + i; chats[id] = chat(id, { name: "Filler " + (i < 10 ? "0" : "") + i, group: UNGROUPED }); items[id] = []; }`, url);
  const { page } = await open({ wait: '[data-testid="side-tree"]' });
  await showList(page);
  await byTid(page, "side-name").filter({ hasText: "Filler 39" }).first().waitFor({ state: "attached", timeout: 15000 });
  const touch = await touchNow(page);
  const calls = callsOf(page);
  const writes = () => calls.filter((c) => c.method !== "GET");
  const tree = byTid(page, "side-tree").first();
  const top = () => tree.evaluate((e) => e.scrollTop);
  const box = () => tree.boundingBox();
  const sel = () => page.evaluate(() => localStorage.getItem("aiwb.sel"));
  /** The list has stopped moving (a swipe leaves a fling: a finger put down on it then is the fling's stop, and its moves cannot be cancelled). */
  const still = async () => { let last = -1, n = 0; await until(async () => { const y = await top(); n = y === last ? n + 1 : 0; last = y; return n >= 16 || null; }, 10000); };
  const d = await dragReader(page);
  await page.evaluate(() => { window.__seen = []; for (const t of ["pointercancel"]) window.addEventListener(t, () => window.__seen.push(t), true); });
  const seen = () => page.evaluate(() => window.__seen.length);

  // ---- a drag works here: a chat dropped on the subgroup Sub
  if (!await d.start(await d.row("Chat A"))) return fail("A: the page started no drag for the row Chat A");
  await d.over(await d.row("Chat B"));
  if (!await until(async () => (await d.lit()).join() === "group(Sub).drop [VISIBLE]", 5000)) fail(`A: over a row of Sub "${(await d.lit()).join()}" is lit, not Sub alone`);
  await d.drop();
  if (!await until(async () => await d.groupOf("Chat A") === "Sub")) fail(`A: Chat A is in "${await d.groupOf("Chat A")}" after the drop, not in Sub`);
  if (!await until(() => writes().some((c) => c.method === "PATCH" && c.path === "/api/chats/c_A3_a" && c.body?.group === "g_sub"))) fail(`A: the page made the calls ${JSON.stringify(writes().map((c) => `${c.method} ${c.path}`))}, not the move of Chat A into g_sub`);

  // ---- the label names what is dragged, follows the pointer, and the dragged row is dimmed
  if (!await d.start(await d.row("Filler 05"))) return fail("B: the page started no drag for the row Filler 05");
  const p = await d.row("Filler 07");
  await d.over(p);
  const ghost = byTid(page, "drag-ghost").first(), g = await ghost.boundingBox();
  if (!g) fail("B: no label is drawn while a row is dragged");
  else {
    if (!(await ghost.textContent()).includes("Filler 05")) fail(`B: the label says "${await ghost.textContent()}", not the dragged row's name`);
    if (Math.abs(g.x - (p.x + 12)) > 6 || Math.abs(g.y - (p.y + 8)) > 6) fail(`B: the label is at (${Math.round(g.x)}, ${Math.round(g.y)}), not by the pointer at (${Math.round(p.x)}, ${Math.round(p.y)})`);
  }
  const dim = await rowNamed(page, "Filler 05").evaluate((e) => Number(getComputedStyle(e).opacity));
  if (!(dim < 0.9)) fail(`B: the dragged row is drawn with opacity ${dim}, not dimmed`);
  await d.cancel();
  if (await byTid(page, "drag-ghost").count()) fail("B: the label stays after the drag was cancelled");
  if (await rowNamed(page, "Filler 05").evaluate((e) => Number(getComputedStyle(e).opacity)) < 0.99) fail("B: the row stays dimmed after the drag was cancelled");

  // ---- the edges of the list: a pointer held there scrolls it
  const b = await box(), c0 = await seen();
  if (!await d.start(await d.row("Filler 10"))) return fail("C: the page started no drag for the row Filler 10");
  const before = await top(); // (the row was brought to the middle of the list first)
  await d.over({ x: b.x + b.width / 2, y: b.y + b.height - 8 });
  const down = await until(async () => (await top()) > before + 40, 15000);
  if (!down) fail(`C: the list did not scroll down with the pointer held at its bottom edge (${before} → ${await top()})`);
  const low = await top();
  await d.over({ x: b.x + b.width / 2, y: b.y + 8 });
  if (!await until(async () => (await top()) < low - 40, 15000)) fail(`C: the list did not scroll up with the pointer held at its top edge (${low} → ${await top()})`);
  await d.over({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const rest = await top();
  await page.waitForTimeout(600);
  if (await top() !== rest) fail(`C: the list went on scrolling with the pointer in its middle (${rest} → ${await top()})`);
  if (touch && await seen() !== c0) fail("C: the window saw a pointercancel while the list scrolled under a held finger");
  await d.cancel();
  await tree.evaluate((e) => { e.scrollTop = 0; });

  // ---- a row in rename mode is not dragged
  const row = rowNamed(page, "Filler 02");
  await hover(page, row);
  await openMenu(page, row.locator('[data-testid="side-more"]'), "Rename");
  const input = byTid(page, "name-input").first();
  await input.waitFor({ state: "visible", timeout: 10000 });
  if (await d.start(await d.at(input, 0.2, 0.5), { none: true })) { fail("D: the page started a drag for a row in rename mode"); await d.cancel(); }
  await page.keyboard.press("Escape");
  await until(async () => !await byTid(page, "name-input").count(), 5000);

  if (touch) {
    // ---- a finger that moves at once scrolls the list and starts no drag
    const start = await top(), p0 = await d.row("Filler 12"), s0 = await sel();
    await touchDrag(page, p0, { x: p0.x, y: p0.y - 160 }, { hold: 0, steps: 12 });
    if (!await until(async () => (await top()) > start + 40, 10000)) fail(`E: a finger that moved at once did not scroll the list (${start} → ${await top()})`);
    if (await byTid(page, "drag-ghost").count()) fail("E: a finger that moved at once started a drag");
    if ((await d.lit()).length) fail(`E: ${(await d.lit()).join()} lit after a swipe`);
    if (await sel() !== s0) fail("E: a swipe on a row opened it");
    if (writes().some((c) => /Filler|c_L14/.test(c.path))) fail("E: a swipe made a call about a filler row");

    // ---- a finger held first drags and does not scroll the list
    await still();
    const at = await top(), h = await d.row("Filler 14");
    const cancelsBefore = await seen();
    if (!await d.start(h)) return fail("F: the page started no drag for a held finger");
    await d.over({ x: h.x, y: h.y + 90 });
    await d.over({ x: h.x, y: h.y - 60 });
    if (Math.abs(await top() - at) > 2) fail(`F: the list scrolled (${at} → ${await top()}) under a finger that dragged a row`);
    if (await seen() !== cancelsBefore) fail("F: the window saw a pointercancel in mid-drag: the page took the touch for a scroll");
    await d.cancel();

    // ---- a long press that moves nowhere opens nothing, and the tap after a drag opens its row
    const s1 = await sel(), h2 = await d.row("Filler 16");
    await d.start(h2).catch(() => {});
    await d.drop();
    if (await sel() !== s1) fail("G: a long press that moved nowhere opened the row");
    if ((await d.lit()).length) fail(`G: ${(await d.lit()).join()} lit after a long press`);
    await press(page, rowNamed(page, "Filler 17"));
    if (!await until(async () => (await sel()) !== s1, 10000)) fail("G: a tap right after a drag opened nothing");
  } else {
    // ---- a mouse that moves a few pixels is a click; one that moves farther on its own row drags and opens nothing
    const s0 = await sel(), r0 = await d.row("Filler 12");
    await page.mouse.move(r0.x, r0.y); await page.mouse.down(); await page.mouse.move(r0.x + 2, r0.y + 1); await page.mouse.up();
    if (!await until(async () => (await sel()) !== s0, 10000)) fail("E: a click with a shake of 2 px did not open the row");
    const s1 = await sel(), r1 = await d.row("Filler 14");
    if (!await d.start({ x: r1.x - 30, y: r1.y })) return fail("F: the page started no drag for a mouse that moved on its own row");
    await d.over({ x: r1.x + 30, y: r1.y + 2 });
    await d.drop();
    await page.waitForTimeout(500);
    if (await sel() !== s1) fail("F: a drag that ended on the row it began on opened it");
    if (writes().some((c) => /c_L14_14/.test(c.path))) fail("F: a drag that ended on its own row made a call");
    await press(page, rowNamed(page, "Filler 15"));
    if (!await until(async () => (await sel()) !== s1, 10000)) fail("G: a click right after a drag opened nothing");
  }
  note(`${touch ? "finger" : "mouse"}: a drag, its label and dimmed row, the list scrolled at both edges, ${touch ? "a swipe that scrolls, a hold that drags, a long press that opens nothing" : "a shake that clicks, a drag on its own row that opens nothing"}`);
}, { viewports, page: false });
