// Proves, on the new build, the thread side of the images of a chat of a section (plans/composer-images-goal.md, 3.11 "Images" and 3.12, as they
// are with remote servers as sections: plans/remote-server-sections-contract.md 3.4 and 3.10; package S10: B-IM-01, B-IM-12, D-PC-09, D-PC-12), at
// desktop, tablet and phone: a sent message of a chat of a section shows its images, each fetched from that section's server by the chat's own
// id there (the address is the one the transport gives: the host's on the http way) and nothing of it is kept on this computer; while that server
// is not connected, the chat being open, the thumbnail the page fetched before is drawn and one it never fetched is a plain tile with its name and
// nothing to open; when the server is back the tile that could not be fetched is fetched again (the thread's own re-fetch, B-IM-12, which the
// old check did not look at).
// Ports dev/checks/R3.12-images.mjs in two halves. S10's, the thread (same seed A2, same three pictures, the same gate on the fetches the page never made,
// the same server dropped and back; B-IM-01, B-IM-12, D-PC-09, D-PC-12); and K4's, the composer's strip of a chat of a section, with the old body's
// assertions and failure lines (C-IM-01, 11, 22, 23, 24, C-RO-04): the pasted image becomes a thumbnail on the chat's own address, the draft is saved with
// it, paste and the attach button are off with the reason while the server is away, no remove control, remove and save when it is back, an unstarted
// chat takes an image at once. The strip's thumbnail is screens/images/ImageThumb.tsx (testIDs `image-thumb` (dataSet `state`), `image-thumb-busy`,
// `image-thumb-remove`) in screens/composerimages/ImageStrip.tsx (`composer-images`).
// At the phone (ux-improvements C1; the window's width decides, under 700 px): the empty box shows Talk, so the composer half waits for the box
// (`composer-input`); the attach button is "+" -> the sheet's Files row (the web's only image row), "off" is the row waiting (disabled, its note the
// reason; the sheet is read and closed with Esc); Send exists once there is an image or text and says its words by aria-label (it has no `title`);
// the words about a file that was not added are the strip's lines (`composer-images-line`) besides `composer-err`; while the chat's server is away
// the "+" itself is disabled (nothing to open), and the reason read is the one Send's aria-label gives.
import crypto from "node:crypto";
import { callOfRequest, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, layoutNow, press, tidSel } from "./sel.mjs";
import { WAIT } from "./chat.mjs";

export const viewports = ["desktop", "tablet", "phone"];

// Three pictures: two 1×1 PNGs that differ in their pixel, and a 1×1 GIF.
const png = (last) => Buffer.from(`iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk${last}AAAABJRU5ErkJggg==`, "base64");
const PNG_A = png("YPhfDwAChwGA60e6kg"), PNG_B = png("+M9QDwADhgGAWjR9aw"), GIF_C = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const LAB = "s_lab";
/** A chat's id on the lab box, from what the page names it by (the seed's `sel`). */
const own = (key) => key.slice(key.indexOf("~") + 1);
const J = JSON.stringify;
const image = (bytes, name, type) => ({ id: crypto.createHash("sha256").update(bytes).digest("hex"), name, type, size: bytes.length });

