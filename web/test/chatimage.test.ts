// Images in a chat's composer, the rules without the DOM (src/logic/chatimage.ts): what a paste adds, the one check
// every file goes through, what the error line says, the limits of one message, the model rule, why a chat takes no
// image now (its server is not connected, that server has not taken the chat yet), and what the desktop app's dialog
// returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  IMAGES_MESSAGE_BYTES, IMAGES_PER_MESSAGE, IMAGE_MAX_BYTES, IMAGE_TYPES, PASTED_NAME, UPLOADING,
  checkFiles, fileType, fromDesktop, goneLine, imageUrl, imagesBytes, imagesHold, imagesOff, noImagesLine, noImagesSend, overLimit, pastedImages, pastedName, plainImage, refusedLine,
  sameImages, uploadFailed, withImages, withoutImages, type FileLike,
} from "../src/logic/chatimage.ts";
import type { ChatImage } from "../src/types.ts";

const MB = 1024 * 1024;
const file = (name: string, type = "image/png", size = 1000): FileLike => ({ name, type, size });
const img = (n: number, size = 1000): ChatImage => ({ id: String(n).padStart(64, "0"), name: `i${n}.png`, type: "image/png", size });
const NONE = { count: 0, bytes: 0 };

// ---- the paste rule

test("paste: image files alone are added, and the paste is theirs", () => {
  const shot = file("image.png");
  assert.deepEqual(pastedImages({ plain: false, rich: false, files: [shot] }), [shot]);
  const two = [file("a.png"), file("b.jpg", "image/jpeg")];
  assert.deepEqual(pastedImages({ plain: false, rich: false, files: two }), two);
});

test("paste: a file copied in a file manager comes with its name as plain text and no rich text, and is an image to add", () => {
  const f = file("diagram.png");
  assert.deepEqual(pastedImages({ plain: true, rich: false, files: [f] }), [f]);
});

test("paste: with plain text and rich text the text wins (a copied spreadsheet cell), and nothing is added", () => {
  assert.deepEqual(pastedImages({ plain: true, rich: true, files: [file("image.png")] }), []);
});

test("paste: rich text without plain text does not win (a picture copied from a web page comes with its HTML)", () => {
  const f = file("image.png");
  assert.deepEqual(pastedImages({ plain: false, rich: true, files: [f] }), [f]);
});

test("paste: files that are not pictures are left out, and a paste of only such files goes on as it always did", () => {
  const pdf = file("notes.pdf", "application/pdf"), png = file("a.png");
  assert.deepEqual(pastedImages({ plain: true, rich: false, files: [pdf] }), []);
  assert.deepEqual(pastedImages({ plain: false, rich: false, files: [] }), []);
  assert.deepEqual(pastedImages({ plain: false, rich: false, files: [pdf, png] }), [png]);
});

test("paste: a picture of a type a chat does not take is still the paste's, so that the check can say why it is not added", () => {
  const svg = file("logo.svg", "image/svg+xml");
  assert.deepEqual(pastedImages({ plain: false, rich: false, files: [svg] }), [svg]);
  assert.deepEqual(checkFiles([svg], NONE).refused, [{ name: "logo.svg", reason: "type" }]);
  // a file that names no type is a picture by its name's ending
  const bare = file("photo.JPG", "");
  assert.deepEqual(pastedImages({ plain: true, rich: false, files: [bare, file("readme", "")] }), [bare]);
});

test("the name of a pasted picture is the fixed one; a file's own name stays", () => {
  assert.equal(PASTED_NAME, "Pasted image");
  for (const n of ["", "image.png", "image.jpeg", "IMAGE.PNG"]) assert.equal(pastedName(n), PASTED_NAME, n);
  for (const n of ["diagram.png", "my image.png", "image.final.png", "image"]) assert.equal(pastedName(n), n);
});

// ---- the one check

