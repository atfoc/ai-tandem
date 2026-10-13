// Proves the page side of "a sent message" of plans/composer-images-goal.md (3.5), in the light and in the dark theme:
// a user message shows its images as thumbnails above its text, and a message of images alone shows them with no words
// and no text node of its own (quoteDom.ts reads a message's text nodes); a thumbnail whose image cannot be fetched is
// a plain tile with the image's name, readable on the tile, cut to the tile and with nothing to open; a click shows the
// image large, inside the window, the arrow keys go through the message's images and stop at both ends (one that
// cannot be fetched says so there), a message's only image has no steps, and Escape, the close button and a press
// beside the picture close it, Escape with the focus back on the thumbnail; the chat
// whose first message is images alone is titled "Image" in its header and in the sidebar, and its tree names that
// message "Image". And over the subagent drawer, Escape closes the large view first and the drawer after it.
// The mock serves no images: the check answers the image address itself, with PNGs for three ids and 404 for a fourth.
// OUT=/tmp/x keeps a screenshot of the thread and of the large view in each theme there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { check, colourOf, contrastOf, mockEval, openPage, until } from "../shot.mjs";

const OUT = process.env.OUT;
const FLOOR = 4.5; // the name on its tile: text
const id = (c) => c.repeat(64);
const A = id("a"), B = id("b"), C = id("c"), GONE = id("0");
const LONG = "Screenshot 2026-10-12 at 14.21.53 of the whole checkout flow with every step open.png";

/** A PNG of one colour. */
function png(w, h, rgb) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]), out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from(rgb))]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(h).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}
// one larger than the window, one small, one much wider than tall
const BYTES = { [A]: png(2400, 1800, [214, 64, 69]), [B]: png(120, 90, [47, 158, 68]), [C]: png(1600, 200, [42, 120, 214]) };

const img = (i, name) => ({ id: i, name, type: "image/png", size: BYTES[i]?.length ?? 1000 });
const ITEMS = [
  { kind: "user", text: "", images: [img(A, "one.png"), img(GONE, LONG)] },
  { kind: "text", done: true, text: "A red picture, and one I cannot see." }, { kind: "end" },
  { kind: "user", text: "And these three?", images: [img(A, "one.png"), img(B, "two.png"), img(C, "wide.png")] },
  { kind: "text", done: true, text: "Red, green and a wide blue one." }, { kind: "end" },
  { kind: "user", text: "One more.", images: [img(B, "two.png")] },
  { kind: "text", done: true, text: "Green again." }, { kind: "end" },
];
// a chat nobody named, whose first message is images alone
// (and the seed's chat with subagents gets an image on its first message)
const SEED = `chats.c_img = chat("c_img", { group: "g_shop", created: iso(T0 - MIN) }); items.c_img = ${JSON.stringify(ITEMS)};
  items.c_nested[0] = { ...items.c_nested[0], images: ${JSON.stringify([img(A, "one.png")])} }; return true;`;

const first = '.msg.user[data-item="0"]', second = '.msg.user[data-item="3"]', third = '.msg.user[data-item="6"]';
const caption = (page) => page.evaluate(() => document.querySelector(".img-large-name")?.textContent ?? null);
const closed = (page) => until(() => page.evaluate(() => !document.querySelector(".img-large")));
/** Answers a context's image fetches: the PNG of an id that has one, 404 for any other. */
const serve = (ctx) => ctx.route("**/api/chats/*/images/*", (route) => {
  const bytes = BYTES[route.request().url().split("/").pop()];
  return bytes ? route.fulfill({ status: 200, contentType: "image/png", body: bytes }) : route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
});

