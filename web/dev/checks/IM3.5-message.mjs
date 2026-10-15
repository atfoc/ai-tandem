// Proves, on the new build, the page side of "a sent message" of plans/composer-images-goal.md (3.5), in the light and in the dark theme, at
// desktop, tablet and phone (package S10; B-IM-01 to B-IM-11, D-PC-09, D-PC-10): a user message shows its images as thumbnails above its text,
// and a message of images alone shows them with no words and no text node of its own (the quotes read a message's text nodes); a thumbnail whose
// image cannot be fetched is a plain tile with the image's name, readable on the tile, cut to the tile and with nothing to open; a press shows
// the image large, inside the window, the arrow keys and the two buttons go through the message's images and stop at both ends (one that
// cannot be fetched says so there), a message's only image has no steps, and Escape, the close button and a press beside the picture close it,
// Escape with the focus back on the thumbnail; the chat whose first message is images alone is titled "Image" in its header and in the
// sidebar. On touch a swipe sideways steps and a swipe down closes (the large view is a full-screen sheet on the phone).
// Ports dev/checks/IM3.5-message.mjs with the same seed (the chat c_img, one image held by two messages and one that cannot be fetched), the
// same PNGs and the same assertions; only the selectors change (testIDs of screens/images). The mock serves no images: the check answers the
// image address itself, with PNGs for three ids and 404 for a fourth.
// Also, as the old check: the chat tree (S8) names the message of images alone "Image" (B-IM-10), and over the subagent drawer (S7) Escape closes the large
// view first and the drawer after it (B-IM-09), not at the phone, whose drawer is a screen over the chat's with no thumbnail on it to open.
// OUT=/tmp/x keeps a screenshot of the thread and of the large view in each theme there, for a person's look.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { check, colourOf, contrastOf, mockEval, until } from "../shot.mjs";
import { byTid, press, showList, touchNow } from "./sel.mjs";
import { closeTree, openTree } from "./fork.mjs";

export const viewports = ["desktop", "tablet", "phone"];

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

const THUMB = '[data-testid="image-thumb"]', BROKEN = '[data-testid="picture"][data-state="broken"]', LARGE = '[data-testid="image-large"]';
const msg = (item) => `[data-testid="msg"][data-role="user"][data-item="${item}"]`;
const first = msg(0), second = msg(3), third = msg(6);
const caption = (page) => page.evaluate(() => document.querySelector('[data-testid="image-large-name"]')?.textContent ?? null);
const closed = (page) => until(() => page.evaluate((s) => !document.querySelector(s), LARGE));
/** Answers a context's image fetches: the PNG of an id that has one, 404 for any other. */
const serve = (ctx) => ctx.route("**/host/picture/local/*/*", (route) => {
  const bytes = BYTES[route.request().url().split("/").pop()];
  return bytes ? route.fulfill({ status: 200, contentType: "image/png", body: bytes }) : route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"not found"}' });
});
/** A swipe of a finger from (x, y) by (dx, dy), through the DevTools session (Playwright's touchscreen has a tap only). */
let fingers = 0;
async function swipe(page, x, y, dx, dy) {
  const finger = ++fingers, c = await page.context().newCDPSession(page), at = (i) => [{ x: x + (dx * i) / 8, y: y + (dy * i) / 8, id: finger }];
  await c.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(0) });
  for (let i = 1; i <= 8; i++) await c.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(i) });
  await c.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await c.detach();
}