test("the limits and the types are the ones the server has (model.go)", () => {
  assert.deepEqual([IMAGE_MAX_BYTES, IMAGES_PER_MESSAGE, IMAGES_MESSAGE_BYTES], [5 * MB, 10, 20 * MB]);
  assert.deepEqual(IMAGE_TYPES, ["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const go = readFileSync(new URL("../../internal/model/model.go", import.meta.url), "utf8");
  assert.match(go, /ImageMaxBytes\s+= 5 << 20/);
  assert.match(go, /ImagesPerMessage\s+= 10\b/);
  assert.match(go, /ImagesMessageBytes\s+= 20 << 20/);
  assert.ok(go.includes(`var ImageTypes = []string{${IMAGE_TYPES.map((t) => `"${t}"`).join(", ")}}`));
});

test("the type a file is uploaded as: its own when a chat takes it, its name's ending when it says none", () => {
  assert.equal(fileType(file("a.png")), "image/png");
  assert.equal(fileType(file("a", "IMAGE/JPEG")), "image/jpeg");
  assert.equal(fileType(file("a.jpg", "image/jpg")), "image/jpeg");
  assert.equal(fileType(file("a.gif", "image/gif")), "image/gif");
  assert.equal(fileType(file("a.webp", "")), "image/webp");
  assert.equal(fileType(file("a.JPEG", "")), "image/jpeg");
  for (const f of [file("a.svg", "image/svg+xml"), file("a.png", "text/plain"), file("a.tiff", ""), file("a", ""), file("a.bmp", "image/bmp")]) assert.equal(fileType(f), "", f.name);
});

test("check: a file that passes is taken; one of another type or over the size is not, with why", () => {
  const ok = file("a.png"), gif = file("b.gif", "image/gif", IMAGE_MAX_BYTES), pdf = file("c.pdf", "application/pdf"), big = file("d.png", "image/png", IMAGE_MAX_BYTES + 1);
  assert.deepEqual(checkFiles([ok, pdf, gif, big], NONE), { take: [ok, gif], refused: [{ name: "c.pdf", reason: "type" }, { name: "d.png", reason: "size" }] });
});

test("check: the count of the message, with the images it has and the uploads that run", () => {
  const files = Array.from({ length: 4 }, (_, i) => file(`f${i}.png`));
  const r = checkFiles(files, { count: 8, bytes: 0 });
  assert.deepEqual(r.take, files.slice(0, 2));
  assert.deepEqual(r.refused, [{ name: "f2.png", reason: "count" }, { name: "f3.png", reason: "count" }]);
  assert.deepEqual(checkFiles(files, { count: IMAGES_PER_MESSAGE, bytes: 0 }).take, []);
  assert.equal(checkFiles(Array.from({ length: 11 }, (_, i) => file(`g${i}.png`)), NONE).take.length, IMAGES_PER_MESSAGE);
});

test("check: the total of the message; a file that is refused takes no room from the ones after it", () => {
  const four = file("four.png", "image/png", 4 * MB), five = file("five.png", "image/png", 5 * MB), one = file("one.png", "image/png", MB);
  // 12 MB are there: 4 fit (16), 5 would pass 20, 1 more does not (17)... and the last 4 would pass again
  const r = checkFiles([four, five, one, four], { count: 3, bytes: 12 * MB });
  assert.deepEqual(r.take, [four, one]);
  assert.deepEqual(r.refused, [{ name: "five.png", reason: "total" }, { name: "four.png", reason: "total" }]);
  // exactly the limit is taken
  assert.deepEqual(checkFiles([four], { count: 1, bytes: IMAGES_MESSAGE_BYTES - 4 * MB }).refused, []);
  // a file of another type or over the size counts for nothing
  const big = file("big.png", "image/png", 6 * MB);
  assert.deepEqual(checkFiles([big, file("x.txt", "text/plain", 30 * MB), four], { count: 9, bytes: 16 * MB }).take, [four]);
});

test("check: a chat that takes no image now takes none, whatever the file", () => {
  const files = [file("a.png"), file("b.pdf", "application/pdf")];
  assert.deepEqual(checkFiles(files, NONE, true), { take: [], refused: [{ name: "a.png", reason: "off" }, { name: "b.pdf", reason: "off" }] });
});

test("why a chat's composer takes no image now: its server is not connected, or the model takes none", () => {
  const here = { server: "This computer", connected: true, model: "" }, there = { server: "Studio", connected: true, model: "" };
  // a chat on this computer and a chat of a connected section take images alike, started or not
  assert.equal(imagesOff(here), null);
  assert.equal(imagesOff(there), null);
  // a server that is not connected. The reason names the server, and the tooltip says when images are taken again
  assert.deepEqual(imagesOff({ ...there, connected: false }), { line: "Studio is not connected", title: "Studio is not connected: images can be added when it is back" });
  // (a chat of a section is on its server from the moment it is made: there is no chat that server has not taken yet)
  assert.equal(imagesOff({ ...there, unmoved: true } as Parameters<typeof imagesOff>[0]), null);
  // 3.2: a model without image input, on either server
  assert.deepEqual(imagesOff({ ...here, model: "GLM 4.6" }), { line: "GLM 4.6 takes no images", title: noImagesLine("GLM 4.6") });
  assert.deepEqual(imagesOff({ ...there, model: "GLM 4.6" }), imagesOff({ ...here, model: "GLM 4.6" }));
  // the server comes first: nothing can be uploaded to it, whatever the chat and its model are
  assert.equal(imagesOff({ ...there, connected: false, model: "GLM 4.6" })?.line, "Studio is not connected");
  // a pasted image is refused with that reason, and the line names the file
  for (const o of [{ ...there, connected: false }, { ...here, model: "GLM 4.6" }]) {
    const off = imagesOff(o)!, r = checkFiles([file("Pasted image")], NONE, !!off);
    assert.deepEqual(r, { take: [], refused: [{ name: "Pasted image", reason: "off" }] });
    assert.equal(refusedLine(r.refused, off.line), `${off.line}, not added: Pasted image.`);
  }
  // neither holds a Send: a draft's images stay while its server is away, and Send follows the rule of a chat on another server
  assert.equal(imagesHold([img(1)], false, ""), "");
});

test("the error line says why each file was not added, naming it, one sentence per reason", () => {
  assert.equal(refusedLine([]), "");
  assert.equal(refusedLine([{ name: "c.pdf", reason: "type" }]), "Not a PNG, JPEG, GIF or WebP image: c.pdf.");
  assert.equal(refusedLine([{ name: "d.png", reason: "size" }, { name: "e.png", reason: "size" }]), "Over 5 MB: d.png, e.png.");
  assert.equal(refusedLine([{ name: "k.png", reason: "count" }]), "A message takes 10 images, not added: k.png.");
  assert.equal(refusedLine([{ name: "t.png", reason: "total" }]), "The images of a message can be 20 MB together, not added: t.png.");
  assert.equal(refusedLine([{ name: "r.png", reason: "read" }]), "Could not be read: r.png.");
  // a pasted image on a model without image input: the line names the model
  assert.equal(refusedLine([{ name: "Pasted image", reason: "off" }], noImagesLine("GLM 4.6")), "GLM 4.6 takes no images, not added: Pasted image.");
  assert.equal(refusedLine([{ name: "a.png", reason: "off" }, { name: "b.png", reason: "off" }], "Studio is not connected"), "Studio is not connected, not added: a.png, b.png.");
  assert.equal(refusedLine([{ name: "a.png", reason: "size" }, { name: "b.txt", reason: "type" }, { name: "c.png", reason: "count" }]),
    "Not a PNG, JPEG, GIF or WebP image: b.txt. Over 5 MB: a.png. A message takes 10 images, not added: c.png.");
});

test("an upload that failed and an image that is no longer there each have their line", () => {
  assert.equal(uploadFailed("a.png", "the image is larger than 5 MB."), "a.png was not added: the image is larger than 5 MB.");
  assert.equal(uploadFailed("a.png", "images for chats on another server come later"), "a.png was not added: images for chats on another server come later.");
  assert.equal(uploadFailed("a.png", ""), "a.png was not added: the upload failed.");
  assert.equal(goneLine(["a.png", "Pasted image"]), "No longer there, add again: a.png, Pasted image.");
  assert.equal(goneLine([]), "");
});

// ---- the images of one message

test("a list of images has each once, by its id; an image is named by its four fields", () => {
  const a = img(1), b = img(2), c = img(3);
  assert.deepEqual(withImages([a, b], [b, c, c]), [a, b, c]);
  assert.deepEqual(withImages([], [a]), [a]);
  assert.deepEqual(withImages([a], [{ ...a, name: "again.png" }]), [a]); // the same picture uploaded twice is one image
  assert.deepEqual(withoutImages([a, b, c], [b.id]), [a, c]);
  assert.deepEqual(withoutImages([a], []), [a]);
  assert.equal(sameImages([a, b], [{ ...a }, { ...b }]), true);
  assert.equal(sameImages([a, b], [b, a]), false);
  assert.equal(sameImages([a], [a, b]), false);
  assert.equal(imagesBytes([img(1, 5), img(2, 7)]), 12);
  // no bytes and nothing else goes into a draft
  assert.deepEqual(plainImage({ ...a, data: new Uint8Array(4), src: "blob:x" } as ChatImage), a);
  assert.deepEqual(Object.keys(plainImage({ size: 1, type: "image/png", name: "n", id: "i" })), ["id", "name", "type", "size"]);
});

test("the address of an image is the top-level chat's", () => {
  assert.equal(imageUrl("c_1", "ab12"), "/api/chats/c_1/images/ab12");
});

test("the address of an image of a section's chat is under that entry, with the chat's own id there", () => {
  const id = "0f".repeat(32);
  assert.equal(imageUrl("s_1~c_1", "ab12"), "/api/on/s_1/chats/c_1/images/ab12");
  assert.equal(imageUrl("s_0123456789ab~c_1", id), `/api/on/s_0123456789ab/chats/c_1/images/${id}`);
  assert.equal(imageUrl("s_2~c_1", "ab12"), "/api/on/s_2/chats/c_1/images/ab12", "the same chat id in another section is another chat");
  assert.ok(!imageUrl("s_1~c_1", "ab12").includes("~"), "the page's key is not on the wire");
  // each part is written as one path segment
  assert.equal(imageUrl("c 1", "a/b"), "/api/chats/c%201/images/a%2Fb");
  assert.equal(imageUrl("s 1~c 1", "a/b"), "/api/on/s%201/chats/c%201/images/a%2Fb");
});

test("over the limit: a message of more images than one takes, or of more bytes together, cannot be sent, and says what to do", () => {
  assert.equal(overLimit([]), "");
  assert.equal(overLimit(Array.from({ length: 10 }, (_, i) => img(i))), "");
  assert.equal(overLimit(Array.from({ length: 13 }, (_, i) => img(i))), "A message takes 10 images: remove 3 to send");
  assert.equal(overLimit(Array.from({ length: 4 }, (_, i) => img(i, 5 * MB))), "");
  assert.equal(overLimit(Array.from({ length: 5 }, (_, i) => img(i, 4 * MB + 1))), "The images of a message can be 20 MB together: remove some to send");
});

test("what holds a composer's Send for its images: an upload that runs, a model that takes none, a message over the limit", () => {
  assert.equal(imagesHold([], false, ""), "");
  assert.equal(imagesHold([img(1)], false, ""), "");
  // an upload runs: also with nothing held yet, and whatever else
  assert.equal(imagesHold([], true, ""), UPLOADING);
  assert.equal(imagesHold([img(1)], true, "GLM 4.6"), UPLOADING);
  // the model takes no images: only a message with images is held, until they are removed or another model is chosen
  assert.equal(imagesHold([], false, "GLM 4.6"), "");
  assert.equal(imagesHold([img(1)], false, "GLM 4.6"), "GLM 4.6 takes no images: remove the images or choose another model");
  assert.equal(noImagesSend("GLM 4.6"), `${noImagesLine("GLM 4.6")}: remove the images or choose another model`);
  assert.equal(noImagesLine("GLM 4.6"), "GLM 4.6 takes no images"); // the attach button's tooltip
  assert.equal(imagesHold(Array.from({ length: 11 }, (_, i) => img(i)), false, ""), "A message takes 10 images: remove 1 to send");
});

// ---- the desktop app's dialog

test("what the desktop app's dialog returns goes through the check as any file, and the files it left out are named", async () => {
  const data = new Uint8Array([137, 80, 78, 71]);
  const r = fromDesktop({ files: [{ name: "shot.png", type: "image/png", data }, { name: "doc.pdf", type: "application/pdf", data }], skipped: [{ name: "huge.png", reason: "size" }, { name: "gone.png", reason: "read" }] });
  assert.deepEqual(r.files.map((f) => [f.name, f.file.type, f.file.size]), [["shot.png", "image/png", 4], ["doc.pdf", "application/pdf", 4]]);
  assert.deepEqual([...new Uint8Array(await r.files[0].file.arrayBuffer())], [137, 80, 78, 71]);
  const checked = checkFiles(r.files.map((f) => ({ name: f.name, type: f.file.type, size: f.file.size })), NONE);
  assert.deepEqual(checked.take.map((f) => f.name), ["shot.png"]);
  assert.equal(refusedLine([...r.skipped, ...checked.refused]), "Not a PNG, JPEG, GIF or WebP image: doc.pdf. Over 5 MB: huge.png. Could not be read: gone.png.");
  assert.equal(refusedLine(fromDesktop({ files: [], skipped: [{ name: "x.svg", reason: "type" }, { name: "k.png", reason: "count" }] }).skipped),
    "Not a PNG, JPEG, GIF or WebP image: x.svg. A message takes 10 images, not added: k.png.");
});

test("a cancelled dialog, and an answer of another shape, give nothing", () => {
  assert.deepEqual(fromDesktop({ files: [], skipped: [] }), { files: [], skipped: [] });
  assert.deepEqual(fromDesktop(null), { files: [], skipped: [] });
  assert.deepEqual(fromDesktop({} as never), { files: [], skipped: [] });
  const odd = fromDesktop({ files: [{ name: "p.png", type: "image/png", data: "/etc/passwd" }, null], skipped: [{ name: "q.png", reason: "other" }, { reason: "size" }] } as never);
  assert.deepEqual(odd, { files: [], skipped: [{ name: "q.png", reason: "read" }] });
});

// ---- where the ways in are wired

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("a chat's composer takes pasted images and has the attach button; a run's goal box keeps its paste and gets no button", () => {
  const composer = src("Composer.tsx"), run = src("run/RunComposer.tsx"), box = src("RefInput.tsx"), strip = src("ComposerImages.tsx");
  // both ways go through the one check
  assert.ok(composer.includes("onImages={(files) => add(files.map((f) => ({ file: f, name: pastedName(f.name) })))}"));
  assert.ok(composer.includes("void pickImages().then((r) => { if (r.files.length || r.skipped.length) add(r.files, r.skipped); }"));
  assert.ok(composer.includes("addImages(chatId, branch, files, { has: held().images, off: noAdd?.line, skipped });"));
  assert.equal(composer.split("addImages(").length, 2);
  // and both are off for the same reason, which the button's tooltip and the refusal of a pasted file say (imagesOff)
  assert.ok(composer.includes("const noAdd = left ? { line: goneText(where.name), title: goneText(where.name) } : imagesOff({ server: where.name, connected: where.connected, model: noImages });"));
  assert.ok(!composer.includes("unmoved") && !src("logic/chatimage.ts").includes("unmoved"));
  assert.ok(composer.includes("<AttachButton off={noAdd?.title ?? \"\"} onClick={attach} />"));
  assert.ok(strip.includes("title={off || \"Add images\"} aria-label=\"Add images\" disabled={!!off}"));
  // the box asks the paste rule only where images are taken, and a paste of images is consumed
  assert.ok(box.includes("if (onImages) {") && box.includes("if (images.length) { e.preventDefault(); onImages(images); return; }"));
  assert.ok(box.includes("rich: types.includes(\"text/html\") || types.includes(\"text/rtf\")"));
  assert.doesNotMatch(run, /onImages|AttachButton|pickImages|ImageStrip|addImages/);
  // the desktop app's own dialog when the app has one, else the browser's picker
  assert.ok(strip.includes("if (typeof window.aiwbDesktop?.pickImages === \"function\") return fromDesktop(await window.aiwbDesktop.pickImages());"));
  assert.ok(strip.includes("input.type = \"file\"; input.multiple = true; input.accept = IMAGE_TYPES.join(\",\");"));
});

test("the composer's Send: enabled with images alone, held by imagesHold, and the images go out with the message and back when it fails", () => {
  const composer = src("Composer.tsx");
  assert.ok(composer.includes("if ((!t && !quotes.length && !images.length) || blocked || off || left || sending || isSending(chatId)) return;"));
  assert.ok(composer.includes("if (imagesHold(images, slotOf(chatId, branch).uploads.length > 0, noImages)) return;"));
  assert.ok(composer.includes("const imagesHeld = imagesHold(images, up.uploads.length > 0, noImages);"));
  assert.ok(composer.includes(") : imagesHeld && !blocked && !off && !left ? (\n            <button className=\"send\" title={imagesHeld} disabled>"));
  assert.ok(composer.includes("await sendMessage(chatId, t, p, toSend(qs), im);"));
  assert.ok(composer.includes("api.send(chat, branch, text, context, references, target, images)"));
  // a refused Send that names images the chat no longer holds: those stay out, and the line says what to add again
  assert.ok(composer.includes("const lost = e instanceof ApiError && e.images?.length ? im.filter((x) => e.images!.includes(x.id)) : [];"));
  assert.ok(composer.includes("if (!gone.current) imagesGone(chatId, branch, lost);"));
  // the model rule looks at the model the message goes to: the one chosen for a pending move's new branch, else the chat's
  assert.ok(composer.includes("const v = shownView(s, chatId), id = s.moves[chatId]?.model ?? v?.model;"));
  assert.ok(composer.includes("return m?.noImages ? m.label || m.id : \"\";"));
});
