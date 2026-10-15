// Proves A3.3: during a real drag the innermost zone under the pointer is lit, it alone, and stays lit while the pointer moves in it: in every painted
// frame, and with no change of the mark between them (no zone and no header changes what it says while the pointer moves inside one). Then what a
// drag shows on its way: the line before a header in place of the zone, and the zone again on the header's lower half; nothing where a group is
// refused, also inside a zone that was lit; nothing once the pointer is outside every zone, though the row it was on was removed; and a group that
// still lands after a pointer move and a key that reached the page in mid-drag (sent by the check). The window sees no pointercancel in mid-drag (a
// finger that scrolled the list instead of dragging would give one).
// Ports dev/checks/A3.3-during.mjs (S2) to the new build, at the desktop (a mouse) and the tablet (a finger held first): A-DD-03, A-DD-04, A-DD-07,
// A-DD-11. Deviations: the drag is a pointer gesture (AD-70), driven by `dragReader` of drag.mjs. A drag whose end is lost to the window, and one from
// another window of the app (A-DD-10), are of HTML drag and drop, which the app no longer has: the pointer gesture ends with the row it began on, so
// the "lost end" scene is the dragged row removed in mid-drag, after which nothing is lit and the next drag works; the "another window" scene is not
// ported. A pointermove or a key the page makes up is not the user's: it does not move the drag (the old rule that it empties the mark has no
// counterpart), and the group still lands.
import { check, mockEval, sampleFrames, seed, until } from "../shot.mjs";
import { byTid, showList } from "./sel.mjs";
import { dragReader } from "./drag.mjs";

export const viewports = ["desktop", "tablet"];

/** In the page, per painted frame: what is lit, by name ("Shop", "loose", "before Shop"). */
function litProbe() {
  const nameOf = (g) => g?.querySelector("[data-testid=side-group-head] [data-testid=side-group-name]")?.textContent;
  return { lit: [...document.querySelectorAll("[data-drop=true], [data-drop-before=true]")].map((e) => (e.dataset.dropBefore === "true" ? "before " + nameOf(e.closest("[data-testid=side-group]")) : e.dataset.testid === "side-loose" ? "loose" : nameOf(e))).join(", ") };
}

