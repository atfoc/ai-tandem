// Proves, in the page, the images of a chat of a section (plans/composer-images-goal.md, 3.11 "Images" and 3.12, as
// they are with remote servers as sections: plans/remote-server-sections-contract.md 3.4 and 3.10): such a chat takes
// an image as a local one does, by the same composer and the same calls under its server's prefix
// (/api/on/<entry id>/chats/<id>/images), and nothing of it is kept for it on this computer; while its server is
// not connected, the chat being open, the draft keeps its images (one the browser fetched before is drawn, one it
// never fetched is a plain tile with its name), paste and the attach button are off with the reason, Send is off as
// for anything of that chat, and no image can be removed (the chat is read-only: plans/remote-server-sections-goal.md
// 3.8); when the server is back a tile that could not be fetched is fetched again, an image can be removed, and what
// is left is saved; and an unstarted chat of a section takes an image at once.
// What the rules are is the unit tests' (test/chatimage.test.ts and beside it); here it is the page that does it,
// against the mock (dev/runmock.mjs), which answers the calls of a chat of a server that is not connected as the
// local server does (503). The composer of a local chat is IM3.2's.
import crypto from "node:crypto";
import { check, mockEval, openPage, paneSize, seed, until } from "../shot.mjs";

// Three pictures: two 1×1 PNGs that differ in their pixel, and a 1×1 GIF.
const png = (last) => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${last}AAAABJRU5ErkJggg==`, "base64");
const PNG_A = png("YPhfDwAChwGA60e6kg"), PNG_B = png("+M9QDwADhgGAWjR9aw"), GIF_C = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const LAB = "s_lab", LAB_NAME = "lab-gpu-box.tailnet-1234.ts.net";
const AWAY = `${LAB_NAME} is not connected`;
/** A chat's id on the lab box, from what the page names it by (the seed's `sel`). */
const own = (key) => key.slice(key.indexOf("~") + 1);

await check("R3.12 images of a chat of a section: taken as a local chat's, by the calls of its server; off while that server is away", async ({ url, browser, fail, note }) => {
  const states = await seed(url, "A2");
  const J = JSON.stringify;
  /** What the composer on a page shows of its images, its attach button, its Send and its error line. */
  const probes = (page) => ({
    thumbs: () => page.evaluate(() => [...document.querySelectorAll(".composer .composer-images .img-thumb")].map((e) => {
      const im = e.querySelector("img");
      return { name: e.getAttribute("title"), busy: e.classList.contains("busy"), broken: e.classList.contains("broken"), tile: e.querySelector(".img-thumb-name")?.getAttribute("data-text") ?? "",
        src: im?.getAttribute("src") ?? "", drawn: !!im && im.complete && im.naturalWidth > 0, remove: !!e.querySelector(".img-thumb-remove") };
    })),
    attach: () => page.evaluate(() => { const b = document.querySelector(".composer .composer-tools > .attach-btn"); return b ? { off: b.disabled, title: b.title } : null; }),
    send: () => page.evaluate(() => { const b = document.querySelector(".composer .composer-tools .send:not(.stop)"); return { off: b.disabled, title: b.title }; }),
    err: () => page.evaluate(() => document.querySelector(".composer .composer-err")?.textContent ?? ""),
    /** A paste of files into the composer's box; true: the paste was consumed. */
    paste: (files) => page.evaluate((files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = document.querySelector(".composer .composer-input");
      box.focus();
      return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") }))),
  });
  /** Code run on the lab box, the machine the chats are on. */
  const lab = (code) => mockEval(`return onServer(${J(LAB)}, () => { ${code} });`, url);
  const draft = (chat) => lab(`const c = chats[${J(chat)}]; return JSON.stringify(c.draft ?? null);`).then((x) => JSON.parse(x));
  const held = (chat) => lab(`return Object.keys(images[${J(chat)}] ?? {}).length;`);
  const image = (bytes, name, type) => ({ id: crypto.createHash("sha256").update(bytes).digest("hex"), name, type, size: bytes.length });
  /** Puts an image into a chat's store on the mock without the page: one the browser never fetched. */
  const hold = (chat, im, bytes) => lab(`(images[${J(chat)}] ??= {})[${J(im.id)}] = { ...${J(im)}, bytes: Buffer.from(${J(bytes.toString("base64"))}, "base64") };`);
  const serverIs = (state) => mockEval(`return setServerState(${J(LAB)}, ${J(state)});`, url);

  // ---- 3.11: a chat of a connected server takes an image as a local chat does, by that server's calls
  const s = states.find((x) => x.id === "plain-remote-started"), chat = own(s.sel.chat), ON = `/api/on/${LAB}/chats/${chat}`;
  let { ctx, page } = await openPage({ url, browser, sel: s.sel, ...paneSize("page", 900), wait: ".composer-box .send" });
  let p = probes(page);
  const uploads = [];
  page.on("request", (r) => { if (r.method() === "POST" && /\/images\?/.test(r.url())) uploads.push(new URL(r.url()).pathname); });
  const A = image(PNG_A, "Pasted image", "image/png");
  if ((await p.attach())?.off !== false || (await p.attach())?.title !== "Add images") fail(`the attach button of a chat of a connected server is ${J(await p.attach())}`);
  if (!await p.paste([{ name: "image.png", type: "image/png", bytes: PNG_A }])) fail("a paste of an image into a section's chat was not consumed");
  if (!await until(async () => { const t = await p.thumbs(); return t.length === 1 && !t[0].busy && t[0].src === `${ON}/images/${A.id}` && t[0].drawn; }, 10000)) fail(`a section's chat's pasted image is not a thumbnail on the chat's own address, under its server's prefix: ${J(await p.thumbs())}`);
  if (!await until(async () => J((await draft(chat))?.images) === J([A]), 10000)) fail(`the draft of the section's chat is not saved with the image: ${J(await draft(chat))}`);
  if (J(uploads) !== J([`${ON}/images`])) fail(`the upload went to ${J(uploads)}, not ${ON}/images`);
  if (await mockEval(`return Object.keys(worlds.local.images[${J(chat)}] ?? {}).length;`, url)) fail("this computer holds an image of the section's chat");
  if (await p.err()) fail(`the error line says ${J(await p.err())}`);
  if ((await p.send()).off) fail("Send is off for a section's chat's message of an image alone");

  // ---- 3.12: its server drops with the chat open. The draft has the image the browser fetched, and two it never did:
  // their fetches are held on their way, and reach the local server when that server is away
  const B = image(PNG_B, "never seen.png", "image/png"), C = image(GIF_C, "to remove.gif", "image/gif");
  await hold(chat, B, PNG_B); await hold(chat, C, GIF_C);
  let let_go = () => {};
  const gate = new Promise((ok) => { let_go = ok; });
  await page.route((u) => u.pathname === `${ON}/images/${B.id}` || u.pathname === `${ON}/images/${C.id}`, async (route) => { await gate; await route.continue(); });
  await lab(`setSession(${J(chat)}, curOf(chats[${J(chat)}]), { draft: { text: "", images: ${J([A, B, C])} }, draftRev: (chats[${J(chat)}].draftRev ?? 0) + 1 });`);
  if (!await until(async () => (await p.thumbs()).length === 3, 15000)) fail(`the draft changed on its server, the strip has ${J(await p.thumbs())}`);
  if (!await serverIs("unreachable")) fail("the mock has no entry for the lab box");
  await page.waitForSelector(".chat-page .remote-bar.off", { timeout: 10000 });
  let_go();
  if (!await until(async () => { const t = await p.thumbs(); return t.length === 3 && t[1].broken && t[2].broken; }, 15000)) fail(`with its server away the draft's images are not all in the strip, the unseen ones as tiles: ${J(await p.thumbs())}`);
  let t = await p.thumbs();
  if (t[0]?.broken || !await until(async () => (await p.thumbs())[0]?.drawn, 10000)) fail(`the thumbnail the browser fetched before does not show while the server is away: ${J((await p.thumbs())[0])}`);
  if (t[1]?.tile !== B.name || t[2]?.tile !== C.name) fail(`an image that cannot be fetched is not the plain tile with its name: ${J(t)}`);
  if (t.some((x) => x.remove)) fail(`a thumbnail has a remove control while the server is away, though the chat is read-only: ${J(t)}`);
  // paste and the attach button are off, with the reason; nothing is uploaded
  const off = await p.attach();
  if (!off?.off || off.title !== `${AWAY}: images can be added when it is back`) fail(`the attach button of a chat whose server is away is ${J(off)}`);
  if (!await p.paste([{ name: "new.png", type: "image/png", bytes: PNG_B }])) fail("a paste of an image was not consumed while the server is away");
  if (!await until(async () => (await p.err()).includes(`${AWAY}, not added: new.png.`), 10000)) fail(`the error line does not say why the pasted image was not added: ${J(await p.err())}`);
  if ((await p.thumbs()).length !== 3 || await held(chat) !== 3 || uploads.length !== 1) fail(`a paste while the server is away added or uploaded an image: ${J(await p.thumbs())}, ${await held(chat)} on the mock, uploads ${J(uploads)}`);
  // Send is off, as everything of a chat whose server is not connected, and says why
  if (!(await p.send()).off || !(await p.send()).title.startsWith(AWAY)) fail(`Send of a chat with images whose server is away is ${J(await p.send())}`);
  // the chat is read-only: no image leaves the draft, and nothing of it is saved
  await new Promise((r) => setTimeout(r, 1200)); // (a save's delay, and its refusal, if one were made)
  if ((await p.thumbs()).length !== 3 || (await draft(chat))?.images?.length !== 3) fail(`the draft of a chat whose server is not connected changed: ${J(await p.thumbs())}, ${J(await draft(chat))}`);
  // the server is back: the tile that could not be fetched is fetched, an image can be removed again and what is left is saved, and images are taken again
  await serverIs("connected");
  if (!await until(async () => { const x = await p.thumbs(); return x.length === 3 && x.every((y) => !y.broken && y.drawn && y.remove); }, 15000)) fail(`back, an image is still a tile, or has no remove control: ${J(await p.thumbs())}`);
  await page.locator(".composer .composer-images .img-thumb-remove").nth(2).click();
  if (!await until(async () => (await p.thumbs()).length === 2, 10000)) fail("back, the remove control did not take the image out of the strip");
  if (!await until(async () => J((await draft(chat))?.images) === J([A, B]), 15000)) fail(`the draft without the removed image was not saved once the server was back: ${J(await draft(chat))}`);
  if (!await until(async () => { const x = await p.thumbs(); return x.length === 2 && !x[1].broken && x[1].drawn; }, 15000)) fail(`the image that could not be fetched is still a tile after the server is back: ${J(await p.thumbs())}`);
  if (!await until(async () => (await p.attach())?.off === false, 10000)) fail(`the attach button stays off after the server is back: ${J(await p.attach())}`);
  // and the message goes out with its images, by the Send of any chat
  if (!await until(async () => !(await p.send()).off, 10000)) fail("Send stays off after the server is back");
  await page.locator(".composer .composer-tools .send:not(.stop)").click();
  const sent = await until(() => lab(`const u = listOf(${J(chat)}, curOf(chats[${J(chat)}])).filter((x) => x.kind === "user").at(-1); return u?.images ? JSON.stringify(u.images) : "";`), 10000);
  if (sent !== J([A, B])) fail(`the message of the section's chat was sent with the images ${sent}`);
  if (!await until(async () => (await page.locator(".thread .msg-images .img-thumb").count()) >= 2, 10000)) fail("the sent message does not show its images in the thread");
  await ctx.close();

  // ---- an unstarted chat of a section takes an image at once: it is on its server from the moment it was made
  const n = states.find((x) => x.id === "plain-remote-new"), fresh = own(n.sel.chat);
  ({ ctx, page } = await openPage({ url, browser, sel: n.sel, ...paneSize("page", 900), wait: ".composer-box .send" }));
  p = probes(page);
  if ((await p.attach())?.off !== false) fail(`the attach button of an unstarted chat of a section is ${J(await p.attach())}`);
  await page.locator(".composer .composer-input").click();
  await page.keyboard.type("with a picture");
  await p.paste([{ name: "image.png", type: "image/png", bytes: PNG_A }]);
  if (!await until(async () => { const x = await p.thumbs(); return x.length === 1 && !x[0].busy && x[0].src === `/api/on/${LAB}/chats/${fresh}/images/${A.id}`; }, 10000)) fail(`the unstarted chat did not take a pasted image by its server's calls: ${J(await p.thumbs())}`);
  if (!await until(async () => { const d = await draft(fresh); return d?.text === "with a picture" && d.images?.length === 1; }, 10000)) fail(`the unstarted chat's draft is ${J(await draft(fresh))}`);
  if (await p.err()) fail(`the error line of the unstarted chat says ${J(await p.err())}`);
  await ctx.close();
  note("a section's chat takes a pasted image by its server's calls and sends it, and this computer holds none of it; with its server away the draft keeps its images (the fetched one drawn, the others as tiles), paste, the attach button and Send are off with the reason and no image can be removed; an image is removed and the rest saved once the server is back; an unstarted chat of a section takes an image at once");
});
