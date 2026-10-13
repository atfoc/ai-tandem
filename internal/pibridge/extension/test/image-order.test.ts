// Unit tests for image-order.ts: the image parts of a user message stand
// before its text in what a model request gets.
// Run with:
//   node --test --experimental-strip-types internal/pibridge/extension/test/image-order.test.ts
//
// No pi, no real app, no npm packages.

import { test } from "node:test";
import assert from "node:assert/strict";
import { imagesFirst } from "../image-order.ts";

const text = (t: string) => ({ type: "text", text: t });
const image = (data: string, mimeType = "image/png") => ({ type: "image", data, mimeType });

test("the user message pi builds from a prompt with images gets its images first", () => {
  // AgentSession.prompt: the text part, then the images in the order of the list.
  const messages = [
    { role: "user", content: [text("<ui-context>x</ui-context>\n\nwhat is on these?"), image("AAAA"), image("BBBB", "image/webp")], timestamp: 1 },
  ];
  assert.equal(imagesFirst(messages), 1);
  assert.deepEqual(messages[0].content, [
    image("AAAA"),
    image("BBBB", "image/webp"),
    text("<ui-context>x</ui-context>\n\nwhat is on these?"),
  ]);
  assert.equal(messages[0].timestamp, 1);
});

test("a message of images alone keeps pi's empty text part, after the images", () => {
  const messages = [{ role: "user", content: [text(""), image("AAAA")] }];
  assert.equal(imagesFirst(messages), 1);
  assert.deepEqual(messages[0].content, [image("AAAA"), text("")]);
});

test("every user message of the conversation is ordered, an earlier turn's too", () => {
  const messages = [
    { role: "user", content: [text("first"), image("AAAA")] },
    { role: "assistant", content: [text("a cat")] },
    { role: "user", content: [text("and this?"), image("BBBB")] },
  ];
  assert.equal(imagesFirst(messages), 2);
  assert.deepEqual(messages[0].content, [image("AAAA"), text("first")]);
  assert.deepEqual(messages[2].content, [image("BBBB"), text("and this?")]);
});

test("the same list ordered again is not changed: every request gets one order", () => {
  const messages = [{ role: "user", content: [text("words"), image("AAAA"), text("more"), image("BBBB")] }];
  assert.equal(imagesFirst(messages), 1);
  const once = structuredClone(messages);
  assert.deepEqual(once[0].content, [image("AAAA"), image("BBBB"), text("words"), text("more")]);
  assert.equal(imagesFirst(messages), 0);
  assert.deepEqual(messages, once);
});

test("the message objects and the list stay the ones pi gave", () => {
  // pi tells a handler that changed the list from one that did not by the
  // list's members: the same objects mean its system messages stay in place.
  const user = { role: "user", content: [text("words"), image("AAAA")] };
  const messages = [user];
  const snapshot = messages.slice();
  imagesFirst(messages);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], snapshot[0]);
  assert.equal(messages[0], user);
});

test("what is no user message with image parts is left as it is", () => {
  const messages = [
    { role: "user", content: "a plain string" },
    { role: "user", content: [text("no image here")] },
    { role: "user", content: [image("AAAA"), text("already first")] },
    { role: "toolResult", content: [text("read image.png"), image("CCCC")] },
    { role: "assistant", content: [text("answer"), image("DDDD")] },
    { role: "custom", customType: "note", content: [text("note"), image("EEEE")] },
    { role: "user" },
    null,
    "junk",
  ];
  const before = structuredClone(messages);
  assert.equal(imagesFirst(messages), 0);
  assert.deepEqual(messages, before);
});

test("what is no list is taken without a throw", () => {
  assert.equal(imagesFirst(undefined), 0);
  assert.equal(imagesFirst({ role: "user" }), 0);
});
