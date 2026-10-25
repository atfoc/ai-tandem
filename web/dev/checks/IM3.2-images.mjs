// Proves, on the new build, the composer's side of images in a chat (plans/composer-images-goal.md, sections 3.1 and 3.2; package K4: C-IM-01, 03, 04,
// 05, 07, 09 to 15, C-TX-02/05/07, C-DR-03, C-RO-09), at desktop, tablet and phone: the attach button of the toolbar's row and a paste both add an
// image, through one check; a file that passes is uploaded at once, its thumbnail busy and Send off until the mock has answered; a file that fails is
// named in the error line; a paste with plain text and rich text is the text's; a message of images alone is sent with them; and a draft's images are
// there again after a reload.
// Ports dev/checks/IM3.2-composer.mjs (same seed A2, same two pictures, the same mock knobs, the same assertions and failure lines); only the selectors
// and the navigation change: the thumbnails are S10's `image-thumb` (dataSet `state`) in K4's `composer-images`, the remove control is
// `image-thumb-remove`, the picker is the browser's file chooser (the web build, as the old page's, has a file input: AD-26).
// The paste is the same on the three viewports (a paste event with files: the phone's keyboard offers it too, or Chromium's device mode does).
// At the phone (ux-improvements C1) the picker is "+" -> Files (the web build's one file chooser) in place of the toolbar's attach button, the empty box
// shows Talk (so the check waits for the box, and Send exists once there is something to send), Send has no `title` (its words are its aria-label),
// and the words about a file that was not added are the strip's lines (`composer-images-line`; a refused file is also a marked tile, `image-refused`),
// not the line under the composer.
import { check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// A 1×1 PNG, and the same with another pixel: two pictures, so two images.
const png = (last) => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${last}AAAABJRU5ErkJggg==`, "base64");
const PNG_A = png("YPhfDwAChwGA60e6kg"), PNG_B = png("+M9QDwADhgGAWjR9aw");

await check("IM3.2 images in a chat's composer: the attach button, a paste, the strip, Send, a reload", async ({ url, open, fail, note, viewport }) => {
  const phone = viewport === "phone";
  const states = await seed(url, "A2");
  const s = states.find((x) => x.id === "plain-started");
  const { ctx, page } = await open({ sel: s.sel, wait: tidSel("composer-input") });
  const chat = s.sel.chat;
  const thumbs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-images"] [data-testid="image-thumb"]')].map((e) => ({
    name: e.getAttribute("aria-label"), busy: e.dataset.state === "busy", broken: e.dataset.state === "broken", src: e.querySelector("img")?.getAttribute("src") ?? "" })));
  // (at the phone the empty box has Talk and no Send: that is "off"; Send says its words by aria-label)
  const send = () => page.evaluate(() => { const b = document.querySelector('[data-testid="composer"] [data-testid="send"]'); return b ? { off: b.disabled, title: b.title || b.getAttribute("aria-label") } : { off: true, title: "", none: true }; });
  // (at the phone the strip says what was not added, one line each; the line under the composer holds the rest)
  const err = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-err"], [data-testid="composer"] [data-testid="composer-images-line"]')].map((e) => e.textContent).join(" "));
  const text = () => page.evaluate(() => document.querySelector('[data-testid="composer"] [data-testid="composer-input"]').textContent);
  const draft = () => mockEval(`return JSON.stringify(chats[${JSON.stringify(chat)}].draft ?? null);`, url).then((x) => JSON.parse(x));
  /** A paste into the composer's box, as the browser hands it on: files, and text of the types given. */
  const paste = (files, text = {}) => page.evaluate(({ files, text }) => {
    const dt = new DataTransfer();
    for (const [type, v] of Object.entries(text)) dt.setData(type, v);
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const box = document.querySelector('[data-testid="composer"] [data-testid="composer-input"]');
    box.focus();
    return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); // true: the paste was consumed
  }, { files: files.map((f) => ({ ...f, b64: f.bytes.toString("base64") })), text });

  // ---- the attach button: the browser's own picker, several files, each through the check
  const button = byTid(page, "composer-tools").locator(tidSel("attach-btn"));
  /** What opens the file chooser: the attach button, at the phone "+" and its Files row (the sheet closes, then the chooser opens). */
  const pick = async () => { if (!phone) return press(page, button); await press(page, byTid(page, "composer-plus")); await press(page, byTid(page, "action-row", { action: "files" })); };
  if (phone ? await byTid(page, "composer-plus").count() !== 1 : await button.count() !== 1) fail(phone ? 'the toolbar has no "+" (Add to message)' : "the toolbar's row has no attach button");
  if (phone && (!await byTid(page, "composer-talk").isVisible() || (await send()).none !== true)) fail("the empty phone box does not show Talk without Send");
  if (await send().then((x) => !x.off)) fail("Send is on with nothing in the composer");
  await mockEval("flags.upload = { hold: true };", url);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), pick()]);
  if (!chooser.isMultiple()) fail("the picker takes one file only");
  await chooser.setFiles([{ name: "diagram.png", mimeType: "image/png", buffer: PNG_A }, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  if (!await until(async () => (await thumbs()).length === 1, 8000)) fail(`a picked image has no thumbnail: ${JSON.stringify(await thumbs())}`);
  let t = await thumbs();
  if (!t[0]?.busy || t[0]?.name !== "diagram.png") fail(`the thumbnail of an image on its way is not busy, or not named: ${JSON.stringify(t)}`);
  // (the phone: the box is empty and the primary is Talk while the upload runs -- no Send to be off; with text it is Send, soft, with these words)
  if (!(await send()).off || (!phone && (await send()).title !== "An image is being uploaded")) fail(`Send is not off while an upload runs: ${JSON.stringify(await send())}`);
  const notAdded = phone ? "notes.txt is not added: send PNG, JPEG, GIF or WebP." : "Not a PNG, JPEG, GIF or WebP image: notes.txt.";
  if (await err() !== notAdded) fail(`the error line does not name the file that was not added: ${JSON.stringify(await err())}`);
  if (phone && await byTid(page, "image-refused").count() !== 1) fail("the file that was not added is no marked tile in the phone's strip");
  if (await draft()) fail(`an image on its way is in the draft already: ${JSON.stringify(await draft())}`);
  if (await mockEval(`const n = release("upload"); delete flags.upload; return n;`, url) !== 1) fail("the mock held no upload: the picked image was not uploaded at once");
  if (!await until(async () => { const x = await thumbs(); return x.length === 1 && !x[0].busy; }, 8000)) fail(`the thumbnail stays busy after the upload was answered: ${JSON.stringify(await thumbs())}`);
  if (!await until(async () => (await draft())?.images?.length === 1, 8000)) fail(`the uploaded image is not in the saved draft: ${JSON.stringify(await draft())}`);
  const first = (await draft())?.images?.[0];
  if (first && (Object.keys(first).join() !== "id,name,type,size" || first.name !== "diagram.png" || first.type !== "image/png" || first.size !== PNG_A.length)) fail(`the draft names the image as ${JSON.stringify(first)}`);
  if ((await send()).off) fail(`Send is off with an image and no text: ${JSON.stringify(await send())}`);
  // the thumbnail ends on the image's own address, and the image is there
  if (!await until(async () => (await thumbs())[0]?.src === `/host/picture/local/${chat}/${first?.id}`, 8000)) fail(`the thumbnail does not show the image's address: ${JSON.stringify(await thumbs())}`);
  if ((await thumbs())[0]?.broken) fail("the thumbnail of an uploaded image is the plain tile: its address did not load");

  // ---- a paste: files alone are images; with plain text and rich text the text wins
  if (!await paste([{ name: "image.png", type: "image/png", bytes: PNG_B }])) fail("a paste of an image file was not consumed");
  if (!await until(async () => { const x = await thumbs(); return x.length === 2 && !x[1].busy; }, 8000)) fail(`a pasted image has no thumbnail: ${JSON.stringify(await thumbs())}`);
  if ((await thumbs())[1]?.name !== "Pasted image") fail(`a pasted picture is named ${JSON.stringify((await thumbs())[1]?.name)}`);
  await paste([{ name: "image.png", type: "image/png", bytes: PNG_A }], { "text/plain": "B2 cell", "text/html": "<table><tr><td>B2 cell</td></tr></table>" });
  if (!await until(async () => (await text()).includes("B2 cell"), 8000)) fail("a paste with plain text and rich text did not paste the text");
  if ((await thumbs()).length !== 2) fail(`a paste with plain text and rich text added an image: ${JSON.stringify(await thumbs())}`);
  // a file copied in a file manager: its name as plain text, no rich text; the same picture again is one image
  await paste([{ name: "diagram.png", type: "image/png", bytes: PNG_A }], { "text/plain": "diagram.png" });
  await until(async () => !(await thumbs()).some((x) => x.busy), 8000);
  if ((await thumbs()).length !== 2) fail(`the same picture added twice is not one image: ${JSON.stringify(await thumbs())}`);
  if ((await text()).includes("diagram.png")) fail("a paste of a copied file pasted its name as text");

  // ---- the draft is there after a reload, text and images
  if (!await until(async () => { const d = await draft(); return d?.text?.includes("B2 cell") && d.images?.length === 2; }, 8000)) fail(`the draft is not saved with its text and two images: ${JSON.stringify(await draft())}`);
  await page.reload();
  await page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
  if (!await until(async () => (await thumbs()).length === 2, 8000)) fail(`after a reload the composer does not show the draft's images: ${JSON.stringify(await thumbs())}`);

  // ---- the remove control, and a message of images alone
  await press(page, byTid(page, "composer-images").locator(tidSel("image-thumb-remove")).nth(1));
  if (!await until(async () => (await thumbs()).length === 1, 8000)) fail("the remove control did not take the image out of the strip");
  await page.evaluate(() => { const box = document.querySelector('[data-testid="composer"] [data-testid="composer-input"]'); box.focus(); document.execCommand("selectAll"); document.execCommand("delete"); });
  if (!await until(async () => { const d = await draft(); return d && !d.text && d.images?.length === 1; }, 8000)) fail(`the draft of an image alone is not saved as one: ${JSON.stringify(await draft())}`);
  if ((await send()).off) fail("Send is off for a message of an image alone");
  await press(page, byTid(page, "send").first());
  const sent = await until(() => mockEval(`const u = listOf(${JSON.stringify(chat)}, curOf(chats[${JSON.stringify(chat)}])).filter((x) => x.kind === "user").at(-1); return u.images ? JSON.stringify(u) : "";`, url), 8000);
  if (!sent) fail("the message of an image alone did not reach the server with its image");
  else if (JSON.parse(sent).text !== "" || JSON.parse(sent).images[0]?.id !== first?.id) fail(`the message was sent as ${sent}`);
  if (!await until(async () => !(await thumbs()).length, 8000)) fail("the strip still has the image of the message that was sent");

  // ---- the page goes away while an image is being uploaded (C-IM-18): the draft saved on its way out, and the copy the browser keeps, have the text and not the image
  await page.reload();
  await page.waitForSelector(tidSel("composer-input"), { timeout: 15000 });
  await mockEval(`delete chats[${JSON.stringify(chat)}].draft;`, url);
  await mockEval("flags.upload = { hold: true };", url);
  await paste([{ name: "image.png", type: "image/png", bytes: PNG_B }]);
  if (!await until(async () => { const x = await thumbs(); return x.length === 1 && x[0].busy; }, 8000)) fail(`an image on its way has no busy thumbnail: ${JSON.stringify(await thumbs())}`);
  // (the text is typed and the page goes away in one breath, before the draft's own delay: what is saved is what the page saves on its way out)
  const copy = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="composer"] [data-testid="composer-input"]');
    box.focus();
    document.execCommand("insertText", false, "going away");
    window.dispatchEvent(new Event("pagehide"));
    return Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("aiwb.draft.")).map((k) => [k, localStorage.getItem(k)]));
  });
  const kept = Object.values(copy).join(" ");
  if (Object.keys(copy).length !== 1 || !kept.includes("going away")) fail(`the copy the browser keeps as the page goes away is ${JSON.stringify(copy)}, not the text`);
  else if (/"images":\[\{/.test(kept)) fail(`the copy the browser keeps as the page goes away has the image that was still being uploaded: ${kept}`);
  if (!await until(async () => (await draft())?.text === "going away", 8000)) fail(`the draft saved as the page goes away is ${JSON.stringify(await draft())}, not the text`);
  else if ((await draft())?.images?.length) fail(`the draft saved as the page goes away has the image that was still being uploaded: ${JSON.stringify(await draft())}`);
  await mockEval(`release("upload"); delete flags.upload;`, url);
  if (!await until(async () => { const x = await thumbs(); return x.length === 1 && !x[0].busy; }, 8000)) fail(`the image that was being uploaded stays busy: ${JSON.stringify(await thumbs())}`);
  await press(page, byTid(page, "composer-images").locator(tidSel("image-thumb-remove")).first());
  if (!await until(async () => !(await thumbs()).length, 8000)) fail("the remove control did not take the image out of the strip");

  // ---- an upload the server refuses: its sentence in the error line, and no thumbnail left
  await mockEval(`flags.upload = { fail: [409, "the chat holds too many images that were not sent", "image_cap"] };`, url);
  await paste([{ name: "image.png", type: "image/png", bytes: PNG_B }]);
  if (!await until(async () => (await err()).includes("Pasted image was not added: the chat holds too many images that were not sent."), 8000)) fail(`a refused upload is not told in the error line: ${JSON.stringify(await err())}`);
  if ((await thumbs()).length) fail(`a refused upload left a thumbnail: ${JSON.stringify(await thumbs())}`);
  await mockEval("delete flags.upload;", url);
  await ctx.close();

  note("the attach button and a paste add images through one check; busy thumbnail, Send off while it uploads; the text wins a paste with rich text; the draft keeps its images over a reload; a message of an image alone is sent; a refused upload is told");
}, { viewports, page: false });
