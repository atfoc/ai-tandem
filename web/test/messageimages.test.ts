// A sent message's images: what the thread draws of the message, and the one fixed word that names a message of images
// alone wherever the page names a message by its words (the tree, the move banner, a branch's name, the chat's title).
import { test } from "node:test";
import assert from "node:assert/strict";
import { IMAGE_WORD, imageUrl } from "../src/logic/chatimage.ts";
import { largeCaption, showsText, shownImages, stepImage } from "../src/logic/messageimages.ts";
import { nameText } from "../src/logic/quotes.ts";
import { chatTitle } from "../src/logic/labels.ts";
import { toTreeItems } from "../src/logic/forkpoints.ts";
import { buildTree, nameOfBranch, preview, rows, withLive } from "../src/logic/forktree.ts";
import { bannerOf, bannerText } from "../src/logic/branchview.ts";
import type { ChatImage, Item, Reference, TreeView } from "../src/types.ts";

const ID = "a".repeat(64), ID2 = "b".repeat(64);
const png = (id = ID, name = "shot.png"): ChatImage => ({ id, name, type: "image/png", size: 1200 });
const quote: Reference = { quote: "the plan", item: 1, start: 0, end: 8 };
/** A message of images alone, as the server sends it: no words. */
const pictures = (...images: ChatImage[]): Item => ({ kind: "user", text: "", images: images.length ? images : [png()] });

// ---- what the thread draws

test("a message of images alone draws no words, one with words draws them under the images", () => {
  assert.equal(showsText({ text: "", images: [png()] }), false);
  assert.equal(showsText({ images: [png()] }), false);
  assert.equal(showsText({ text: " \n", images: [png()] }), false);
  assert.equal(showsText({ text: "look at this", images: [png()] }), true);
  assert.equal(showsText({ text: "", references: [quote], images: [png()] }), false);
});

test("a message without images draws its words as before: quotes alone have none, an empty message is still there", () => {
  assert.equal(showsText({ text: "plain" }), true);
  assert.equal(showsText({ text: "", references: [quote] }), false);
  assert.equal(showsText({ text: "answer", references: [quote] }), true);
  assert.equal(showsText({ text: "" }), true);
  assert.equal(showsText({}), true);
  assert.equal(showsText({ text: "", references: [], images: [] }), true);
});

test("a message's thumbnails: each image at the chat's own address, in the message's order, by its name", () => {
  assert.deepEqual(shownImages("c_1", [png(ID, "one.png"), png(ID2, "two.jpg")]), [
    { id: ID, src: imageUrl("c_1", ID), name: "one.png" },
    { id: ID2, src: imageUrl("c_1", ID2), name: "two.jpg" },
  ]);
  assert.equal(shownImages("c_1", [png()])[0].src, `/api/chats/c_1/images/${ID}`);
  assert.deepEqual(shownImages("c_1", undefined), []);
  assert.deepEqual(shownImages("c_1", []), []);
});

test("an image the message holds twice is shown twice: the thread shows what was sent", () => {
  assert.deepEqual(shownImages("c_1", [png(), png()]).map((im) => im.id), [ID, ID]);
});

test("an image without a name is named by the fixed word, so that its plain tile is never blank", () => {
  assert.equal(shownImages("c_1", [png(ID, "")])[0].name, IMAGE_WORD);
  assert.equal(shownImages("c_1", [png(ID, "  ")])[0].name, IMAGE_WORD);
});

test("the large view steps through a message's images and stops at both ends", () => {
  assert.equal(stepImage(0, 3, 1), 1);
  assert.equal(stepImage(1, 3, 1), 2);
  assert.equal(stepImage(2, 3, 1), 2);
  assert.equal(stepImage(1, 3, -1), 0);
  assert.equal(stepImage(0, 3, -1), 0);
  assert.equal(stepImage(0, 1, 1), 0);
  assert.equal(stepImage(0, 1, -1), 0);
});

test("the large view's line: the name, and which of several it is", () => {
  assert.equal(largeCaption("shot.png", 0, 1), "shot.png");
  assert.equal(largeCaption("shot.png", 0, 3), "shot.png · 1 of 3");
  assert.equal(largeCaption("last.png", 2, 3), "last.png · 3 of 3");
});

// ---- the one-line name of a message

test("the fixed word is Image", () => {
  assert.equal(IMAGE_WORD, "Image");
});

test("nameText: a message of images alone is named by the fixed word", () => {
  assert.equal(nameText({ text: "", images: [png()] }), IMAGE_WORD);
  assert.equal(nameText({ images: [png(), png(ID2)] }), IMAGE_WORD);
  assert.equal(nameText({ text: "  \n", images: [png()] }), IMAGE_WORD);
});

test("nameText: words name a message that has them, whatever else it carries", () => {
  assert.equal(nameText({ text: "look at this", images: [png()] }), "look at this");
  assert.equal(nameText({ text: "answer", references: [quote], images: [png()] }), "answer");
});

