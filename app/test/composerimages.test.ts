// Images in the composer on a phone (package K4; AD-26; C-IM-01, C-IM-02, C-IM-10, C-IM-11 on a device): the picker's files come as bytes with the file the
// picker left, an upload sends the bytes through the native transport as they are, the thumbnail is the picker's file until the picture is fetched, and
// a picker that is not there says so. The rules of the check and the line (C-IM-08, C-IM-09, C-IM-19) are core's (web/test/chatimage.test.ts); the strip
// and the button as the browser draws them are IM3.2's and R3.12's.
import assert from "node:assert/strict";
import { test } from "node:test";

import { addImages, previewOf, setPreviews, slotOf } from "@aiwb/core/state/uploads.ts";
import { useTransport } from "@aiwb/core/transport/index.ts";

import { pickImageFiles } from "../src/platform/imagefiles.native.ts";
import { pickImagesWith, type ImagePickerPort } from "../src/platform/imagepickcore.ts";
import { createNativeTransport } from "../src/platform/nativetransport.ts";
import { nativePreviews } from "../src/platform/previewscore.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const id = "c".repeat(64);
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

/** The picker and the files of a phone, as imagepick.native.ts gives them to the transport. */
const device = (assets: { uri: string; fileName: string; bytes: Uint8Array }[]) => {
  const port: ImagePickerPort = { launchImageLibraryAsync: async () => ({ canceled: false, assets: assets.map(({ uri, fileName }) => ({ uri, fileName })) }) };
  class File { uri: string; constructor(uri: string) { this.uri = uri; } get size() { return assets.find((a) => a.uri === this.uri)?.bytes.length ?? 0; } async bytes() { return assets.find((a) => a.uri === this.uri)!.bytes; } }
  return () => pickImagesWith(port, { File } as never);
};

/** The native transport over a Client that records its calls and answers an upload with the image it names. */
function phone(pick?: () => Promise<never>) {
  const calls: { server: string; method: string; path: string; body: { bytes: Uint8Array; type: string } | undefined }[] = [];
  const pictures: string[] = [];
  const client = {
    call: async (r: { server: string; method: string; path: string; body?: never }) => {
      calls.push({ server: r.server, method: r.method, path: r.path, body: r.body });
      return { status: 200, text: JSON.stringify({ id, name: "a.png", type: "image/png", size: PNG.length }), sceneRev: null };
    },
    subscribe: () => ({ close() {} }), wake() {},
  };
  const t = createNativeTransport(client as never, { appState: { addEventListener: () => ({ remove() {} }) }, cache: {} as never, ...(pick ? { pickImages: pick as never } : {}) });
  // (the picture of the cache is C4's, tested with the transport: here only that the thumbnail asks for it)
  useTransport({ ...t, picture: async (server, chat, image) => { pictures.push(`${server}/${chat}/${image}`); return `file:///cache/${image}`; } });
  return { t, calls, pictures };
}

test("the device's picker: the files come as bytes with the picker's own file, the ones it left out with why; a cancelled picker adds nothing", async () => {
  const pick = device([{ uri: "file:///picked/a.png", fileName: "a.png", bytes: PNG }, { uri: "file:///picked/n.txt", fileName: "n.txt", bytes: new TextEncoder().encode("hello") }]);
  phone(pick as never);
  const r = await pickImageFiles();
  assert.deepEqual(r.files, [{ file: { bytes: PNG, type: "image/png", size: PNG.length, uri: "file:///picked/a.png" }, name: "a.png" }]);
  assert.deepEqual(r.skipped, [{ name: "n.txt", reason: "type" }]);
  phone(async () => ({ files: [], skipped: [] }) as never);
  assert.deepEqual(await pickImageFiles(), { files: [], skipped: [] });
});

test("a transport with no picker says so (the attach button shows it in the error line)", async () => {
  phone();
  await assert.rejects(pickImageFiles(), /no picker/);
});

test("a picked image is uploaded as the bytes it is: type and name as the web's upload, the thumbnail the picker's file until the picture is fetched", async () => {
  const pick = device([{ uri: "file:///picked/a.png", fileName: "a.png", bytes: PNG }]);
  const { calls, pictures } = phone(pick as never);
  setPreviews(nativePreviews(async () => true));
  const r = await pickImageFiles();
  addImages("c_1", "main", r.files, { has: [], skipped: r.skipped });
  assert.deepEqual(slotOf("c_1", "main").uploads.map((u) => [u.name, u.size, u.src]), [["a.png", PNG.length, "file:///picked/a.png"]], "busy, showing the picker's file");
  await settle();
  const up = calls.find((c) => /\/images\?/.test(c.path));
  assert.ok(up);
  assert.equal(up.method, "POST");
  assert.equal(up.path, "/api/chats/c_1/images?name=a.png");
  assert.equal(up.server, "local");
  assert.equal(up.body?.type, "image/png");
  assert.deepEqual(up.body?.bytes, PNG);
  assert.deepEqual(pictures, [`local/c_1/${id}`], "the picture is fetched through the transport for the thumbnail to go to");
  assert.equal(previewOf("c_1", id), undefined, "and the picker's file goes when it has loaded");
});

test("a thumbnail goes even when the picture cannot be had", async () => {
  setPreviews(nativePreviews(async () => { throw new Error("prefetch failed"); }));
  const p = nativePreviews(async () => { throw new Error("x"); });
  let done = 0;
  assert.equal(p.loaded("c_9", id, () => { done++; }), true);
  await settle();
  assert.equal(done, 1);
});
