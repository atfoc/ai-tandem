// What a thumbnail shows while its image is on its way is the client's (state/uploads.ts `setPreviews`), and a file picked on a device is
// bytes, not a Blob (logic/chatimage.ts `BytesFile`): an upload sends them as they are, the thumbnail is the file the picker left, and it
// goes when the image's own address has loaded. Without a registered seam a client is a browser (the old page's tests, web/test/actions.test.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fromDesktop, isBytesFile, type BytesFile } from "../src/logic/chatimage.ts";
import { addImages, previewOf, setPreviews, slotOf, type Previews } from "../src/state/uploads.ts";
import { FakeTransport, ok } from "./fixtures/faketransport.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

test("fromDesktop: with asBytes the files are bytes with the picker's uri; without it they are Blobs, as they were", () => {
  const pick = { files: [{ name: "a.png", type: "image/png", data: PNG, uri: "file:///cache/a.png" }, { name: "b.png", type: "image/png", data: PNG }], skipped: [{ name: "c.gif", reason: "size" as const }] };
  const bytes = fromDesktop(pick, { asBytes: true });
  assert.deepEqual(bytes.files.map((f) => f.name), ["a.png", "b.png"]);
  assert.ok(isBytesFile(bytes.files[0].file));
  assert.deepEqual(bytes.files[0].file, { bytes: PNG, type: "image/png", size: PNG.length, uri: "file:///cache/a.png" });
  assert.equal("uri" in (bytes.files[1].file as BytesFile), false, "no uri, none invented");
  assert.deepEqual(bytes.skipped, [{ name: "c.gif", reason: "size" }]);
  const blobs = fromDesktop(pick);
  assert.ok(blobs.files[0].file instanceof Blob && !isBytesFile(blobs.files[0].file));
  assert.equal((blobs.files[0].file as Blob).size, PNG.length);
});

test("an upload of a file picked as bytes sends the bytes; its thumbnail is the picker's file, until the image's own address has loaded", async () => {
  const made: unknown[] = [], released: string[] = [], waits: { chat: string; id: string; done: () => void }[] = [];
  const previews: Previews = {
    make: (file) => { made.push(file); return (file as BytesFile).uri ?? "none"; },
    release: (src) => { released.push(src); },
    loaded: (chat, id, done) => { waits.push({ chat, id, done }); return true; },
  };
  setPreviews(previews);
  const t = new FakeTransport().install();
  const id = "a".repeat(64);
  t.handler = (c) => (c.method === "POST" && /\/images\?/.test(c.path) ? ok({ id, name: "a.png", type: "image/png", size: PNG.length }) : undefined);
  const file: BytesFile = { bytes: PNG, type: "image/png", size: PNG.length, uri: "file:///cache/a.png" };
  addImages("c_1", "main", [{ file, name: "a.png" }], { has: [] });
  assert.deepEqual(made, [file]);
  assert.deepEqual(slotOf("c_1", "main").uploads.map((u) => [u.name, u.size, u.src]), [["a.png", PNG.length, "file:///cache/a.png"]]);
  await settle();
  const sent = t.calls.find((c) => c.method === "POST" && /\/images\?/.test(c.path));
  assert.ok(sent, "the upload was made");
  assert.equal(sent.path, "/api/chats/c_1/images?name=a.png");
  assert.equal(sent.type, "image/png");
  assert.equal(sent.body, `<${PNG.length} bytes>`);
  assert.deepEqual(slotOf("c_1", "main").uploads, [], "the upload is over");
  assert.equal(previewOf("c_1", id), "file:///cache/a.png", "the thumbnail stays the file");
  assert.deepEqual(waits.map((w) => [w.chat, w.id]), [["c_1", id]]);
  assert.deepEqual(released, []);
  waits[0].done();
  assert.equal(previewOf("c_1", id), undefined, "and goes when the image's own address has loaded");
  assert.deepEqual(released, ["file:///cache/a.png"]);
});

test("a client that cannot load an address keeps no thumbnail; the same picture added again keeps the first file", async () => {
  const released: string[] = [];
  let can = false;
  setPreviews({ make: (f) => (f as BytesFile).uri ?? "", release: (s) => { released.push(s); }, loaded: () => can });
  const t = new FakeTransport().install();
  const id = "b".repeat(64);
  t.handler = (c) => (/\/images\?/.test(c.path) ? ok({ id, name: "b.png", type: "image/png", size: PNG.length }) : undefined);
  const one = (uri: string) => ({ file: { bytes: PNG, type: "image/png", size: PNG.length, uri } as BytesFile, name: "b.png" });
  addImages("c_2", "main", [one("file:///1")], { has: [] });
  await settle();
  assert.equal(previewOf("c_2", id), undefined);
  assert.deepEqual(released, ["file:///1"]);
  can = true;
  addImages("c_2", "main", [one("file:///2")], { has: [] });
  await settle();
  assert.equal(previewOf("c_2", id), "file:///2");
  addImages("c_2", "main", [one("file:///3")], { has: [] });
  await settle();
  assert.equal(previewOf("c_2", id), "file:///2", "the first file stays");
  assert.deepEqual(released, ["file:///1", "file:///3"]);
});