test("nameText: a message of quotes and images has words, its first quote's: the comment, else the quoted words", () => {
  assert.equal(nameText({ text: "", references: [quote], images: [png()] }), "❝ the plan");
  assert.equal(nameText({ text: "", references: [{ ...quote, comment: " why? " }], images: [png()] }), "❝ why?");
});

test("nameText: without images nothing changed", () => {
  assert.equal(nameText({ text: "plain" }), "plain");
  assert.equal(nameText({ text: "", references: [quote] }), "❝ the plan");
  assert.equal(nameText({ text: "" }), "");
  assert.equal(nameText({}), "");
  assert.equal(nameText({ text: " ", images: [] }), " ");
});

// ---- the chat's title

test("chatTitle: a chat whose first message is images alone is Image, not New chat, until it is named", () => {
  assert.equal(chatTitle({}, [pictures()]), IMAGE_WORD);
  assert.equal(chatTitle({}, [pictures(), { kind: "text", text: "A cat.", done: true }, { kind: "user", text: "and this?" }]), IMAGE_WORD);
  assert.equal(chatTitle({}, [{ kind: "user", text: " \n ", images: [png()] }]), IMAGE_WORD);
  assert.equal(chatTitle({ name: "Cats" }, [pictures()]), "Cats");
});

test("chatTitle: words in the first message name the chat, images or not; a later message does not", () => {
  assert.equal(chatTitle({}, [{ kind: "user", text: "What is this?", images: [png()] }]), "What is this?");
  assert.equal(chatTitle({}, [{ kind: "user", text: "First" }, pictures()]), "First");
});

test("chatTitle: without images nothing changed", () => {
  assert.equal(chatTitle({}), "New chat");
  assert.equal(chatTitle({}, []), "New chat");
  assert.equal(chatTitle({}, [{ kind: "user", text: "" }]), "New chat");
  assert.equal(chatTitle({}, [{ kind: "user", text: "", images: [] }]), "New chat");
  assert.equal(chatTitle({}, [{ kind: "user", text: "Count the files" }]), "Count the files");
  assert.equal(chatTitle({}, [{ kind: "user", text: "a".repeat(50) }]), "a".repeat(40) + "…");
});

// ---- the tree, a branch's name and the move banner

// main: a turn of words, then a turn whose message is images alone; the branch b1 leaves main after the first turn with
// a message of images alone as well.
const MAIN: Item[] = [
  { kind: "user", text: "ask" }, { kind: "text", text: "options", done: true }, { kind: "end", point: "p1" },
  pictures(), { kind: "text", text: "a cat", done: true }, { kind: "end", point: "p2" },
];
const BRANCH: Item[] = [...MAIN.slice(0, 3), pictures(png(ID2, "other.png")), { kind: "text", text: "a dog", done: true }, { kind: "end", point: "p3" }];
/** The tree as the page holds it with both branches' own parts taken from their live items. */
const view = (): TreeView => {
  const bare: TreeView = { current: "b1", branches: [{ id: "main", at: 0, len: 0, items: [] }, { id: "b1", from: "main", at: 3, len: 0, items: [] }], labels: [] };
  return withLive(withLive(bare, "main", "claude", MAIN), "b1", "claude", BRANCH);
};

test("the tree: the item of a message of images alone has the fixed word for its text", () => {
  assert.deepEqual(toTreeItems("claude", MAIN), [
    { i: 0, kind: "user", text: "ask", before: 0, ok: true },
    { i: 1, kind: "text", text: "options", done: true, end: 3, ok: true },
    { i: 3, kind: "user", text: IMAGE_WORD, before: 3, ok: true },
    { i: 4, kind: "text", text: "a cat", done: true, end: 6, ok: true },
  ]);
});

test("the tree: its row shows the fixed word, not (empty), and a search for it finds the message", () => {
  const t = buildTree(view());
  assert.equal(preview(t.entries["main:3"].item.text, 110), IMAGE_WORD);
  assert.equal(preview(t.entries["b1:3"].item.text, 110), IMAGE_WORD);
  assert.deepEqual(rows(t, { filter: "default", query: "image" }).map((r) => r.id).sort(), ["b1:3", "main:3"]);
});

test("a branch that starts with a message of images alone is named by the fixed word", () => {
  const t = buildTree(view());
  assert.equal(nameOfBranch(t, "b1"), IMAGE_WORD);
  assert.equal(nameOfBranch(t, "main"), IMAGE_WORD);
});

test("the move banner names a message of images alone by the fixed word", () => {
  const t = buildTree(view());
  // right after the message, before its reply
  const b = bannerOf(t, { branch: "main", at: 4, new: true }, MAIN, "b1");
  assert.deepEqual(b, { kind: "new", after: IMAGE_WORD, stays: IMAGE_WORD });
  assert.equal(bannerText(b), "New branch after “Image”: your message starts it. “Image” stays in the tree.");
  // a reply after it is named by its own words
  assert.equal(bannerOf(t, { branch: "main", at: 6, new: true }, MAIN, "b1").after, "a cat");
});
