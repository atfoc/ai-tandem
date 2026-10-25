// L18 (new; package K4): the composer's images where no old check looked (the inventory's C-IM rows 08, 19, 20, 21 and 29, and the limits of 09), on the real
// composer of the new build at the three viewports, against the mock.
//   C-IM-08/09  the picker takes ten images and not the 6 MB one nor the eleventh: the error line names each file with its sentence, one per reason
//   C-IM-29     ten thumbnails wrap inside the strip, each with its remove control standing out of its corner (a finger can reach it)
//   C-IM-20/21  a draft over what a message takes (eleven images, or 25 MB together; two drafts were joined) holds Send, with the sentence under the
//               thumbnails and as Send's title, until images are removed; not while an upload runs (that sentence is "An image is being uploaded")
//   C-IM-19     a model that takes no images: the attach button is off with "<model> takes no images", a paste is consumed and refused with the line, nothing
//               is uploaded, the draft's images stay, Send is off with the sentence until they are removed
// At the phone (ux-improvements C1): the picker is "+" -> Files; Send is read by aria-label (no `title`) and is absent while the box is empty (Talk) --
//               every draft here holds images, so it is there; "attach off" is the Files row waiting (disabled, with the reason in its note); the strip's lines
//               (`composer-images-line`) say what was left out ("A message takes 10 images: p11.png was left out."), a refused file is also a marked
//               tile; the strip wraps in tiles of 72 px with a remove control that is a 44 pt target standing out of the corner.
import { mockEval, seed, until } from "../shot.mjs";
import { byTid, press, tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

import { check } from "../shot.mjs";

const J = JSON.stringify;
const png = (extra) => Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kg==", "base64"), Buffer.from([extra])]);
const MB = 1024 * 1024;
const meta = (n, size, tag = "m") => Array.from({ length: n }, (_, i) => ({ id: `${tag}${String(i).padStart(2, "0")}`.padEnd(64, "0"), name: `${tag}${i}.png`, type: "image/png", size }));

await check("L18 the images of a composer: ten at most, 5 MB each, 20 MB together; a model with no images; the strip wraps", async ({ url, open, fail, note, viewport }) => {
  const phone = viewport === "phone";
  const reads = (page) => ({
    thumbs: () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-images"] [data-testid="image-thumb"]')].map((e) => {
      const r = e.getBoundingClientRect(), rm = e.querySelector('[data-testid="image-thumb-remove"]')?.getBoundingClientRect();
      return { name: e.getAttribute("aria-label"), busy: e.dataset.state === "busy", left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        remove: rm ? { right: rm.right, top: rm.top, cx: rm.left + rm.width / 2, cy: rm.top + rm.height / 2, w: rm.width, h: rm.height } : null };
    })),
    strip: () => page.evaluate(() => { const r = document.querySelector('[data-testid="composer"] [data-testid="composer-images"]')?.getBoundingClientRect(); return r ? { left: r.left, right: r.right, width: r.width } : null; }),
    send: () => page.evaluate(() => { const b = document.querySelector('[data-testid="composer"] [data-testid="send"]'); return b ? { off: b.disabled, title: b.title || b.getAttribute("aria-label") } : { off: true, title: "", none: true }; }),
    // (the phone: the Files row of the "+" sheet, opened and closed here; its note is the reason it waits)
    attach: async () => {
      if (!phone) return page.evaluate(() => { const b = document.querySelector('[data-testid="composer-tools"] [data-testid="attach-btn"]'); return { off: b.disabled, title: b.title }; });
      await press(page, byTid(page, "composer-plus"));
      const row = byTid(page, "action-row", { action: "files" });
      await row.waitFor({ state: "visible", timeout: 8000 });
      const label = await row.innerText(), off = await row.evaluate((e) => e.disabled || e.getAttribute("aria-disabled") === "true");
      await page.keyboard.press("Escape");
      await until(async () => !await byTid(page, "plus-sheet").count(), 5000);
      return { off, title: label.replace(/^Files\s*/, "").trim() };
    },
    // (the phone's strip says what was not added in its own lines, one each, besides the line under the composer)
    err: () => page.evaluate(() => [...document.querySelectorAll('[data-testid="composer"] [data-testid="composer-err"], [data-testid="composer"] [data-testid="composer-images-line"]')].map((e) => e.textContent).join(" ")),
    held: () => page.evaluate(() => document.querySelector('[data-testid="composer"] [data-testid="composer-images-note"]')?.textContent ?? ""),
    paste: (files) => page.evaluate((files) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      const box = document.querySelector('[data-testid="composer"] [data-testid="composer-input"]');
      box.focus();
      return !box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString("base64") }))),
  });
  /** A chat of the seed with a draft that holds these images (the chat holds a byte of each, so that a save of the draft names none missing; the
   *  picture itself is not one: a tile with the name stands for it). */
  const withDraft = async (images, text = "") => {
    const states = await seed(url, "A2"), s = states.find((x) => x.id === "plain-started");
    await holdOn(s.sel.chat, images);
    await mockEval(`setSession(${J(s.sel.chat)}, curOf(chats[${J(s.sel.chat)}]), { draft: { text: ${J(text)}, images: ${J(images)} }, draftRev: (chats[${J(s.sel.chat)}].draftRev ?? 0) + 1 });`, url);
    return s;
  };
  const holdOn = (chat, images) => mockEval(`for (const im of ${J(images)}) (images[${J(chat)}] ??= {})[im.id] = { ...im, bytes: Buffer.from([1]) };`, url);
  const uploaded = (chat) => mockEval(`return Object.keys(images[${J(chat)}] ?? {}).length;`, url);

  /** What opens the file chooser: the attach button, at the phone "+" and its Files row. */
  const pick = async (page) => { if (!phone) return press(page, byTid(page, "attach-btn").first()); await press(page, byTid(page, "composer-plus")); await press(page, byTid(page, "action-row", { action: "files" })); };

  // ---- the picker: ten images, the 6 MB one and the eleventh named in the line; ten thumbnails wrap inside the strip
  {
    const states = await seed(url, "A2"), s = states.find((x) => x.id === "plain-started");
    const { page, ctx } = await open({ sel: s.sel, wait: tidSel("composer-input") });
    const p = reads(page);
    const files = [{ name: "big.png", mimeType: "image/png", buffer: Buffer.concat([png(0), Buffer.alloc(6 * MB)]) }, ...Array.from({ length: 11 }, (_, i) => ({ name: `p${i + 1}.png`, mimeType: "image/png", buffer: png(i + 1) }))];
    const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: 8000 }), pick(page)]);
    await chooser.setFiles(files);
    if (!await until(async () => { const t = await p.thumbs(); return t.length === 10 && t.every((x) => !x.busy); }, 20000)) fail(`the picker did not leave ten thumbnails: ${J(await p.thumbs())}`);
    const said = phone ? "big.png is not added: over 5 MB. A message takes 10 images: p11.png was left out." : "Over 5 MB: big.png. A message takes 10 images, not added: p11.png.";
    if (await p.err() !== said) fail(`the error line says ${J(await p.err())}, not the sentences for big.png and p11.png`);
    if (await uploaded(s.sel.chat) !== 10) fail(`${await uploaded(s.sel.chat)} images reached the server, not ten`);
    const t = await p.thumbs(), strip = await p.strip();
    if (t.some((x) => x.left < strip.left - 0.5 || x.right > strip.right + 0.5)) fail(`a thumbnail lies outside the strip (${J(strip)}): ${J(t.map((x) => [x.left, x.right]))}`);
    const rows = new Set(t.map((x) => Math.round(x.top))).size;
    // (ten tiles of 64 px, nine gaps of 10 and the 6 px the remove controls stand out: 736 px; at the phone tiles of 72 px: 810 px, which no phone's strip has)
    if (phone ? rows < 2 : (strip.width < 730 && rows < 2) || (strip.width >= 740 && rows !== 1)) fail(`ten thumbnails in a strip ${Math.round(strip.width)} px wide stand in ${rows} rows`);
    if (t.some((x) => !x.remove || x.remove.right <= x.right + 1 || x.remove.top >= x.top - 1)) fail(`a remove control does not stand out of its thumbnail's corner: ${J(t)}`);
    if (phone && t.some((x) => !x.remove || x.remove.w < 43.5 || x.remove.h < 43.5)) fail(`a remove control is smaller than a 44 pt target: ${J(t.map((x) => x.remove && [x.remove.w, x.remove.h]))}`);
    if (phone && await byTid(page, "image-refused").count() !== 1) fail("the 6 MB file is no marked tile in the phone's strip");
    if ((await p.send()).off) fail(`Send is off with ten images: ${J(await p.send())}`);
    // the eleventh, pasted, is refused as the picker's was
    if (!await p.paste([{ name: "image.png", type: "image/png", bytes: png(99) }])) fail("a paste of an image was not consumed with ten images in the strip");
    if (!await until(async () => (await p.err()).includes(phone ? "A message takes 10 images: Pasted image was left out." : "A message takes 10 images, not added: Pasted image."), 8000)) fail(`the eleventh image, pasted, is not refused: ${J(await p.err())}`);
    if ((await p.thumbs()).length !== 10) fail("the eleventh image was added");
    await ctx.close();
  }

  // ---- a draft over what a message takes holds Send, with the sentence under the thumbnails, until images are removed
  for (const [images, line, count] of [[meta(11, 1000), "A message takes 10 images: remove 1 to send", 11], [meta(5, 5 * MB, "k"), "The images of a message can be 20 MB together: remove some to send", 5]]) {
    const s = await withDraft(images);
    const { page, ctx } = await open({ sel: s.sel, wait: tidSel("composer-input") });
    const p = reads(page);
    if (!await until(async () => (await p.thumbs()).length === count, 10000)) fail(`the draft's ${count} images are not in the strip: ${J(await p.thumbs())}`);
    if (await p.held() !== line) fail(`the note under the thumbnails is ${J(await p.held())}, not ${J(line)}`);
    if (!(await p.send()).off || (await p.send()).title !== line) fail(`Send is ${J(await p.send())} with ${J(line)} to say`);
    await press(page, byTid(page, "composer-images").locator(tidSel("image-thumb-remove")).first());
    if (!await until(async () => (await p.thumbs()).length === count - 1 && !(await p.held()), 10000)) fail(`after an image is removed the note stays or the strip is ${(await p.thumbs()).length}: ${J(await p.held())}`);
    if (!await until(async () => !(await p.send()).off, 10000)) fail(`Send stays off within the limit: ${J(await p.send())}`);
    await ctx.close();
  }

  // ---- a model that takes no images
  {
    const states = await seed(url, "A2"), s = states.find((x) => x.id === "plain-started");
    const kept = meta(1, 1000, "kept");
    await holdOn(s.sel.chat, kept);
    const before = await uploaded(s.sel.chat);
    await mockEval(`catalogs.claude.models.find((m) => m.id === "opus").noImages = true; setSession(${J(s.sel.chat)}, curOf(chats[${J(s.sel.chat)}]), { draft: { text: "", images: ${J(kept)} }, draftRev: (chats[${J(s.sel.chat)}].draftRev ?? 0) + 1 });`, url);
    const { page, ctx } = await open({ sel: s.sel, wait: tidSel("composer-input") });
    const p = reads(page);
    if (!await until(async () => (await p.thumbs()).length === 1, 10000)) fail(`the draft's image is not in the strip: ${J(await p.thumbs())}`);
    const off = await p.attach();
    if (!off.off || off.title !== "Opus 5.5 takes no images") fail(`the attach button of a model with no images is ${J(off)}`);
    if (!await p.paste([{ name: "new.png", type: "image/png", bytes: png(1) }])) fail("a paste of an image was not consumed on a model with no images");
    if (!await until(async () => (await p.err()) === (phone ? "Opus 5.5 takes no images: new.png was not added." : "Opus 5.5 takes no images, not added: new.png."), 8000)) fail(`the line for a paste on a model with no images is ${J(await p.err())}`);
    if ((await p.thumbs()).length !== 1 || await uploaded(s.sel.chat) !== before) fail(`an image was added or uploaded on a model with no images: ${J(await p.thumbs())}, ${await uploaded(s.sel.chat)} on the mock`);
    const sentence = "Opus 5.5 takes no images: remove the images or choose another model";
    if (!(await p.send()).off || (await p.send()).title !== sentence) fail(`Send of a draft with images on a model with no images is ${J(await p.send())}`);
    if (await p.held() !== sentence) fail(`the note under the thumbnails is ${J(await p.held())}`);
    await press(page, byTid(page, "composer-images").locator(tidSel("image-thumb-remove")).first());
    if (!await until(async () => !(await p.thumbs()).length, 10000)) fail("the image of a model with no images could not be removed");
    if ((await p.attach()).title !== "Opus 5.5 takes no images") fail("the attach button of a model with no images changed with the strip");
    await ctx.close();
  }
  note("the picker takes ten images and names the 6 MB one and the eleventh; ten thumbnails wrap inside the strip, each remove control out of its corner; a draft over 10 images or 20 MB holds Send with the sentence under the thumbnails until images are removed; a model with no images: the attach button off, a paste refused with the line, the draft's image stays, Send off with the sentence");
}, { viewports, page: false });