await check("A3.3 the innermost zone stays lit while the pointer moves in it", async ({ url, open, fail, note }) => {
  const SLOW = "Why is the build slow"; // a chat of Shop's own rows
  const run = async (body) => {
    await seed(url, "A3");
    const { ctx, page } = await open({ wait: '[data-testid="side-tree"]' });
    try {
      await showList(page);
      await byTid(page, "side-name").filter({ hasText: "Chat M" }).first().waitFor({ state: "attached", timeout: 15000 });
      // every event the window sees, captured, and every change of the mark in the tree
      await page.evaluate(() => {
        window.__seen = []; window.__flips = 0;
        for (const t of ["pointerdown", "pointermove", "pointerup", "pointercancel", "keydown"])
          window.addEventListener(t, () => { const l = window.__seen; if (l[l.length - 1] !== t) l.push(t); }, true);
        new MutationObserver((l) => { window.__flips += l.length; }).observe(document.querySelector("[data-testid=side-tree]"), { subtree: true, attributes: true, attributeFilter: ["data-drop", "data-drop-before"] });
      });
      await body(await dragReader(page, { steps: 1 }), page); // (the pointer jumps from place to place, as the old check's drag events did: the line between two places crosses others)
    } finally { await ctx.close(); }
  };
  const visible = async (d) => (await d.lit()).join(", ");
  /** The pointer moves through `points` while `want` must be lit: in each frame, with no change of the mark. */
  const moving = async (d, page, name, want, points) => {
    await page.evaluate(() => { window.__flips = 0; });
    const frames = await sampleFrames(page, litProbe);
    for (const p of points) await d.over(p);
    const { values } = await frames.stop(), other = values.filter((v) => v.lit !== want), flips = await page.evaluate(() => window.__flips);
    if (values.length < points.length) fail(`${name}: ${values.length} frames were seen for ${points.length} moves of the pointer`);
    if (other.length) fail(`${name}: ${other.length} of ${values.length} frames had "${other[0].lit}" lit, not "${want}"`);
    if (flips) fail(`${name}: ${flips} changes of the mark in the tree while the pointer moved inside "${want}"`);
    return values.length;
  };
  const around = (p) => [p, { x: p.x - 40, y: p.y - 6 }, { x: p.x + 50, y: p.y + 7 }, { x: p.x + 10, y: p.y - 8 }];
  const settled = async (d, want) => { await until(async () => await visible(d) === want, 5000); return visible(d); };

  await run(async (d, page) => { // a chat: over its group, then in the subgroup
    if (!await d.start(await d.row("Chat A"))) return fail("chat: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`chat: over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    const inShop = await moving(d, page, "chat in Shop", "Shop", [...around(await d.row(SLOW)), ...around(await d.row("arch")), await d.head("Shop", 0.3, 0.3), await d.head("Shop", 0.3, 0.8)]);
    await d.over(await d.row("Chat B"));
    if (await settled(d, "group(Sub).drop [VISIBLE]") !== "group(Sub).drop [VISIBLE]") fail(`chat: over a row of Sub "${await visible(d)}" is lit, not Sub alone`);
    const inSub = await moving(d, page, "chat in Sub", "Sub", [...around(await d.row("Chat B")), await d.head("Sub", 0.3, 0.3), await d.head("Sub", 0.5, 0.8), ...around(await d.row("Chat B"))]);
    const seen = await page.evaluate(() => window.__seen);
    note(`chat: ${inShop} frames in Shop and ${inSub} in Sub, each with that zone alone lit; the window saw ${seen.join(" > ")}`);
    if (seen.includes("pointercancel")) fail("chat: the window saw a pointercancel in mid-drag (the page scrolled, or the system took the touch)");
    for (const t of ["keydown"]) if (seen.includes(t)) fail(`chat: the window saw ${t} in mid-drag`);
    await d.drop();
    if (!await until(async () => await d.groupOf("Chat A") === "Sub")) fail(`chat: Chat A is in "${await d.groupOf("Chat A")}" after the drop, not in Sub`);
    if (await visible(d)) fail(`chat: ${await visible(d)} stayed lit after the drop`);
  });

  await run(async (d, page) => { // a group: a zone, the line before a header, a refusal, and events of the pointer and the keys in mid-drag
    if (!await d.start(await d.head("Other"))) return fail("group: the page started no drag for the group Other");
    await d.over(await d.row("Chat A"));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`group: over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    const inShop = await moving(d, page, "group in Shop", "Shop", [...around(await d.row("Chat A")), ...around(await d.row(SLOW)), await d.head("Shop", 0.3, 0.8)]);
    await d.over(await d.head("Shop", 0.3, 0.2));
    if (await settled(d, "head(Shop).drop-before [VISIBLE]") !== "head(Shop).drop-before [VISIBLE]") fail(`group: on the upper half of Shop's header "${await visible(d)}" is lit, not the line before Shop alone`);
    const onHead = await moving(d, page, "group before Shop", "before Shop", [await d.head("Shop", 0.2, 0.2), await d.head("Shop", 0.6, 0.3), await d.head("Shop", 0.4, 0.1)]);
    await d.over(await d.head("Shop", 0.3, 0.8));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`group: from the upper to the lower half of Shop's header "${await visible(d)}" is lit, not Shop alone`);
    await d.over(await d.row("Chat B"));
    if (await settled(d, "group(Sub).drop [VISIBLE]") !== "group(Sub).drop [VISIBLE]") fail(`group: over a row of Sub "${await visible(d)}" is lit, not Sub alone`);
    note(`group: ${inShop} frames in Shop, ${onHead} on the upper half of its header, each with that alone lit`);
    // (a pointermove and a key that the page made up, as the old check sent: neither is the user's, so what is lit stays and the group still lands)
    for (const [type, send] of [["pointermove", () => document.body.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }))], ["keydown", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }))]]) {
      await d.over(await d.row("Chat A"));
      if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`group: back over a row of Shop "${await visible(d)}" is lit, not Shop`);
      await page.evaluate(send); await d.drawn();
      if (await visible(d) !== "group(Shop).drop [VISIBLE]") fail(`group: after a ${type} reached the page "${await visible(d)}" is lit over Shop: the drag was moved by an event that is not the user's`);
    }
    await d.over(await d.row("Chat A"));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`group: after a pointermove and a keydown in mid-drag "${await visible(d)}" is lit over Shop: the dragged group was lost`);
    await d.drop();
    if (!await until(async () => await d.parentOf("Other") === "Shop")) fail(`group: Other is in "${await d.parentOf("Other")}" after the drop, not in Shop`);
    if (await visible(d)) fail(`group: ${await visible(d)} stayed lit after the drop`);
  });

  await run(async (d) => { // a group that cannot go where the pointer is lights nothing, also inside a zone that was lit
    if (!await d.start(await d.head("Mid"))) return fail("refused: the page started no drag for the group Mid");
    const over = async (name, p, want) => {
      await d.over(p);
      if (await settled(d, want) !== want) fail(`refused: with Mid over ${name} "${await visible(d)}" is lit, not ${want ? "Other alone" : "nothing: Mid cannot go there"}`);
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

  await run(async (d) => { // the row under the pointer removed, and the pointer then outside every zone
    if (!await d.start(await d.row("Chat A"))) return fail("lost leave: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    await mockEval(`delete chats.c_plain; send({ type: "chat_removed", id: "c_plain" });`, url);
    if (!await until(async () => await d.groupOf(SLOW) === null)) return fail(`lost leave: the row ${SLOW} is still in the sidebar after its chat was removed`);
    await d.over(await d.refreshOutside());
    if (!await until(async () => !(await visible(d)), 5000)) fail(`lost leave: ${await visible(d)} is lit while the pointer is outside every zone, the drag still going`);
    else note("lost leave: nothing lit with the pointer outside every zone, after the row under it was removed");
    await d.drop();
  });

  await run(async (d) => { // the dragged row removed in mid-drag: the drag ends with it, nothing stays lit, and the next drag works
    if (!await d.start(await d.row("Chat A"))) return fail("lost end: the page started no drag for the row Chat A");
    await d.over(await d.row(SLOW));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`lost end: over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    await mockEval(`delete chats.c_A3_a; send({ type: "chat_removed", id: "c_A3_a" });`, url);
    if (!await until(async () => await d.groupOf("Chat A") === null)) return fail("lost end: the row Chat A is still in the sidebar after its chat was removed");
    if (!await until(async () => !(await visible(d)), 5000)) fail(`lost end: ${await visible(d)} stayed lit after the dragged row was removed`);
    await d.over(await d.row(SLOW));
    if (await visible(d)) fail(`lost end: ${await visible(d)} is lit over Shop with the dragged row gone and its drag over`);
    await d.cancel();
    if (await visible(d)) fail(`lost end: ${await visible(d)} stayed lit after the cancel`);
    // the next drag works
    if (!await d.start(await d.row("Chat B"))) return fail("lost end: the page started no drag for the row Chat B after it");
    await d.over(await d.row(SLOW));
    if (await settled(d, "group(Shop).drop [VISIBLE]") !== "group(Shop).drop [VISIBLE]") fail(`lost end: in the next drag, over a row of Shop "${await visible(d)}" is lit, not Shop alone`);
    await d.cancel();
    if (await visible(d)) fail(`lost end: ${await visible(d)} stayed lit after the next drag was cancelled`);
    note("lost end: the dragged row removed ended its drag, with nothing lit; the next drag lit and cancelled clean");
  });
}, { viewports, page: false });
