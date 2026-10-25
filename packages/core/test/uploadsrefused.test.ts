// The files a composer's last add refused are kept in the branch's uploads slot, one entry each (state/uploads.ts `RefusedFile`), for the phone's strip
// to draw as marked tiles; the wide layouts draw only the error line, which says what it always said. An entry goes by its own dismiss, by the next
// add (the entries are the last add's), and when the slot's error is cleared (a send, a composer that goes away).
import assert from "node:assert/strict";
import { test } from "node:test";

import { fromDesktop, type BytesFile } from "../src/logic/chatimage.ts";
import { addImages, dismissRefused, setImageError, slotOf } from "../src/state/uploads.ts";

const heic = (name: string, uri?: string) => ({ file: { bytes: Uint8Array.from([1, 2, 3]), type: "image/heic", size: 3, ...(uri ? { uri } : {}) } as BytesFile, name });
const held = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `p${i}.png`, type: "image/png", size: 10 }));

test("a refused file stays in the slot as an entry with its name and reason, and the error line says it as before", () => {
  addImages("c_r1", "main", [heic("IMG_2041.HEIC", "file:///picked/IMG_2041.HEIC")], { has: [] });
  const s = slotOf("c_r1", "main");
  assert.deepEqual(s.refused.map(({ name, reason, uri }) => ({ name, reason, uri })), [{ name: "IMG_2041.HEIC", reason: "type", uri: "file:///picked/IMG_2041.HEIC" }]);
  assert.equal(s.error, "Not a PNG, JPEG, GIF or WebP image: IMG_2041.HEIC.", "the wide layouts' line is unchanged");
  assert.equal(s.said, "", "nothing is said besides the refused files");
  assert.deepEqual(s.uploads, []);
  setImageError("c_r1", "main", "");
});

test("the entries are the last add's: the next add replaces them, an add with nothing refused takes them away", () => {
  addImages("c_r2", "main", [heic("a.heic"), heic("b.heic")], { has: [] });
  assert.deepEqual(slotOf("c_r2", "main").refused.map((r) => r.name), ["a.heic", "b.heic"]);
  addImages("c_r2", "main", [heic("c.heic")], { has: [] });
  assert.deepEqual(slotOf("c_r2", "main").refused.map((r) => r.name), ["c.heic"]);
  addImages("c_r2", "main", [], { has: [] });
  assert.deepEqual(slotOf("c_r2", "main").refused, []);
  assert.equal(slotOf("c_r2", "main").error, "");
});

test("dismissing an entry takes that one only; the keys are not reused", () => {
  addImages("c_r3", "main", [heic("a.heic"), heic("b.heic")], { has: [] });
  const [a, b] = slotOf("c_r3", "main").refused;
  assert.notEqual(a.key, b.key);
  dismissRefused("c_r3", "main", a.key);
  assert.deepEqual(slotOf("c_r3", "main").refused.map((r) => r.name), ["b.heic"]);
  dismissRefused("c_r3", "main", a.key); // (gone already: nothing changes)
  assert.deepEqual(slotOf("c_r3", "main").refused.map((r) => r.name), ["b.heic"]);
  setImageError("c_r3", "main", "");
});

test("clearing the error (a send, a composer that goes away) clears the entries and what is said; another sentence keeps them", () => {
  addImages("c_r4", "main", [heic("a.heic")], { has: [] });
  setImageError("c_r4", "main", "The files could not be picked: no picker");
  assert.deepEqual(slotOf("c_r4", "main").refused.map((r) => r.name), ["a.heic"], "a failed pick is not an add");
  assert.equal(slotOf("c_r4", "main").said, "The files could not be picked: no picker");
  setImageError("c_r4", "main", "");
  assert.deepEqual(slotOf("c_r4", "main").refused, []);
  assert.equal(slotOf("c_r4", "main").said, "");
  assert.equal(slotOf("c_r4", "main").error, "");
});

test("a limit and a chat that takes no image are entries too, with the words the line needs; the desktop dialog's left-outs are entries", () => {
  addImages("c_r5", "main", [heic("x.png")].map((f) => ({ ...f, file: { ...f.file, type: "image/png" } })), { has: held(10) });
  assert.deepEqual(slotOf("c_r5", "main").refused.map((r) => [r.name, r.reason]), [["x.png", "count"]]);
  addImages("c_r5", "main", [heic("y.png")].map((f) => ({ ...f, file: { ...f.file, type: "image/png" } })), { has: [], off: "Haiku takes no images" });
  assert.deepEqual(slotOf("c_r5", "main").refused.map((r) => [r.name, r.reason, r.off]), [["y.png", "off", "Haiku takes no images"]]);
  const dialog = fromDesktop({ files: [], skipped: [{ name: "big.png", reason: "size" }] }, { asBytes: true });
  addImages("c_r5", "main", dialog.files, { has: [], skipped: dialog.skipped });
  assert.deepEqual(slotOf("c_r5", "main").refused.map((r) => [r.name, r.reason, r.uri]), [["big.png", "size", undefined]]);
  setImageError("c_r5", "main", "");
});