await check("IM3.5 a sent message's images: thumbnails, the plain tile, the large view, the name Image", async ({ url, browser, fail, note }) => {
  await mockEval(SEED, url);
  for (const theme of ["light", "dark"]) {
    const bad = (line) => fail(`${theme}: ${line}`);
    const { ctx, page } = await openPage({ url, browser, sel: { chat: "c_img" }, ls: { "aiwb.theme": theme }, wait: `${second} .msg-images` });
    // (the page asked the mock for the images before the check could answer for them: it is loaded again)
    await serve(ctx);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${second} .msg-images`, { timeout: 15000 });
    const drawn = await until(() => page.evaluate(() => {
      const tiles = [...document.querySelectorAll(".thread .img-thumb")];
      return tiles.length === 6 && tiles.every((t) => t.classList.contains("broken") || t.querySelector("img")?.naturalWidth > 0) && tiles.filter((t) => t.classList.contains("broken")).length === 1;
    }));
    if (!drawn) { bad(`the thread did not come to six thumbnails, five with their picture and one plain: ${await page.evaluate(() => [...document.querySelectorAll(".thread .img-thumb")].map((t) => t.className).join(" | "))}`); await ctx.close(); continue; }

    // ---- the two messages
    const seen = await page.evaluate(([first, second]) => {
      const R = (e) => e.getBoundingClientRect(), one = document.querySelector(first), two = document.querySelector(second);
      const tile = one.querySelector(".img-thumb.broken"), name = tile.querySelector(".img-thumb-name");
      const walker = document.createTreeWalker(one, NodeFilter.SHOW_TEXT);
      let texts = 0; while (walker.nextNode()) texts++;
      return {
        alone: { md: !!one.querySelector(":scope > .md"), marked: !!one.querySelector(".msg-images.alone"), tiles: one.querySelectorAll(".img-thumb").length, texts },
        sizes: [...document.querySelectorAll(".thread .img-thumb")].map((t) => `${R(t).width}x${R(t).height}`),
        plain: { text: name.dataset.text, shown: getComputedStyle(name, "::before").content, opens: !!tile.querySelector("button"), over: Math.round(Math.max(R(name).bottom - R(tile).bottom, R(tile).top - R(name).top, R(name).right - R(tile).right)) },
        withText: { tiles: two.querySelectorAll(".img-thumb").length, above: R(two.querySelector(".msg-images")).bottom <= R(two.querySelector(":scope > .md")).top, words: two.querySelector(":scope > .md").textContent, marked: !!two.querySelector(".msg-images.alone") },
        head: document.querySelector(".chat-head .unnamed")?.textContent ?? null,
        side: document.querySelector(".side-row.is-chat.on .side-name")?.textContent ?? null,
      };
    }, [first, second]);
    if (seen.alone.md || !seen.alone.marked || seen.alone.tiles !== 2) bad(`the message of images alone: ${JSON.stringify(seen.alone)}; it shows its two images and no words`);
    if (seen.alone.texts) bad(`the message of images alone has ${seen.alone.texts} text nodes; it has none`);
    if (seen.sizes.some((s) => s !== "88x88")) bad(`the thumbnails of a message are 88 px squares; they are ${seen.sizes.join(", ")}`);
    if (seen.plain.text !== LONG || !seen.plain.shown.includes("Screenshot 2026-10-12")) bad(`the plain tile names its image: ${JSON.stringify(seen.plain)}`);
    if (seen.plain.opens) bad("the plain tile has a button; an image that cannot be fetched has nothing to open");
    if (seen.plain.over > 0) bad(`the plain tile's name passes its tile by ${seen.plain.over} px`);
    if (seen.withText.tiles !== 3 || !seen.withText.above || seen.withText.words.trim() !== "And these three?" || seen.withText.marked) bad(`the message with images and words: ${JSON.stringify(seen.withText)}; its three images are above its words`);
    if (seen.head !== "Image") bad(`the header titles the chat “${seen.head}”; a chat whose first message is images alone is “Image”`);
    if (seen.side !== "Image") bad(`the sidebar titles the chat “${seen.side}”; it is “Image”`);
    const ink = await colourOf(page, ".img-thumb.broken .img-thumb-name", "color", "::before"), ground = await colourOf(page, ".img-thumb.broken", "backgroundColor");
    const ratio = ink && ground ? contrastOf(ink, ground) : 0;
    note(`${theme}: the plain tile's name has ${ratio.toFixed(2)}:1 on its tile`);
    if (ratio < FLOOR) bad(`the plain tile's name has ${ratio.toFixed(2)}:1 on its tile; the floor is ${FLOOR}:1`);
    if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.locator(".thread").screenshot({ path: path.join(OUT, `IM3.5-${theme}-thread.png`) }); }

    // ---- the large view
    const thumbs = page.locator(`${second} .img-thumb-open`);
    await thumbs.nth(1).click();
    if (!await until(() => page.evaluate(() => document.querySelector(".img-large-pic")?.naturalWidth > 0))) bad("a click on a thumbnail did not show its image large");
    if (await caption(page) !== "two.png · 2 of 3") bad(`the large view says “${await caption(page)}”; it shows the image that was clicked, “two.png · 2 of 3”`);
    if (!await page.evaluate(() => !!document.activeElement?.closest(".img-large"))) bad("the focus is not in the large view");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // (the last one: it stays)
    if (!await until(async () => await caption(page) === "wide.png · 3 of 3")) bad(`after two steps right the large view says “${await caption(page)}”; it stops at “wide.png · 3 of 3”`);
    const off = () => page.evaluate(() => [".img-large-prev", ".img-large-next"].map((s) => document.querySelector(s).getAttribute("aria-disabled") === "true"));
    if (String(await off()) !== "false,true") bad(`at the last image the steps that are off are ${await off()} (back, on); it is the one on`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    if (!await until(async () => await caption(page) === "one.png · 1 of 3")) bad(`after three steps left the large view says “${await caption(page)}”; it stops at “one.png · 1 of 3”`);
    // the two buttons step as the keys do, and the keys still work with the focus on a button that has come to its end
    for (let i = 0; i < 2; i++) await page.click(".img-large-next");
    if (!await until(async () => await caption(page) === "wide.png · 3 of 3")) bad(`after two presses of Next the large view says “${await caption(page)}”; it is at “wide.png · 3 of 3”`);
    await page.keyboard.press("ArrowLeft");
    await page.click(".img-large-prev");
    if (!await until(async () => await caption(page) === "one.png · 1 of 3")) bad(`after a step left by the key and one by the button the large view says “${await caption(page)}”; it is at “one.png · 1 of 3”`);
    // the picture that is larger than the window is drawn inside it, whole
    const fit = await until(() => page.evaluate(() => {
      const p = document.querySelector(".img-large-pic");
      if (!p || !(p.naturalWidth > 0)) return null;
      const r = p.getBoundingClientRect(), name = document.querySelector(".img-large-name").getBoundingClientRect();
      return { natural: p.naturalWidth, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= name.top && name.bottom <= innerHeight, ratio: Math.round(100 * r.width / r.height) / 100, width: Math.round(r.width) };
    }));
    if (!fit || fit.natural !== 2400 || !fit.inside || Math.abs(fit.ratio - 2400 / 1800) > 0.02 || fit.width < 300) bad(`the picture of 2400x1800 in the large view: ${JSON.stringify(fit)}; it is whole, in its own shape, inside the window above its name`);
    if (OUT) await page.screenshot({ path: path.join(OUT, `IM3.5-${theme}-large.png`) });
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view");
    if (!await page.evaluate((second) => document.activeElement === document.querySelectorAll(`${second} .img-thumb-open`)[1], second)) bad("after Escape the focus is not back on the thumbnail that was clicked");
    await thumbs.nth(0).click();
    await page.waitForSelector(".img-large");
    await page.click(".img-large-close");
    if (!await closed(page)) bad("the close button did not close the large view");
    await thumbs.nth(0).click();
    await page.waitForSelector(".img-large");
    await page.mouse.click(6, 300); // beside the picture
    if (!await closed(page)) bad("a press beside the picture did not close the large view");
    // a step to an image that cannot be fetched: the view says so, by the image's name
    await page.locator(`${first} .img-thumb-open`).click();
    await page.waitForSelector(".img-large");
    await page.keyboard.press("ArrowRight");
    if (!await until(() => page.evaluate(() => !!document.querySelector(".img-large-off") && !document.querySelector(".img-large-pic")))) bad("the large view of an image that cannot be fetched does not say so");
    if (await caption(page) !== `${LONG} · 2 of 2`) bad(`the large view of an image that cannot be fetched says “${await caption(page)}”; it names the image`);
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view of an image that cannot be fetched");
    // a message's only image: no steps
    await page.locator(`${third} .img-thumb-open`).click();
    await page.waitForSelector(".img-large");
    if (await caption(page) !== "two.png" || await page.evaluate(() => !!document.querySelector(".img-large-prev, .img-large-next"))) bad(`the large view of a message's only image says “${await caption(page)}”, with steps or without; it is “two.png” and has none`);
    // the small picture is not drawn larger than it is
    const small = await page.evaluate(() => { const r = document.querySelector(".img-large-pic").getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; });
    if (small !== "120x90") bad(`the picture of 120x90 is drawn ${small} in the large view; it keeps its size`);
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view of a message's only image");

    // ---- the tree
    await page.click(".chat-head .fk-tree-btn");
    await page.waitForSelector(".fk-nav .fk-text", { timeout: 15000 });
    const rows = await page.evaluate(() => [...document.querySelectorAll(".fk-nav .fk-text")].map((e) => e.textContent));
    if (rows[0] !== "Image" || rows.includes("(empty)")) bad(`the tree's rows are ${JSON.stringify(rows)}; the message of images alone is “Image”`);
    await ctx.close();
  }

  // ---- over the subagent drawer: the drawer covers the message, so the thumbnail is opened by the keys
  const { ctx, page } = await openPage({ url, browser, sel: { chat: "c_nested" }, wait: ".thread .subagent" });
  await serve(ctx);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(`${first} .img-thumb-open`, { timeout: 15000 });
  await page.click(".thread .subagent");
  await page.waitForSelector(".sub-drawer", { timeout: 15000 });
  await page.focus(`${first} .img-thumb-open`);
  await page.keyboard.press("Enter");
  if (!await until(() => page.evaluate(() => !!document.querySelector(".img-large")))) fail("with the subagent drawer open, Enter on a thumbnail did not show its image large");
  await page.keyboard.press("Escape");
  if (!await closed(page)) fail("with the subagent drawer open, Escape did not close the large view");
  if (!await page.evaluate(() => !!document.querySelector(".sub-drawer"))) fail("the Escape that closed the large view closed the subagent drawer too");
  await page.keyboard.press("Escape");
  if (!await until(() => page.evaluate(() => !document.querySelector(".sub-drawer")))) fail("with the large view closed, Escape did not close the subagent drawer");
  await ctx.close();
});
