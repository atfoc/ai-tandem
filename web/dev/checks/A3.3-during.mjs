// Proves A3.3: during a real drag the innermost zone under the pointer is lit, it alone, and stays lit while the
// pointer moves in it: in every painted frame, and with no class of the tree changed between them, so the rule that
// empties the mark on a pointer event does not fire in mid-drag (a browser sends pointercancel and pointerout right
// after dragstart; the check prints the events the window saw). Then what a drag shows on its way: the line before a
// header in place of the zone, and the zone again on the header's lower half; nothing where a group is refused, also
// inside a zone that was lit; nothing once the pointer is outside every zone, though the row it was on was removed
// and its dragleave lost; and a group that still lands after a pointer move and a key reached the page in mid-drag
// (sent by the check: the driven browser sends none). A drag whose end is lost to the window with its row lights
// nothing once it has ended: the removed row itself hears the end. Last, the rule for an end that reaches nobody: a
// row dragged in from another window of the app, cancelled there, leaves a zone lit until the pointer moves.
import { check, dragger, mockEval, openPage, sampleFrames, seed, until } from "../shot.mjs";

/** In the page, per painted frame: what is lit, by name ("Shop", "loose", "before Shop"). */
function litProbe() {
  const nameOf = (g) => g?.querySelector(":scope > .side-group-head .side-group-name")?.textContent;
  return { lit: [...document.querySelectorAll(".drop, .drop-before")].map((e) => (e.classList.contains("drop-before") ? "before " + nameOf(e.parentElement) : e.classList.contains("side-loose") ? "loose" : nameOf(e))).join(", ") };
}

