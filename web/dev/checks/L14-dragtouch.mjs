// Proves what the old page's drag and drop never had to say, because the browser made it (S2, AD-70), on the sidebar of a long list: a drag by
// the viewport's pointer works at every viewport (the phone's sidebar is its first screen); a finger that moves at once scrolls the list and starts no
// drag, and one that is held first drags and does not scroll it (the window sees no pointercancel); a long press that moves nowhere opens nothing, and the
// press that follows a drag opens its row; a mouse that moves a few pixels is still a click, and one that moves farther on its own row starts a drag that
// opens nothing; a row in rename mode is not dragged; the label under the pointer names what is dragged and the dragged row is dimmed; a pointer held near
// the top or the bottom of the list scrolls it. New check (no old one): the B-rows of the drag that no browser check could see: A-DD-01, A-DD-02 (touch),
// A-DD-06, A-DD-09, with the touch halves of the rows the Note for the app names.
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, hover, openMenu, press, showList, touchDrag, touchNow } from "./sel.mjs";
import { dragReader } from "./drag.mjs";
import { rowNamed } from "./side.mjs";

export const viewports = ["desktop", "tablet", "phone"];

await check("L14 a drag by the pointer of each viewport: scroll and drag apart, the label, the edges of the list", async ({ url, open, fail, note }) => {
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
