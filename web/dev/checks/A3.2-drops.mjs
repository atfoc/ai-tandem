// Proves A3.2: G2's 23 scenarios (G2 §4) with real drags on the seeded tree. After each, nothing is lit (no .drop, no
// .drop-before), and the move happened or not as the scenario says: where every row and group of the sidebar then is,
// and which moves the page asked the server for (a group's place among its siblings is read there: the mock keeps no
// order). Then one more ending, a cancel after the dragged row was removed, and the moves that must land as before
// the one drop mark: a chat and a board into a group, into a subgroup and to the ungrouped area; a group into
// a group and to the top level.
// On the build before the mark, S2, S2c, S2d, S3, S3c, S5, S5b, S8 and S12b fail here: each leaves a group lit.
import { check, dragger, mockEval, openPage, seed, until } from "../shot.mjs";

// The sidebar as it is drawn: the group each row is in ("" ungrouped; rows nested under a board go with
// it and are left out) and the group each group is in ("" at the top level).
const treeOf = (page) => page.evaluate(() => {
  const nameOf = (g) => g?.querySelector(":scope > .side-group-head .side-group-name")?.textContent ?? "";
  const rows = {}, groups = {};
  for (const r of document.querySelectorAll(".side-tree .side-row:not(.nested)")) rows[r.querySelector(".side-name")?.textContent] = nameOf(r.closest(".side-group"));
  for (const g of document.querySelectorAll(".side-tree .side-group")) groups[nameOf(g)] = nameOf(g.parentElement.closest(".side-group"));
  return { rows, groups };
});
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b))));
const same = (a, b) => sorted(a.rows) === sorted(b.rows) && sorted(a.groups) === sorted(b.groups);
const differs = (got, want) => ["rows", "groups"].flatMap((k) => [...new Set([...Object.keys(got[k]), ...Object.keys(want[k])])]
  .filter((n) => got[k][n] !== want[k][n]).map((n) => `${n} is ${got[k][n] === undefined ? "gone" : `in "${got[k][n]}"`}, not ${want[k][n] === undefined ? "gone" : `in "${want[k][n]}"`}`)).join("; ");

// A drag that comes from outside the page (text, a file): the driver's dragger starts its drags on a row.
const TEXT = { items: [{ mimeType: "text/plain", data: "a line of text" }], dragOperationsMask: 1 };
const FILE = { items: [], files: ["/tmp/aiwb-uicheck-notes.txt"], dragOperationsMask: 1 };

