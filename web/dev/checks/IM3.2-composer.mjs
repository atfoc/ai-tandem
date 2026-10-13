// Proves, in the page, the composer's side of images in a chat (plans/composer-images-goal.md, sections 3.1 and 3.2):
// the attach button of the toolbar's row and a paste both add an image, through one check; a file that passes is
// uploaded at once, its thumbnail busy and Send off until the mock has answered; a file that fails is named in the
// error line; a paste with plain text and rich text is the text's; a message of images alone is sent with them; and a
// draft's images are there again after a reload.
// What the rules are is test/chatimage.test.ts's, and what happens to an upload whose composer goes away is
// test/actions.test.ts's; here it is the page that does it, against the mock's image routes (dev/mock.mjs).
import { check, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

// A 1×1 PNG, and the same with another pixel: two pictures, so two images.
const png = (last) => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${last}AAAABJRU5ErkJggg==`, "base64");
const PNG_A = png("YPhfDwAChwGA60e6kg"), PNG_B = png("+M9QDwADhgGAWjR9aw");

await check("IM3.2 images in a chat's composer: the attach button, a paste, the strip, Send, a reload", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const s = states.find((x) => x.id === "plain-started");
  const { ctx, page } = await openPage({ url, browser, sel: s.sel, ...paneSize("page", 900), wait: ".composer-box .send" });
  const chat = s.sel.chat;
  const thumbs = () => page.evaluate(() => [...document.querySelectorAll(".composer .composer-images .img-thumb")].map((e) => ({ name: e.getAttribute("title"), busy: e.classList.contains("busy"), broken: e.classList.contains("broken"), src: e.querySelector("img")?.getAttribute("src") ?? "" })));
  const send = () => page.evaluate(() => { const b = document.querySelector(".composer .composer-tools .send:not(.stop)"); return { off: b.disabled, title: b.title }; });
  const err = () => page.evaluate(() => document.querySelector(".composer .composer-err")?.textContent ?? "");
  const draft = () => mockEval(`return JSON.stringify(chats[${JSON.stringify(chat)}].draft ?? null);`, url).then((x) => JSON.parse(x));
  /** A paste into the composer's box, as the browser hands it on: files, and text of the types given. */
  const paste = (files, text = {}) => page.evaluate(({ files, text }) => {
    const dt = new DataTransfer();
    for (const [type, v] of Object.entries(text)) dt.setData(type, v);
    for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    const box = document.querySelector(".composer .composer-input");
    box.focus();
    return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); // true: the paste was consumed
  }, { files: files.map((f) => ({ ...f, b64: f.bytes.toString("base64") })), text });

  // ---- the attach button: the browser's own picker, several files, each through the check
  const button = page.locator(".composer .composer-tools > .attach-btn");
  if (await button.count() !== 1) fail("the toolbar's row has no attach button");
  if (await send().then((x) => !x.off)) fail("Send is on with nothing in the composer");
  await mockEval("flags.upload = { hold: true };", url);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), button.click()]);
  if (!chooser.isMultiple()) fail("the picker takes one file only");
  await chooser.setFiles([{ name: "diagram.png", mimeType: "image/png", buffer: PNG_A }, { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") }]);
  if (!await until(async () => (await thumbs()).length === 1, 8000)) fail(`a picked image has no thumbnail: ${JSON.stringify(await thumbs())}`);
  let t = await thumbs();
  if (!t[0]?.busy || t[0]?.name !== "diagram.png") fail(`the thumbnail of an image on its way is not busy, or not named: ${JSON.stringify(t)}`);
  if (!(await send()).off || (await send()).title !== "An image is being uploaded") fail(`Send is not off while an upload runs: ${JSON.stringify(await send())}`);
  if (await err() !== "Not a PNG, JPEG, GIF or WebP image: notes.txt.") fail(`the error line does not name the file that was not added: ${JSON.stringify(await err())}`);
  if (await draft()) fail(`an image on its way is in the draft already: ${JSON.stringify(await draft())}`);
  if (await mockEval(`const n = release("upload"); delete flags.upload; return n;`, url) !== 1) fail("the mock held no upload: the picked image was not uploaded at once");
  if (!await until(async () => { const x = await thumbs(); return x.length === 1 && !x[0].busy; }, 8000)) fail(`the thumbnail stays busy after the upload was answered: ${JSON.stringify(await thumbs())}`);
  if (!await until(async () => (await draft())?.images?.length === 1, 8000)) fail(`the uploaded image is not in the saved draft: ${JSON.stringify(await draft())}`);
  const first = (await draft())?.images?.[0];
  if (first && (Object.keys(first).join() !== "id,name,type,size" || first.name !== "diagram.png" || first.type !== "image/png" || first.size !== PNG_A.length)) fail(`the draft names the image as ${JSON.stringify(first)}`);
  if ((await send()).off) fail(`Send is off with an image and no text: ${JSON.stringify(await send())}`);
  // the thumbnail ends on the image's own address, and the image is there
  if (!await until(async () => (await thumbs())[0]?.src === `/api/chats/${chat}/images/${first?.id}`, 8000)) fail(`the thumbnail does not show the image's address: ${JSON.stringify(await thumbs())}`);
  if ((await thumbs())[0]?.broken) fail("the thumbnail of an uploaded image is the plain tile: its address did not load");

  // ---- a paste: files alone are images; with plain text and rich text the text wins
  if (!await paste([{ name: "image.png", type: "image/png", bytes: PNG_B }])) fail("a paste of an image file was not consumed");
  if (!await until(async () => { const x = await thumbs(); return x.length === 2 && !x[1].busy; }, 8000)) fail(`a pasted image has no thumbnail: ${JSON.stringify(await thumbs())}`);
  if ((await thumbs())[1]?.name !== "Pasted image") fail(`a pasted picture is named ${JSON.stringify((await thumbs())[1]?.name)}`);
  await paste([{ name: "image.png", type: "image/png", bytes: PNG_A }], { "text/plain": "B2 cell", "text/html": "<table><tr><td>B2 cell</td></tr></table>" });
  if (!await until(() => page.evaluate(() => document.querySelector(".composer .composer-input").textContent.includes("B2 cell")), 8000)) fail("a paste with plain text and rich text did not paste the text");
  if ((await thumbs()).length !== 2) fail(`a paste with plain text and rich text added an image: ${JSON.stringify(await thumbs())}`);
  // a file copied in a file manager: its name as plain text, no rich text; the same picture again is one image
  await paste([{ name: "diagram.png", type: "image/png", bytes: PNG_A }], { "text/plain": "diagram.png" });
  await until(async () => !(await thumbs()).some((x) => x.busy), 8000);
  if ((await thumbs()).length !== 2) fail(`the same picture added twice is not one image: ${JSON.stringify(await thumbs())}`);
  if (await page.evaluate(() => document.querySelector(".composer .composer-input").textContent.includes("diagram.png"))) fail("a paste of a copied file pasted its name as text");

  // ---- the draft is there after a reload, text and images
  if (!await until(async () => { const d = await draft(); return d?.text?.includes("B2 cell") && d.images?.length === 2; }, 8000)) fail(`the draft is not saved with its text and two images: ${JSON.stringify(await draft())}`);
  await page.reload();
  await page.waitForSelector(".composer-box .send", { timeout: 8000 });
  if (!await until(async () => (await thumbs()).length === 2, 8000)) fail(`after a reload the composer does not show the draft's images: ${JSON.stringify(await thumbs())}`);

  // ---- the remove control, and a message of images alone
  await page.locator(".composer .composer-images .img-thumb-remove").nth(1).click();
  if (!await until(async () => (await thumbs()).length === 1, 8000)) fail("the remove control did not take the image out of the strip");
  await page.evaluate(() => { const box = document.querySelector(".composer .composer-input"); box.focus(); document.execCommand("selectAll"); document.execCommand("delete"); });
  if (!await until(async () => { const d = await draft(); return d && !d.text && d.images?.length === 1; }, 8000)) fail(`the draft of an image alone is not saved as one: ${JSON.stringify(await draft())}`);
  if ((await send()).off) fail("Send is off for a message of an image alone");
  await page.locator(".composer .composer-tools .send:not(.stop)").click();
  const sent = await until(() => mockEval(`const u = listOf(${JSON.stringify(chat)}, curOf(chats[${JSON.stringify(chat)}])).filter((x) => x.kind === "user").at(-1); return u.images ? JSON.stringify(u) : "";`, url), 8000);
  if (!sent) fail("the message of an image alone did not reach the server with its image");
  else if (JSON.parse(sent).text !== "" || JSON.parse(sent).images[0]?.id !== first?.id) fail(`the message was sent as ${sent}`);
  if (!await until(async () => !(await thumbs()).length, 8000)) fail("the strip still has the image of the message that was sent");

  // ---- an upload the server refuses: its sentence in the error line, and no thumbnail left
  await mockEval(`flags.upload = { fail: [409, "the chat holds too many images that were not sent", "image_cap"] };`, url);
  await paste([{ name: "image.png", type: "image/png", bytes: PNG_B }]);
  if (!await until(async () => (await err()).includes("Pasted image was not added: the chat holds too many images that were not sent."), 8000)) fail(`a refused upload is not told in the error line: ${JSON.stringify(await err())}`);
  if ((await thumbs()).length) fail(`a refused upload left a thumbnail: ${JSON.stringify(await thumbs())}`);
  await mockEval("delete flags.upload;", url);
  await ctx.close();

  note("the attach button and a paste add images through one check; busy thumbnail, Send off while it uploads; the text wins a paste with rich text; the draft keeps its images over a reload; a message of an image alone is sent; a refused upload is told");
});