await check("A3.3 the innermost zone stays lit while the pointer moves in it", async ({ url, browser, fail, note }) => {
  const SLOW = "Why is the build slow"; // a chat of Shop's own rows
  const open = async (body) => {
    await seed(url, "A3");
    const { ctx, page } = await openPage({ url, browser, size: [1400, 1000] });
    try {
      await page.waitForSelector(".side-name >> text=Chat M");
      // every event the window sees, captured, and every change of a class in the tree
      await page.evaluate(() => {
        window.__seen = []; window.__flips = 0;
        for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "pointerout", "keydown", "dragstart", "dragover", "drop", "dragend"])
          window.addEventListener(t, () => { const l = window.__seen; if (l[l.length - 1] !== t) l.push(t); }, true);
        new MutationObserver((l) => { window.__flips += l.length; }).observe(document.querySelector(".side-tree"), { subtree: true, attributes: true, attributeFilter: ["class"] });
      });
      await body(await dragger(page), page);
    } finally { await ctx.close(); }
  };
  const visible = async (d) => (await d.lit()).join(", ");
  /** The pointer moves through `points` while `want` must be lit: in each frame, with no class changed. */
  const moving = async (d, page, name, want, points) => {
    await page.evaluate(() => { window.__flips = 0; });
    const frames = await sampleFrames(page, litProbe);
    for (const p of points) await d.over(p);
    const { values } = await frames.stop(), other = values.filter((v) => v.lit !== want), flips = await page.evaluate(() => window.__flips);
    if (values.length < points.length) fail(`${name}: ${values.length} frames were seen for ${points.length} moves of the pointer`);
    if (other.length) fail(`${name}: ${other.length} of ${values.length} frames had "${other[0].lit}" lit, not "${want}"`);
    if (flips) fail(`${name}: ${flips} changes of a class in the tree while the pointer moved inside "${want}"`);
    return values.length;
  };
  const around = (p) => [p, { x: p.x - 40, y: p.y - 6 }, { x: p.x + 50, y: p.y + 7 }, { x: p.x + 10, y: p.y - 8 }];

  await open(async (d, page) => { // a chat: over its group, then in the subgroup
    if (!await d.start(await d.row("Chat A"))) return fail("chat: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`chat: over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    const inShop = await moving(d, page, "chat in Shop", "Shop", [...around(await d.row(SLOW)), ...around(await d.row("arch")), await d.head("Shop", 0.3, 0.3), await d.head("Shop", 0.3, 0.8)]);
    await d.over(await d.row("Chat B"));
    if (await visible(d) !== "group(Sub).drop [VISIBLE]") fail(`chat: over a row of Sub "${await visible(d)}" is lit, not Sub alone`);
    const inSub = await moving(d, page, "chat in Sub", "Sub", [...around(await d.row("Chat B")), await d.head("Sub", 0.3, 0.3), await d.head("Sub", 0.5, 0.8), ...around(await d.row("Chat B"))]);
    const seen = await page.evaluate(() => window.__seen);
    note(`chat: ${inShop} frames in Shop and ${inSub} in Sub, each with that zone alone lit; the window saw ${seen.join(" > ")}`);
    const drag = seen.slice(seen.indexOf("dragstart") + 1);
    for (const t of ["pointerdown", "pointermove", "keydown"]) if (drag.includes(t)) fail(`chat: the window saw ${t} in mid-drag`);
    if (!drag.includes("pointercancel")) note("chat: (the browser sent no pointercancel after dragstart: the measured order was not this drag's)");
    await d.drop();
    if (!await until(async () => await d.groupOf("Chat A") === "Sub")) fail(`chat: Chat A is in "${await d.groupOf("Chat A")}" after the drop, not in Sub`);
    if (await visible(d)) fail(`chat: ${await visible(d)} stayed lit after the drop`);
  });

  await open(async (d, page) => { // a group: a zone, the line before a header, a refusal, and events of the pointer and the keys in mid-drag
    if (!await d.start(await d.head("Other"))) return fail("group: the page started no drag for the group Other");
    await d.over(await d.row("Chat A"));
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`group: over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    const inShop = await moving(d, page, "group in Shop", "Shop", [...around(await d.row("Chat A")), ...around(await d.row(SLOW)), await d.head("Shop", 0.3, 0.8)]);
    await d.over(await d.head("Shop", 0.3, 0.2));
    if (await visible(d) !== "head(Shop).drop-before [VISIBLE]") fail(`group: on the upper half of Shop's header "${await visible(d)}" is lit, not the line before Shop alone`);
    const onHead = await moving(d, page, "group before Shop", "before Shop", [await d.head("Shop", 0.2, 0.2), await d.head("Shop", 0.6, 0.3), await d.head("Shop", 0.4, 0.1)]);
    await d.over(await d.head("Shop", 0.3, 0.8));
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`group: from the upper to the lower half of Shop's header "${await visible(d)}" is lit, not Shop alone`);
    await d.over(await d.row("Chat B"));
    if (await visible(d) !== "group(Sub).drop [VISIBLE]") fail(`group: over a row of Sub "${await visible(d)}" is lit, not Sub alone`);
    note(`group: ${inShop} frames in Shop, ${onHead} on the upper half of its header, each with that alone lit`);
    for (const [type, send] of [["pointermove", () => document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }))], ["keydown", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }))]]) {
      await d.over(await d.row("Chat A"));
      if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`group: back over a row of Shop "${await visible(d)}" is lit, not Shop`);
      await page.evaluate(send); await d.drawn();
      if (await visible(d)) fail(`group: "${await visible(d)}" stayed lit after a ${type} reached the page`);
    }
    await d.over(await d.row("Chat A"));
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`group: after a pointermove and a keydown in mid-drag "${await visible(d)}" is lit over Shop: the dragged group was lost`);
    await d.drop();
    if (!await until(async () => await d.parentOf("Other") === "Shop")) fail(`group: Other is in "${await d.parentOf("Other")}" after the drop, not in Shop`);
    if (await visible(d)) fail(`group: ${await visible(d)} stayed lit after the drop`);
  });

  await open(async (d) => { // a group that cannot go where the pointer is lights nothing, also inside a zone that was lit
    if (!await d.start(await d.head("Mid"))) return fail("refused: the page started no drag for the group Mid");
    const over = async (name, p, want) => {
      await d.over(p);
      if (await visible(d) !== want) fail(`refused: with Mid over ${name} "${await visible(d)}" is lit, not ${want ? "Other alone" : "nothing: Mid cannot go there"}`);
    };
    await over("a row of Other", await d.row("Chat O"), "group(Other).drop [VISIBLE]");
    await over("its own row, inside Other", await d.row("Chat M"), "");
    await over("a row of Other again", await d.row("Chat O"), "group(Other).drop [VISIBLE]");
    await over("the upper half of its own header", await d.head("Mid", 0.3, 0.2), "");
    await over("a row of Other once more", await d.row("Chat O"), "group(Other).drop [VISIBLE]");
    await over("the upper half of its subgroup's header", await d.head("Leaf", 0.3, 0.2), "");
    await over("the lower half of its subgroup's header", await d.head("Leaf", 0.3, 0.8), "");
    await d.drop();
    if (await d.parentOf("Mid") !== "Other" || await d.parentOf("Leaf") !== "Mid") fail(`refused: after a release on its own subgroup Mid is in "${await d.parentOf("Mid")}" and Leaf in "${await d.parentOf("Leaf")}"`);
    if (await visible(d)) fail(`refused: ${await visible(d)} stayed lit after the release`);
    note("refused: Other lit while Mid was over its rows, nothing lit over Mid's own rows and headers");
  });

  await open(async (d) => { // the row under the pointer removed: its dragleave is lost, and the pointer then outside every zone
    if (!await d.start(await d.row("Chat A"))) return fail("lost leave: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_plain; send({ type: "chat_removed", id: "c_plain" });`, url);
    if (!await until(async () => await d.groupOf(SLOW) === null)) return fail(`lost leave: the row ${SLOW} is still in the sidebar after its chat was removed`);
    await d.over(d.OUTSIDE);
    if (await visible(d)) fail(`lost leave: ${await visible(d)} is lit while the pointer is outside every zone, the drag still going`);
    else note("lost leave: nothing lit with the pointer outside every zone, after the row under it was removed");
    await d.drop();
  });

  await open(async (d, page) => { // the end of a drag lost to the window with the dragged row: the row itself hears it
    if (!await d.start(await d.row("Chat A"))) return fail("lost end: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_A3_a; send({ type: "chat_removed", id: "c_A3_a" });`, url);
    if (!await until(async () => await d.groupOf("Chat A") === null)) return fail("lost end: the row Chat A is still in the sidebar after its chat was removed");
    await d.over(await d.row(SLOW));
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`lost end: with the dragged row removed "${await visible(d)}" is lit over a row of Shop, not Shop alone`);
    await page.evaluate(() => { window.__seen = []; });
    await d.cancel();
    // (the precondition is the browser's: it gives the end to the removed row alone, and no dragleave)
    const heard = (await page.evaluate(() => window.__seen)).includes("dragend");
    if (await visible(d)) fail(`lost end: ${await visible(d)} stayed lit after the cancel, with no move of the pointer`);
    else note(`lost end: nothing lit after a cancel ${heard ? "(the window heard the drag's end: it was not lost)" : "whose end the window did not hear: the removed row heard it"}`);
  });

  await open(async (d, page) => { // the rule itself: a row dragged in from another window of the app has no element here to hear its end
    const cdp = await page.context().newCDPSession(page), p = await d.row(SLOW);
    const data = { items: [{ mimeType: "text/x-aiwb", data: "chat:c_A3_loose" }], dragOperationsMask: 16 };
    await cdp.send("Input.dispatchDragEvent", { type: "dragEnter", x: p.x, y: p.y, data });
    for (let i = 0; i < 3; i++) { await cdp.send("Input.dispatchDragEvent", { type: "dragOver", x: p.x + i, y: p.y, data }); await d.drawn(); }
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") return fail(`another window: with its row over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    await cdp.send("Input.dispatchDragEvent", { type: "dragCancel", x: p.x, y: p.y, data });
    await d.drawn(); await d.drawn();
    // (the precondition is the driven browser's: its cancel is the source's alone, and this page is not the source)
    if (await visible(d) !== "group(Shop).drop [VISIBLE]") return note(`another window: (not tried: after the cancel "${await visible(d)}" is lit, the end was not lost)`);
    await page.mouse.move(p.x + 30, p.y + 4); await d.drawn();
    if (await visible(d)) fail(`another window: ${await visible(d)} stayed lit after the pointer moved`);
    else note("another window: Shop stayed lit after a cancel that reached nobody, until the pointer moved");
  });
});