await check("A3.2 after every drag nothing is lit, and each move lands", async ({ url, browser, fail, note }) => {
  /** One scenario on a tree seeded anew. body(d, page, from) drives it and answers a line when it could not; then
   *  nothing may be lit, the tree is the seeded one with `to` ({ rows, groups, gone }) and the page asked for the
   *  moves of `asks`, and no other. */
  const run = async (id, what, { to = {}, asks = [] }, body) => {
    await seed(url, "A3"); // the tree as it was made: a scenario before may have moved a chat
    const { ctx, page } = await openPage({ url, browser, size: [1400, 1000] });
    try {
      await page.waitForSelector(".side-name >> text=Chat M");
      const asked = [];
      page.on("request", (r) => {
        const m = /\/api\/(chats|boards|groups)\/([^/?]+)(\/move)?$/.exec(new URL(r.url()).pathname);
        let b = null;
        try { b = r.postDataJSON(); } catch {}
        if (!m || !b) return;
        if (m[1] === "groups" && m[3] && r.method() === "POST") asked.push(`group ${m[2]} into "${b.parent}" before "${b.before}"`);
        else if (m[1] !== "groups" && !m[3] && r.method() === "PATCH" && b.group !== undefined) asked.push(`${m[1].slice(0, -1)} ${m[2]} into "${b.group}"`);
      });
      const d = await dragger(page), was = await treeOf(page);
      const cdp = await page.context().newCDPSession(page);
      const from = { // a drag from outside: enters at p, lingers there, and ends by a drop or a cancel
        async over(data, p) { await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: p.x, y: p.y, data }); for (let i = 0; i < 3; i++) { await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: p.x + i, y: p.y, data }); await d.drawn(); } },
        async end(type, data, p) { await cdp.send("Input.dispatchDragEvent", { type, x: p.x, y: p.y, data }); await d.drawn(); await d.drawn(); },
      };
      const could = await body(d, page, from);
      if (could) return fail(`${id} ${what}: ${could}`);
      // (the handlers empty the mark as the drag ends: the bound is for a machine that draws late)
      const lit = await until(async () => { const l = await d.lit(); return l.length ? null : true; }, 5000) ? [] : await d.lit();
      if (lit.length) fail(`${id} ${what}: ${lit.join(", ")} stayed lit`);
      const want = { rows: { ...was.rows, ...to.rows }, groups: { ...was.groups, ...to.groups } };
      for (const n of to.gone ?? []) delete want.rows[n];
      if (!await until(async () => same(await treeOf(page), want))) fail(`${id} ${what}: ${differs(await treeOf(page), want)}`);
      if (asked.join("; ") !== asks.join("; ")) fail(`${id} ${what}: the page asked for ${asked.length ? asked.join("; ") : "no move"}, not for ${asks.length ? asks.join("; ") : "none"}`);
      note(`${id} ${what}: clean${asked.length ? `; ${asked.join("; ")}` : ""}`);
    } finally { await ctx.close(); }
  };
  const SLOW = "Why is the build slow"; // a chat of Shop's own rows
  const begin = async (d, p, name) => (await d.start(p) ? "" : `the page started no drag for ${name}`);
  /** A drag of a row or a header over the places given, then its ending. */
  const drag = (kind, name, places, ending = "drop") => async (d) => {
    const no = await begin(d, kind === "row" ? await d.row(name) : await d.head(name), `the ${kind === "row" ? "row" : "group"} ${name}`);
    if (no) return no;
    for (const place of places) await d.over(await place(d));
    await d[ending]();
  };
  const row = (name) => (d) => d.row(name), lower = (name) => (d) => d.head(name, 0.3, 0.8), upper = (name) => (d) => d.head(name, 0.3, 0.2);
  const outside = (d) => d.OUTSIDE;
  const sideHead = (page) => page.evaluate(() => { const r = document.querySelector(".side-head .brand").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  const A_TO_SUB = { to: { rows: { "Chat A": "Sub" } }, asks: ['chat c_A3_a into "g_sub"'] };
  const s2 = drag("row", "Chat A", [row(SLOW), row("Chat B")]);

  await run("S1", "a chat dropped on its own group", {}, drag("row", "Chat A", [row(SLOW)]));
  await run("S2", "a chat over Shop, dropped on the subgroup Sub", A_TO_SUB, s2);
  await run("S2b", "an ungrouped chat dropped on Sub, never over Shop's own rows", { to: { rows: { Loose: "Sub" } }, asks: ['chat c_A3_loose into "g_sub"'] }, drag("row", "Loose", [row("Chat B")]));
  await run("S2c", "a chat of Sub over Shop and back, dropped on Sub", {}, drag("row", "Chat B", [row("Chat A"), row("Chat B")]));
  await run("S2d", "an ungrouped chat over Other, over Mid, dropped on Leaf", { to: { rows: { Loose: "Leaf" } }, asks: ['chat c_A3_loose into "g_leaf"'] }, drag("row", "Loose", [row("Chat O"), row("Chat M"), lower("Leaf")]));
  await run("S3", "the group Other over Shop's body, dropped on the upper half of Shop's header", { asks: ['group g_other into "" before "g_shop"'] }, drag("head", "Other", [row("Chat A"), lower("Shop"), upper("Shop")]));
  await run("S3b", "the same, coming from above", { asks: ['group g_other into "" before "g_shop"'] }, drag("head", "Other", [row("Loose"), upper("Shop")]));
  await run("S3c", "the group Leaf over Other and Mid's body, dropped before Mid", { to: { groups: { Leaf: "Other" } }, asks: ['group g_leaf into "g_other" before "g_mid"'] }, drag("head", "Leaf", [row("Chat O"), row("Chat M"), upper("Mid")]));
  await run("S4", "a chat over Shop, released on the page", {}, drag("row", "Chat A", [row(SLOW), outside]));
  await run("S4b", "a chat over Shop, released on the sidebar's head", {}, async (d, page) => drag("row", "Chat A", [row(SLOW), () => sideHead(page)])(d));
  await run("S5", "a chat over Shop, cancelled", {}, drag("row", "Chat A", [row(SLOW)], "cancel"));
  await run("S5b", "a chat over Shop then Sub, cancelled", {}, drag("row", "Chat A", [row(SLOW), row("Chat B")], "cancel"));
  await run("S6", "a chat row nested under a board", {}, async (d) => (await d.start(await d.row("Draw the pipeline")) ? "the page started a drag for a chat nested under a board" : ""));
  await run("S7", "the group Mid over Other, released over its own body", {}, drag("head", "Mid", [row("Chat O"), row("Chat M")]));
  await run("S7b", "the group Shop released over its own subgroup", {}, drag("head", "Shop", [row("Chat B")]));
  await run("S8", "the row under the pointer removed, the next dragover outside the zone", { to: { gone: [SLOW] } }, async (d) => {
    const no = await begin(d, await d.row("Chat A"), "the row Chat A");
    if (no) return no;
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_plain; send({ type: "chat_removed", id: "c_plain" });`, url);
    if (!await until(async () => await d.groupOf(SLOW) === null)) return `the row ${SLOW} is still in the sidebar after its chat was removed`;
    await d.over(d.OUTSIDE); await d.drop();
  });
  await run("S8b", "the dragged row removed during the drag, dropped on Shop", { to: { gone: ["Chat A"] } }, async (d) => {
    const no = await begin(d, await d.row("Chat A"), "the row Chat A");
    if (no) return no;
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_A3_a; send({ type: "chat_removed", id: "c_A3_a" });`, url);
    if (!await until(async () => await d.groupOf("Chat A") === null)) return "the row Chat A is still in the sidebar after its chat was removed";
    await d.over(await d.row(SLOW)); await d.drop();
  });
  await run("S9", "a chat moved to Other by the drop", { to: { rows: { "Chat A": "Other" } }, asks: ['chat c_A3_a into "g_other"'] }, drag("row", "Chat A", [row(SLOW), row("Chat O")]));
  await run("S10", "text from outside, dropped on a group", {}, async (d, page, from) => {
    const p = await d.row("Chat A");
    await from.over(TEXT, p);
    const during = await d.lit();
    await from.end("drop", TEXT, p);
    return during.length ? `${during.join(", ")} lit while text from outside was over Shop` : "";
  });
  await run("S10b", "a file from outside, cancelled over a group", {}, async (d, page, from) => {
    const p = await d.row("Chat B");
    await from.over(FILE, p);
    const during = await d.lit();
    await from.end("dragCancel", FILE, p);
    return during.length ? `${during.join(", ")} lit while a file from outside was over Sub` : "";
  });
  await run("S11", "clicks only", {}, async (d, page) => {
    await d.click(await d.row("Chat A")); await d.click(await d.row("Chat B"));
    await d.click(await d.head("Shop")); await d.click(await d.head("Shop")); // closed, and open again
    if (!await until(async () => await d.groupOf("Chat A") === "Shop")) return "Shop did not open again";
    const chatA = page.locator('.side-row:has(.side-name:text-is("Chat A"))'); // its menu, opened and closed
    await chatA.hover(); await chatA.locator(".side-hover").click();
    await page.waitForSelector(".side-row .menu", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".side-row .menu", { state: "detached", timeout: 5000 });
  });
  await run("S12", "S2, then a second drag that crosses Shop and leaves it", A_TO_SUB, async (d) => (await s2(d)) || drag("row", "Loose", [row(SLOW), outside])(d));
  await run("S12b", "S2, then a second drag that never touches Shop", { to: { rows: { "Chat A": "Sub", Loose: "Other" } }, asks: [...A_TO_SUB.asks, 'chat c_A3_loose into "g_other"'] },
    async (d) => (await s2(d)) || drag("row", "Loose", [row("Chat O")])(d));

  // An ending G2 did not drive: the dragged row removed, and the drag cancelled where S8b drops it. The window hears
  // nothing of it, no dragleave and no end: the removed row hears the end itself.
  await run("S8c", "the dragged row removed during the drag, the drag cancelled over Shop", { to: { gone: ["Chat A"] } }, async (d) => {
    const no = await begin(d, await d.row("Chat A"), "the row Chat A");
    if (no) return no;
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_A3_a; send({ type: "chat_removed", id: "c_A3_a" });`, url);
    if (!await until(async () => await d.groupOf("Chat A") === null)) return "the row Chat A is still in the sidebar after its chat was removed";
    await d.over(await d.row(SLOW));
    if (!(await d.lit()).length) return "nothing is lit over Shop with the dragged row removed: the cancel would have nothing to leave lit";
    await d.cancel();
  });

  // The moves, each landing where it landed before the mark.
  const UNGROUPED = "__ungrouped__";
  await run("M1", "a chat to the ungrouped area", { to: { rows: { "Chat A": "" } }, asks: [`chat c_A3_a into "${UNGROUPED}"`] }, drag("row", "Chat A", [row("Loose")]));
  await run("M2", "a board into a group", { to: { rows: { arch: "Other" } }, asks: ['board b_arch into "g_other"'] }, drag("row", "arch", [row("Chat O")]));
  await run("M3", "a board into a subgroup", { to: { rows: { arch: "Sub" } }, asks: ['board b_arch into "g_sub"'] }, drag("row", "arch", [row("Chat B")]));
  await run("M4", "a board to the ungrouped area", { to: { rows: { arch: "" } }, asks: [`board b_arch into "${UNGROUPED}"`] }, drag("row", "arch", [row("Loose")]));
  await run("M5", "a group into a group, by its body", { to: { groups: { Other: "Shop" } }, asks: ['group g_other into "g_shop" before ""'] }, drag("head", "Other", [row("Chat A")]));
  await run("M6", "a group into a group, by the lower half of its header", { to: { groups: { Leaf: "Shop" } }, asks: ['group g_leaf into "g_shop" before ""'] }, drag("head", "Leaf", [lower("Shop")]));
  await run("M7", "a subgroup to the top level", { to: { groups: { Sub: "" } }, asks: ['group g_sub into "" before ""'] }, drag("head", "Sub", [row("Loose")]));
});