await check("IM3.5 a sent message's images: thumbnails, the plain tile, the large view, the name Image", async ({ url, open, viewport, fail, note }) => {
  await mockEval(SEED, url);
  for (const theme of ["light", "dark"]) {
    const bad = (line) => fail(`${theme}: ${line}`);
    const { ctx, page } = await open({ sel: { chat: "c_img" }, ls: { "aiwb.theme": theme }, wait: `${second} [data-testid="msg-images"]` });
    const touch = await touchNow(page);
    // (the page asked the mock for the images before the check could answer for them: it is loaded again)
    await serve(ctx);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${second} [data-testid="msg-images"]`, { timeout: 15000 });
    const states = () => page.evaluate(([t, b]) => [...document.querySelectorAll(`[data-testid="thread"] ${t}`)].map((e) => e.dataset.state + (e.querySelector("img")?.naturalWidth > 0 ? "+img" : e.querySelector(b) ? "+tile" : "")), [THUMB, BROKEN]);
    const drawn = await until(async () => { const s = await states(); return s.length === 6 && s.filter((x) => x === "loaded+img").length === 5 && s.filter((x) => x === "broken+tile").length === 1; });
    if (!drawn) { bad(`the thread did not come to six thumbnails, five with their picture and one plain: ${await states()}`); await ctx.close(); continue; }

    // ---- the two messages
    const seen = await page.evaluate(([first, second, THUMB, BROKEN]) => {
      const R = (e) => e.getBoundingClientRect(), one = document.querySelector(first), two = document.querySelector(second);
      const tile = one.querySelector(BROKEN), name = tile.querySelector(".aiwb-tile-name");
      const walker = document.createTreeWalker(one, NodeFilter.SHOW_TEXT);
      let texts = 0; while (walker.nextNode()) texts++;
      const words = (m) => [...m.querySelectorAll('[data-testid^="md-p"]')];
      return {
        alone: { md: words(one).length, marked: one.querySelector('[data-testid="msg-images"]').dataset.alone === "true", tiles: one.querySelectorAll(THUMB).length, texts },
        sizes: [...document.querySelectorAll(`[data-testid="thread"] ${THUMB}`)].map((t) => `${R(t).width}x${R(t).height}`),
        plain: { text: name.dataset.text, shown: getComputedStyle(name, "::before").content, opens: !!tile.closest(THUMB).querySelector('[data-testid="image-thumb-open"]'), over: Math.round(Math.max(R(name).bottom - R(tile).bottom, R(tile).top - R(name).top, R(name).right - R(tile).right)) },
        withText: { tiles: two.querySelectorAll(THUMB).length, above: R(two.querySelector('[data-testid="msg-images"]')).bottom <= R(words(two)[0]).top, words: words(two).map((e) => e.textContent).join(""), marked: two.querySelector('[data-testid="msg-images"]').dataset.alone === "true" },
        head: document.querySelector('[data-testid="chat-head-name"]')?.textContent ?? null,
      };
    }, [first, second, THUMB, BROKEN]);
    if (seen.alone.md || !seen.alone.marked || seen.alone.tiles !== 2) bad(`the message of images alone: ${JSON.stringify(seen.alone)}; it shows its two images and no words`);
    if (seen.alone.texts) bad(`the message of images alone has ${seen.alone.texts} text nodes; it has none`);
    if (seen.sizes.some((s) => s !== "88x88")) bad(`the thumbnails of a message are 88 px squares; they are ${seen.sizes.join(", ")}`);
    if (seen.plain.text !== LONG || !seen.plain.shown.includes("Screenshot 2026-10-12")) bad(`the plain tile names its image: ${JSON.stringify(seen.plain)}`);
    if (seen.plain.opens) bad("the plain tile has something to open; an image that cannot be fetched has nothing to open");
    if (seen.plain.over > 0) bad(`the plain tile's name passes its tile by ${seen.plain.over} px`);
    if (seen.withText.tiles !== 3 || !seen.withText.above || seen.withText.words.trim() !== "And these three?" || seen.withText.marked) bad(`the message with images and words: ${JSON.stringify(seen.withText)}; its three images are above its words`);
    if (seen.head !== "Image") bad(`the header titles the chat “${seen.head}”; a chat whose first message is images alone is “Image”`);
    const ink = await colourOf(page, `${BROKEN} .aiwb-tile-name`, "color", "::before"), ground = await colourOf(page, BROKEN, "backgroundColor");
    const ratio = ink && ground ? contrastOf(ink, ground) : 0;
    note(`${theme}: the plain tile's name has ${ratio.toFixed(2)}:1 on its tile`);
    if (ratio < FLOOR) bad(`the plain tile's name has ${ratio.toFixed(2)}:1 on its tile; the floor is ${FLOOR}:1`);
    if (OUT) { fs.mkdirSync(OUT, { recursive: true }); await page.screenshot({ path: path.join(OUT, `IM3.5-${viewport}-${theme}-thread.png`) }); }

    // ---- the large view
    const opens = (m) => byTid(page, "msg", { role: "user", item: m }).locator('[data-testid="image-thumb-open"]');
    await press(page, opens(3).nth(1));
    const pic = () => page.evaluate((L) => document.querySelector(`${L} img[data-testid="picture"]`)?.naturalWidth > 0, LARGE);
    if (!await until(pic)) bad("a press on a thumbnail did not show its image large");
    if (await caption(page) !== "two.png · 2 of 3") bad(`the large view says “${await caption(page)}”; it shows the image that was pressed, “two.png · 2 of 3”`);
    if (!await until(() => page.evaluate((L) => !!document.activeElement?.closest(L), LARGE))) bad("the focus is not in the large view");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // (the last one: it stays)
    if (!await until(async () => await caption(page) === "wide.png · 3 of 3")) bad(`after two steps right the large view says “${await caption(page)}”; it stops at “wide.png · 3 of 3”`);
    const off = () => page.evaluate(() => ["image-large-prev", "image-large-next"].map((t) => document.querySelector(`[data-testid="${t}"]`).getAttribute("aria-disabled") === "true"));
    if (String(await off()) !== "false,true") bad(`at the last image the steps that are off are ${await off()} (back, on); it is the one on`);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowLeft");
    if (!await until(async () => await caption(page) === "one.png · 1 of 3")) bad(`after three steps left the large view says “${await caption(page)}”; it stops at “one.png · 1 of 3”`);
    // the two buttons step as the keys do, and the keys still work with the focus on a button that has come to its end
    for (let i = 0; i < 2; i++) await press(page, byTid(page, "image-large-next"));
    if (!await until(async () => await caption(page) === "wide.png · 3 of 3")) bad(`after two presses of Next the large view says “${await caption(page)}”; it is at “wide.png · 3 of 3”`);
    await page.keyboard.press("ArrowLeft");
    await press(page, byTid(page, "image-large-prev"));
    if (!await until(async () => await caption(page) === "one.png · 1 of 3")) bad(`after a step left by the key and one by the button the large view says “${await caption(page)}”; it is at “one.png · 1 of 3”`);
    // the picture that is larger than the window is drawn inside it, whole
    const fit = await until(() => page.evaluate((L) => {
      const p = document.querySelector(`${L} img[data-testid="picture"]`);
      if (!p || !(p.naturalWidth > 0)) return null;
      const r = p.getBoundingClientRect(), name = document.querySelector('[data-testid="image-large-name"]').getBoundingClientRect();
      if (getComputedStyle(p).opacity !== "1") return null; // (until its size is measured it is drawn invisibly)
      return { natural: p.naturalWidth, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= name.top + 1 && name.bottom <= innerHeight, ratio: Math.round(100 * r.width / r.height) / 100, width: Math.round(r.width) };
    }, LARGE));
    if (!fit || fit.natural !== 2400 || !fit.inside || Math.abs(fit.ratio - 2400 / 1800) > 0.02 || fit.width < 300) bad(`the picture of 2400x1800 in the large view: ${JSON.stringify(fit)}; it is whole, in its own shape, inside the window above its name`);
    if (OUT) await page.screenshot({ path: path.join(OUT, `IM3.5-${viewport}-${theme}-large.png`) });
    // on touch: a swipe sideways goes to the next image and back, a swipe down closes
    if (touch) {
      const w = page.viewportSize().width, h = page.viewportSize().height;
      await swipe(page, w * 0.75, h * 0.5, -w * 0.5, 0);
      if (!await until(async () => await caption(page) === "two.png · 2 of 3")) bad(`a swipe to the left leaves the large view at “${await caption(page)}”; it goes to “two.png · 2 of 3”`);
      await swipe(page, w * 0.25, h * 0.5, w * 0.5, 0);
      if (!await until(async () => await caption(page) === "one.png · 1 of 3")) bad(`a swipe to the right leaves the large view at “${await caption(page)}”; it goes back to “one.png · 1 of 3”`);
      await swipe(page, w * 0.5, h * 0.4, 0, h * 0.35);
      if (!await closed(page)) bad("a swipe down did not close the large view");
      await press(page, opens(3).nth(1));
      await page.waitForSelector(LARGE);
    }
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view");
    if (!await page.evaluate((s) => document.activeElement === document.querySelectorAll(s)[1], `${second} [data-testid="image-thumb-open"]`)) bad("after Escape the focus is not back on the thumbnail that was pressed");
    await press(page, opens(3).nth(0));
    await page.waitForSelector(LARGE);
    await press(page, byTid(page, "image-large-close"));
    if (!await closed(page)) bad("the close button did not close the large view");
    await press(page, opens(3).nth(0));
    await page.waitForSelector(LARGE);
    if (touch) await page.touchscreen.tap(6, 300); else await page.mouse.click(6, 300); // beside the picture
    if (!await closed(page)) bad("a press beside the picture did not close the large view");
    // a step to an image that cannot be fetched: the view says so, by the image's name
    await press(page, opens(0).first());
    await page.waitForSelector(LARGE);
    await page.keyboard.press("ArrowRight");
    if (!await until(() => page.evaluate((L) => !!document.querySelector('[data-testid="image-large-off"]') && !document.querySelector(`${L} img[data-testid="picture"]`), LARGE))) bad("the large view of an image that cannot be fetched does not say so");
    if (await caption(page) !== `${LONG} · 2 of 2`) bad(`the large view of an image that cannot be fetched says “${await caption(page)}”; it names the image`);
    if (!(await byTid(page, "image-large-off").textContent())?.includes("This image cannot be shown.")) bad("the large view of an image that cannot be fetched does not say “This image cannot be shown.”");
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view of an image that cannot be fetched");
    // a message's only image: no steps
    await press(page, opens(6).first());
    await page.waitForSelector(LARGE);
    if (await caption(page) !== "two.png" || await page.evaluate(() => !!document.querySelector('[data-testid="image-large-prev"], [data-testid="image-large-next"]'))) bad(`the large view of a message's only image says “${await caption(page)}”, with steps or without; it is “two.png” and has none`);
    // the small picture is not drawn larger than it is
    const small = await until(() => page.evaluate((L) => { const p = document.querySelector(`${L} img[data-testid="picture"]`), r = p?.getBoundingClientRect(); return r && getComputedStyle(p).opacity === "1" ? `${Math.round(r.width)}x${Math.round(r.height)}` : null; }, LARGE));
    if (small !== "120x90") bad(`the picture of 120x90 is drawn ${small} in the large view; it keeps its size`);
    // (the scrim is dark and the texts light in every theme: B-IM-11)
    const scrim = await colourOf(page, '[data-testid="image-large-backdrop"]', "backgroundColor"), words = await colourOf(page, '[data-testid="image-large-name"]', "color");
    if (!scrim || !words || contrastOf(words, scrim) < FLOOR || Math.max(...scrim) > 60) bad(`the large view is ${JSON.stringify(scrim)} with texts ${JSON.stringify(words)}; it is a dark scrim with light texts`);
    await page.keyboard.press("Escape");
    if (!await closed(page)) bad("Escape did not close the large view of a message's only image");

    // ---- the title Image: in the sidebar, and in the tree
    await openTree(page);
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="fk-nav"] [data-testid="fk-text"]')].map((e) => e.textContent));
    if (rows[0] !== "Image" || rows.includes("(empty)")) bad(`the tree's rows are ${JSON.stringify(rows)}; the message of images alone is “Image”`);
    await closeTree(page);
    await showList(page);
    const side = await byTid(page, "side-row", { kind: "chat", key: "c_img" }).first().locator('[data-testid="side-name"]').textContent();
    if (side !== "Image") bad(`the sidebar titles the chat “${side}”; it is “Image”`);
    await ctx.close();
  }

  // ---- over the subagent drawer: the drawer covers the message, so the thumbnail is opened by the keys. (On the phone the drawer is a screen
  // of its own, pushed over the chat's: the chat's thumbnails are not on screen then, and B-IM-09 is a row for a hardware keyboard.)
  if (viewport !== "phone") {
    const { ctx, page } = await open({ sel: { chat: "c_nested" }, wait: '[data-testid="sub-row"]' });
    await serve(ctx);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${first} [data-testid="image-thumb-open"]`, { timeout: 15000 });
    await press(page, byTid(page, "sub-row").first());
    await page.waitForSelector('[data-testid="sub-drawer"]', { timeout: 15000 });
    await page.focus(`${first} [data-testid="image-thumb-open"]`);
    await page.keyboard.press("Enter");
    if (!await until(() => page.evaluate((L) => !!document.querySelector(L), LARGE))) fail("with the subagent drawer open, Enter on a thumbnail did not show its image large");
    await page.keyboard.press("Escape");
    if (!await closed(page)) fail("with the subagent drawer open, Escape did not close the large view");
    if (!await page.evaluate(() => !!document.querySelector('[data-testid="sub-drawer"]'))) fail("the Escape that closed the large view closed the subagent drawer too");
    await page.keyboard.press("Escape");
    if (!await until(() => page.evaluate(() => !document.querySelector('[data-testid="sub-drawer"]')))) fail("with the large view closed, Escape did not close the subagent drawer");
    await ctx.close();
  }
}, { viewports, page: false });