await check("R3.12 the images of a chat of a section: fetched from its server by the chat's own id; while it is away the fetched one is drawn and the others are tiles; fetched again when it is back", async ({ url, open, viewport, fail, note }) => {
  const states = await seed(url, "A2");
  const s = states.find((x) => x.id === "plain-remote-started"), chat = own(s.sel.chat), PIC = `/host/picture/${LAB}/${chat}`;
  const A = image(PNG_A, "seen.png", "image/png"), B = image(PNG_B, "never seen.png", "image/png"), C = image(GIF_C, "to fetch.gif", "image/gif");
  /** Waits until the page shows that the section's server is away: the bar (`remote-bar`, kind off) on the wide layouts; the phone draws no bar, its header's sub-line says
   *  "● <server> · offline" and the header knows the chat is shown as it was (`chat-head` data-frozen). */
  const awayShown = async (page) => {
    if (viewport !== "phone") return byTid(page, "remote-bar", { kind: "off" }).first().waitFor({ state: "attached", timeout: WAIT });
    await byTid(page, "chat-head", { frozen: "true" }).first().waitFor({ state: "attached", timeout: WAIT });
    const sub = await byTid(page, "chat-head-sub").first().textContent({ timeout: WAIT });
    if (!/· offline$/.test(sub ?? "")) fail(`the phone's header does not say that the section's server is offline: ${J(sub)}`);
  };
  /** Code run on the lab box, the machine the chats are on. */
  const lab = (code) => mockEval(`return onServer(${J(LAB)}, () => { ${code} });`, url);
  const hold = (im, bytes) => lab(`(images[${J(chat)}] ??= {})[${J(im.id)}] = { ...${J(im)}, bytes: Buffer.from(${J(bytes.toString("base64"))}, "base64") };`);
  const serverIs = (state) => mockEval(`return setServerState(${J(LAB)}, ${J(state)});`, url);
  // a sent message of the chat holds the three images; the box has the bytes of each
  await hold(A, PNG_A); await hold(B, PNG_B); await hold(C, GIF_C);
  await lab(`items[${J(chat)}].push({ kind: "user", text: "", images: ${J([A, B, C])} }, say("Three pictures."), { kind: "end" });`);

  const { page, ctx: thread } = await open({ sel: s.sel, wait: '[data-testid="msg-images"]' });
  const thumbs = () => page.evaluate(() => [...document.querySelectorAll('[data-testid="msg-images"] [data-testid="image-thumb"]')].map((e) => {
    const im = e.querySelector("img");
    return { name: e.getAttribute("aria-label"), state: e.dataset.state, src: im?.getAttribute("src") ?? "", drawn: !!im && im.complete && im.naturalWidth > 0,
      tile: e.querySelector(".aiwb-tile-name")?.getAttribute("data-text") ?? "", opens: !!e.querySelector('[data-testid="image-thumb-open"]') };
  }));
  const uploads = [];
  page.on("request", (r) => { const c = callOfRequest(r); if (c?.method === "POST" && /\/images\?/.test(c.path)) uploads.push(c.path); });

  // ---- connected: each image is fetched from the section's server by the chat's own id there, and shown
  if (!await until(async () => { const t = await thumbs(); return t.length === 3 && t.every((x) => x.drawn && x.opens && x.src === `${PIC}/${[A, B, C][t.indexOf(x)].id}`); }, WAIT)) fail(`the sent message of a section's chat does not show its three images on their server's address ${PIC}/<id>: ${J(await thumbs())}`);
  if (await mockEval(`return Object.keys(worlds.local.images[${J(chat)}] ?? {}).length;`, url)) fail("this computer holds an image of the section's chat");

  // the phone's thumbnails are 116 x 140 pt (goal 3.5)
  if (viewport === "phone") {
    const sizes = await page.evaluate(() => [...document.querySelectorAll('[data-testid="msg-images"] [data-testid="image-thumb"]')].map((e) => `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}`));
    if (sizes.length !== 3 || sizes.some((x) => x !== "116x140")) fail(`the phone's thumbnails of a section's chat are ${sizes}; they are 116x140`);
  }

  // ---- its server drops with the chat open. The first image was fetched; the other two are fetched by the page again only now, their fetches held on
  // their way, and reach the local server when that server is away
  let let_go = () => {};
  const gate = new Promise((ok) => { let_go = ok; });
  await page.route((u) => u.pathname === `${PIC}/${B.id}` || u.pathname === `${PIC}/${C.id}`, async (route) => { await gate; await route.continue(); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="msg-images"]', { timeout: WAIT });
  if (!await until(async () => (await thumbs())[0]?.drawn, WAIT)) fail(`the first image is not drawn after the page was loaded again: ${J(await thumbs())}`);
  if (!await serverIs("unreachable")) fail("the mock has no entry for the lab box");
  await awayShown(page);
  let_go();
  if (!await until(async () => { const t = await thumbs(); return t.length === 3 && t[1].state === "broken" && t[2].state === "broken"; }, WAIT)) fail(`with its server away the images are not all in the thread, the ones never fetched as tiles: ${J(await thumbs())}`);
  let t = await thumbs();
  if (t[0]?.state === "broken" || !t[0]?.drawn) fail(`the thumbnail the page fetched before does not show while the server is away: ${J(t[0])}`);
  if (t[1]?.tile !== B.name || t[2]?.tile !== C.name) fail(`an image that cannot be fetched is not the plain tile with its name: ${J(t)}`);
  if (t[1]?.opens || t[2]?.opens) fail(`a plain tile has something to open: ${J(t)}`);
  if (!t[0]?.opens) fail("the thumbnail that is drawn has nothing to open while the server is away");

  // the phone's viewer of the picture that is drawn: Ask about it is off while the server is away, and says why as its label's second line
  if (viewport === "phone") {
    await press(page, byTid(page, "msg-images").locator(tidSel("image-thumb-open")).first());
    await page.waitForSelector(tidSel("image-large"), { timeout: WAIT });
    const ask = byTid(page, "image-large-ask").first();
    const away = { off: await ask.getAttribute("aria-disabled"), why: await byTid(page, "image-large-ask-why").first().textContent().catch(() => null), label: await ask.getAttribute("aria-label") };
    if (away.off !== "true" || !away.why?.endsWith("is not connected") || away.label !== `Ask about it, ${away.why}`) fail(`with the section's server away the viewer's Ask about it is ${J(away)}; it is off, with “<server> is not connected” as its second line`);
    await press(page, ask).catch(() => {});
    if (!await page.locator(tidSel("image-large")).count()) fail("a press on Ask about it, which is off, closed the viewer");
    await press(page, byTid(page, "image-large-close"));
    await until(async () => !(await page.locator(tidSel("image-large")).count()), WAIT);
  }

  // ---- the server is back: the tile that could not be fetched is fetched again
  await serverIs("connected");
  if (!await until(async () => { const x = await thumbs(); return x.length === 3 && x.every((y) => y.state === "loaded" && y.drawn && y.opens); }, WAIT)) fail(`back, an image is still a tile, or cannot be opened: ${J(await thumbs())}`);
  t = await thumbs();
  if (t.some((x, i) => x.src !== `${PIC}/${[A, B, C][i].id}`)) fail(`back, the images are not on their server's address: ${J(t)}`);
  if (uploads.length) fail(`the thread uploaded an image: ${J(uploads)}`);
  await thread.close(); // (the mock has one stream: two pages open take it from each other)

  // ================= K4's half: the composer's strip of a chat of a section (the old check's body, same assertions) =================
  await composerHalf();
  async function composerHalf() {
    const states = await seed(url, "A2"); // (starts the sections' states over: the thread half changed them)
    const AWAY = "lab-gpu-box.tailnet-1234.ts.net is not connected";
    const blockWords = (page) => page.evaluate(() => (document.querySelector('[data-testid="composer-block"]')?.textContent ?? "").trim());
    const probes = (page) => ({
      thumbs: () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-images"] [data-testid="image-thumb"]')].map((e) => {
        const im = e.querySelector("img");
        return { name: e.getAttribute("aria-label"), busy: e.dataset.state === "busy", broken: e.dataset.state === "broken", tile: e.querySelector(".aiwb-tile-name")?.getAttribute("data-text") ?? "",
          src: im?.getAttribute("src") ?? "", drawn: !!im && im.complete && im.naturalWidth > 0, remove: !!e.querySelector('[data-testid="image-thumb-remove"]') };
      })),
      attach: async () => {
        if (layoutNow(page) !== "phone") return page.evaluate(() => { const b = document.querySelector('[data-testid="composer-tools"] [data-testid="attach-btn"]'); return b ? { off: b.disabled, title: b.title } : null; });
        // (the phone: the Files row of the "+" sheet, opened and closed here; its note is what the button's title is: what it adds, or why it waits)
        // (a chat that is read-only, its server away, has "+" itself disabled -- there is no sheet to open; the reason is the one the composer gives
        // for Send, and for Talk: the phone's design, where the wide composer's attach button carries it as its title)
        const plus = byTid(page, "composer-plus").first();
        // (V1, goal 3.7.1: a server that is away puts its block in the toolbar's place -- "<Server> is offline since 14:02. Your draft is kept." -- so the "+" is gone
        // and the block's sentence is the reason, said once; the old page's "<host> is not connected" is the wide layouts' still)
        if (!await plus.count()) return { off: true, title: await blockWords(page), plus: true, gone: true };
        if (await plus.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true"))
          return { off: true, title: await page.evaluate(() => document.querySelector('[data-testid="composer"] [data-testid="send"]')?.getAttribute("aria-label") ?? ""), plus: true };
        await press(page, plus);
        const row = byTid(page, "action-row", { action: "files" });
        await row.waitFor({ state: "visible", timeout: 8000 });
        const label = await row.innerText(), off = await row.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true");
        await page.keyboard.press("Escape");
        await until(async () => !await byTid(page, "plus-sheet").count(), 5000);
        return { off, title: label.replace(/^Files\s*/, "").trim() };
      },
      // (the phone's Send has no `title`: its words are its aria-label; it is absent while the box is empty, which is "off")
      // (no Send either while the block is in the toolbar's place: its sentence is then the reason)
      send: async () => { const r = await page.evaluate(() => { const b = document.querySelector('[data-testid="composer"] [data-testid="send"]'); return b ? { off: b.disabled, title: b.title || b.getAttribute("aria-label") || "" } : { off: true, title: "", none: true }; }); return r.none && layoutNow(page) === "phone" ? { ...r, title: await blockWords(page) } : r; },
      err: () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-err"], [data-testid="composer"] [data-testid="composer-images-line"]')].map((e) => e.textContent).join(" ")),
      /** A paste of files into the composer's box; true: the paste was consumed. */
      paste: (files) => page.evaluate((files) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
        const box = document.querySelector('[data-testid="composer"] [data-testid="composer-input"]');
        box.focus();
        return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      }, files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") }))),
    });
    const draft = (c) => lab(`const c = chats[${J(c)}]; return JSON.stringify(c.draft ?? null);`).then((x) => JSON.parse(x));
    const held = (c) => lab(`return Object.keys(images[${J(c)}] ?? {}).length;`);
    const holdIn = (c, im, bytes) => lab(`(images[${J(c)}] ??= {})[${J(im.id)}] = { ...${J(im)}, bytes: Buffer.from(${J(bytes.toString("base64"))}, "base64") };`);

    // ---- 3.11: a chat of a connected server takes an image as a local chat does, by that server's calls
    const s = states.find((x) => x.id === "plain-remote-started"), chat = own(s.sel.chat), ON = `${LAB} /api/chats/${chat}`, PIC = `/host/picture/${LAB}/${chat}`;
    let { ctx, page } = await open({ sel: s.sel, wait: tidSel("composer-input") });
    let p = probes(page);
    const ups = [];
    page.on("request", (r) => { const c = callOfRequest(r); if (c?.method === "POST" && /\/images\?/.test(c.path)) ups.push(`${c.server} ${c.path.split("?")[0]}`); });
    const A = image(PNG_A, "Pasted image", "image/png");
    if ((await p.attach())?.off !== false || (await p.attach())?.title !== (layoutNow(page) === "phone" ? "Images from this computer" : "Add images")) fail(`the attach button of a chat of a connected server is ${J(await p.attach())}`);
    if (!await p.paste([{ name: "image.png", type: "image/png", bytes: PNG_A }])) fail("a paste of an image into a section's chat was not consumed");
    if (!await until(async () => { const t = await p.thumbs(); return t.length === 1 && !t[0].busy && t[0].src === `${PIC}/${A.id}` && t[0].drawn; }, 10000)) fail(`a section's chat's pasted image is not a thumbnail on the chat's own address, under its server's prefix: ${J(await p.thumbs())}`);
    if (!await until(async () => J((await draft(chat))?.images) === J([A]), 10000)) fail(`the draft of the section's chat is not saved with the image: ${J(await draft(chat))}`);
    if (J(ups) !== J([`${ON}/images`])) fail(`the upload went to ${J(ups)}, not ${ON}/images`);
    if (await mockEval(`return Object.keys(worlds.local.images[${J(chat)}] ?? {}).length;`, url)) fail("this computer holds an image of the section's chat");
    if (await p.err()) fail(`the error line says ${J(await p.err())}`);
    if ((await p.send()).off) fail("Send is off for a section's chat's message of an image alone");

    // ---- 3.12: its server drops with the chat open. The draft has the image the browser fetched, and two it never did:
    // their fetches are held on their way, and reach the local server when that server is away
    const B = image(PNG_B, "never seen.png", "image/png"), C = image(GIF_C, "to remove.gif", "image/gif");
    await holdIn(chat, B, PNG_B); await holdIn(chat, C, GIF_C);
    let go = () => {};
    const gate2 = new Promise((ok) => { go = ok; });
    await page.route((u) => u.pathname === `${PIC}/${B.id}` || u.pathname === `${PIC}/${C.id}`, async (route) => { await gate2; await route.continue(); });
    await lab(`setSession(${J(chat)}, curOf(chats[${J(chat)}]), { draft: { text: "", images: ${J([A, B, C])} }, draftRev: (chats[${J(chat)}].draftRev ?? 0) + 1 });`);
    if (!await until(async () => (await p.thumbs()).length === 3, 15000)) fail(`the draft changed on its server, the strip has ${J(await p.thumbs())}`);
    if (!await serverIs("unreachable")) fail("the mock has no entry for the lab box");
    await awayShown(page);
    go();
    if (!await until(async () => { const t = await p.thumbs(); return t.length === 3 && t[1].broken && t[2].broken; }, 15000)) fail(`with its server away the draft's images are not all in the strip, the unseen ones as tiles: ${J(await p.thumbs())}`);
    let t = await p.thumbs();
    if (t[0]?.broken || !await until(async () => (await p.thumbs())[0]?.drawn, 10000)) fail(`the thumbnail the browser fetched before does not show while the server is away: ${J((await p.thumbs())[0])}`);
    if (t[1]?.tile !== B.name || t[2]?.tile !== C.name) fail(`an image that cannot be fetched is not the plain tile with its name: ${J(t)}`);
    if (t.some((x) => x.remove)) fail(`a thumbnail has a remove control while the server is away, though the chat is read-only: ${J(t)}`);
    // paste and the attach button are off, with the reason; nothing is uploaded
    const off = await p.attach();
    if (!off?.off || (off.plus ? !(off.gone ? /\bis offline\b/.test(off.title) : off.title.startsWith(AWAY)) : off.title !== `${AWAY}: images can be added when it is back`)) fail(`the attach button of a chat whose server is away is ${J(off)}`);
    if (!await p.paste([{ name: "new.png", type: "image/png", bytes: PNG_B }])) fail("a paste of an image was not consumed while the server is away");
    if (!await until(async () => (await p.err()).includes(layoutNow(page) === "phone" ? `${AWAY}: new.png was not added.` : `${AWAY}, not added: new.png.`), 10000)) fail(`the error line does not say why the pasted image was not added: ${J(await p.err())}`);
    if ((await p.thumbs()).length !== 3 || await held(chat) !== 3 || ups.length !== 1) fail(`a paste while the server is away added or uploaded an image: ${J(await p.thumbs())}, ${await held(chat)} on the mock, uploads ${J(ups)}`);
    // Send is off, as everything of a chat whose server is not connected, and says why
    if (!(await p.send()).off || !(layoutNow(page) === "phone" ? /\bis offline\b/.test((await p.send()).title) : (await p.send()).title.startsWith(AWAY))) fail(`Send of a chat with images whose server is away is ${J(await p.send())}`);
    // the chat is read-only: no image leaves the draft, and nothing of it is saved
    await new Promise((r) => setTimeout(r, 1200)); // (a save's delay, and its refusal, if one were made)
    if ((await p.thumbs()).length !== 3 || (await draft(chat))?.images?.length !== 3) fail(`the draft of a chat whose server is not connected changed: ${J(await p.thumbs())}, ${J(await draft(chat))}`);
    // the server is back: the tile that could not be fetched is fetched, an image can be removed again and what is left is saved, and images are taken again
    await serverIs("connected");
    if (!await until(async () => { const x = await p.thumbs(); return x.length === 3 && x.every((y) => !y.broken && y.drawn && y.remove); }, 15000)) fail(`back, an image is still a tile, or has no remove control: ${J(await p.thumbs())}`);
    await press(page, byTid(page, "composer-images").locator(tidSel("image-thumb-remove")).nth(2));
    if (!await until(async () => (await p.thumbs()).length === 2, 10000)) fail("back, the remove control did not take the image out of the strip");
    if (!await until(async () => J((await draft(chat))?.images) === J([A, B]), 15000)) fail(`the draft without the removed image was not saved once the server was back: ${J(await draft(chat))}`);
    if (!await until(async () => { const x = await p.thumbs(); return x.length === 2 && !x[1].broken && x[1].drawn; }, 15000)) fail(`the image that could not be fetched is still a tile after the server is back: ${J(await p.thumbs())}`);
    if (!await until(async () => (await p.attach())?.off === false, 10000)) fail(`the attach button stays off after the server is back: ${J(await p.attach())}`);
    // and the message goes out with its images, by the Send of any chat
    if (!await until(async () => !(await p.send()).off, 10000)) fail("Send stays off after the server is back");
    await press(page, byTid(page, "send").first());
    const sent = await until(() => lab(`const u = listOf(${J(chat)}, curOf(chats[${J(chat)}])).filter((x) => x.kind === "user").at(-1); return u?.images ? JSON.stringify(u.images) : "";`), 10000);
    if (sent !== J([A, B])) fail(`the message of the section's chat was sent with the images ${sent}`);
    if (!await until(async () => (await page.locator(`${tidSel("msg-images")} ${tidSel("image-thumb")}`).count()) >= 2, 10000)) fail("the sent message does not show its images in the thread");
    await ctx.close();

    // ---- an unstarted chat of a section takes an image at once: it is on its server from the moment it was made
    const n = states.find((x) => x.id === "plain-remote-new"), fresh = own(n.sel.chat);
    ({ ctx, page } = await open({ sel: n.sel, wait: tidSel("composer-input") }));
    p = probes(page);
    if ((await p.attach())?.off !== false) fail(`the attach button of an unstarted chat of a section is ${J(await p.attach())}`);
    await press(page, byTid(page, "composer-input").first());
    await page.keyboard.type("with a picture");
    await p.paste([{ name: "image.png", type: "image/png", bytes: PNG_A }]);
    if (!await until(async () => { const x = await p.thumbs(); return x.length === 1 && !x[0].busy && x[0].src === `/host/picture/${LAB}/${fresh}/${A.id}`; }, 10000)) fail(`the unstarted chat did not take a pasted image by its server's calls: ${J(await p.thumbs())}`);
    if (!await until(async () => { const d = await draft(fresh); return d?.text === "with a picture" && d.images?.length === 1; }, 10000)) fail(`the unstarted chat's draft is ${J(await draft(fresh))}`);
    if (await p.err()) fail(`the error line of the unstarted chat says ${J(await p.err())}`);
    await ctx.close();
  }
  note("a sent message of a section's chat shows its images from that server's address by the chat's own id; with the server away the fetched one is drawn and the others are plain tiles with their names and nothing to open; back, the tiles are fetched again; this computer holds none of it"
    + "; the composer's strip: a section's chat takes a pasted image by its server's calls and sends it; with its server away the draft keeps its images, paste, the attach button and Send are off with the reason and no image can be removed; an image is removed and the rest saved once the server is back; an unstarted chat of a section takes an image at once");
}, { viewports, page: false });
