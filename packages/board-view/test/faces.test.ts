// The faces a request's text needs (src/faces.ts): which families and which text a request names (`needs`), and what `loadFaces`
// asks of document.fonts. The module is bundled with esbuild over a stand-in for Excalidraw (its font ids, and a
// `convertToExcalidrawElements` that records its calls); `document.fonts` is a stand-in too, so the test proves what faces.ts itself does.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const stand = `
  export const FONT_FAMILY = { Virgil: 1, Helvetica: 2, Cascadia: 3, Excalifont: 5, Nunito: 6, "Lilita One": 7, "Comic Shanns": 8, "Liberation Sans": 9 };
  export const converted = [];
  export const convertToExcalidrawElements = (v) => { converted.push(v); return v; };`;
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-faces-")), "faces.mjs");
await esbuild.build({
  entryPoints: [path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/faces.ts")],
  bundle: true, format: "esm", platform: "node", outfile: out, logLevel: "silent",
  plugins: [{
    name: "stand-ins",
    setup(b) {
      b.onResolve({ filter: /^@excalidraw\/excalidraw$/ }, () => ({ path: "excalidraw", namespace: "stand-in" }));
      b.onLoad({ filter: /^excalidraw$/, namespace: "stand-in" }, () => ({ contents: stand, loader: "js" }));
    },
  }],
});
// (the bundle holds its own copy of the stand-in: `converted` is read through the module's namespace by the re-export below)
fs.appendFileSync(out, "\nexport const __converted = converted;\n");
const faces = await import(pathToFileURL(out).href) as typeof import("../src/faces.ts") & { __converted: unknown[] };
fs.rmSync(path.dirname(out), { recursive: true, force: true });
const { needs, loadFaces, __converted } = faces;

const ID = { Excalifont: 5, Nunito: 6, "Comic Shanns": 8, Virgil: 1 };
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);

test("needs: Nunito, the normal font, is always among the families", () => {
  assert.deepEqual(needs({}, []), { families: [ID.Nunito], text: "" });
  assert.deepEqual(needs({ create: [{ type: "rectangle", x: 0, y: 0 }] }, []).families, [ID.Nunito]);
});

test("needs: the text of create, update and label, in order", () => {
  const params = {
    create: [
      { type: "text", key: "a", text: "Alpha" },
      { type: "rectangle", key: "b", label: "Beta" },
      { type: "rectangle", key: "c", label: { text: "Gamma" } },
    ],
    update: [{ ref: { key: "a" }, text: "Delta" }, { ref: { key: "b" }, label: { text: "Epsilon" } }],
  };
  assert.equal(needs(params, []).text, "AlphaBetaGammaDeltaEpsilon");
});

test("needs: the families of create, update and label, by the agent's style names or by id", () => {
  const params = {
    create: [
      { type: "text", text: "a", fontFamily: "hand" },
      { type: "rectangle", label: { text: "b", fontFamily: "code" } },
      { type: "text", text: "c", fontFamily: "normal" },
    ],
    update: [{ ref: { key: "a" }, fontFamily: ID.Virgil }],
  };
  assert.deepEqual(sorted(needs(params, []).families), sorted([ID.Excalifont, ID.Nunito, ID["Comic Shanns"], ID.Virgil]));
  assert.deepEqual(needs({ create: [{ type: "text", text: "x", fontFamily: "no such style" }] }, []).families, [ID.Nunito], "an unknown style names no family");
  assert.deepEqual(needs({ create: [{ type: "text", text: "x", fontFamily: 99 }] }, []).families, [ID.Nunito, 99], "an id is taken as it is (loadFaces leaves out one it has no name for)");
});

test("needs: the text and the family of the live text elements, not the deleted ones, not other elements", () => {
  const live = [
    { type: "text", fontFamily: ID.Excalifont, text: "Zdravo" },
    { type: "text", fontFamily: ID["Comic Shanns"], text: "gone", isDeleted: true },
    { type: "rectangle", fontFamily: ID.Virgil, text: "not a text" },
    { type: "text", fontFamily: "5", text: 7 },
  ];
  assert.deepEqual(needs({}, live), { families: [ID.Nunito, ID.Excalifont], text: "Zdravo" });
  assert.deepEqual(needs({ create: [{ type: "text", text: "New" }] }, live).text, "NewZdravo", "the request's text first");
});

test("needs: a list of refs (delete) names its text too", () => {
  assert.deepEqual(needs([{ key: "a" }, { name: "Server" }, "id1"], []), { families: [ID.Nunito], text: "Server" });
});

/** A `document.fonts` that records what it is asked. */
function fakeFonts(has: (f: unknown) => boolean = () => false) {
  const calls = { added: [] as unknown[], loaded: [] as [string, string][] };
  const fonts = {
    has: (f: unknown) => has(f) || calls.added.includes(f),
    add: (f: unknown) => { calls.added.push(f); },
    load: async (font: string, text: string) => { calls.loaded.push([font, text]); return []; },
  };
  return { fonts, calls };
}
const withDocument = async (document: unknown, f: () => Promise<void>) => {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  g.document = document;
  try { await f(); } finally { if (before === undefined) delete g.document; else g.document = before; }
};

test("loadFaces: with no document.fonts there is nothing to do", async () => {
  __converted.length = 0;
  await loadFaces([], { create: [{ type: "text", text: "x" }] }, []);
  assert.equal(__converted.length, 0);
});

test("loadFaces: every face Excalidraw made goes in document.fonts once; each family of the request loads its text", async () => {
  const { fonts, calls } = fakeFonts();
  const made = [{ id: 1 }, { id: 2 }] as unknown as FontFace[];
  __converted.length = 0;
  await withDocument({ fonts }, async () => {
    await loadFaces(made, { create: [{ type: "text", text: "Žluťoučký", fontFamily: "code" }] }, [{ type: "text", fontFamily: ID.Virgil, text: " kůň" }]);
  });
  assert.deepEqual(calls.added, made);
  assert.deepEqual(calls.loaded.map(([f]) => f).sort(), ['16px "Comic Shanns"', '16px "Nunito"', '16px "Virgil"']);
  assert.ok(calls.loaded.every(([, t]) => t === "Žluťoučký kůň"));
  assert.equal(__converted.length, 0, "Excalidraw had made its faces: no element is made to make them");
});

test("loadFaces: a face already in document.fonts is not added again; Excalifont also loads Xiaolai", async () => {
  const have = { id: "have" }, other = { id: "other" };
  const { fonts, calls } = fakeFonts((f) => f === have);
  await withDocument({ fonts }, async () => {
    await loadFaces([have, other] as unknown as FontFace[], { create: [{ type: "text", text: "你好", fontFamily: "hand" }] }, []);
  });
  assert.deepEqual(calls.added, [other]);
  assert.deepEqual(calls.loaded.map(([f]) => f).sort(), ['16px "Excalifont"', '16px "Nunito"', '16px "Xiaolai"']);
});

test("loadFaces: a face that failed to parse (a `local:` family's) is not put in document.fonts", async () => {
  const good = { id: "good", status: "unloaded" }, broken = { id: "broken", status: "error" };
  const { fonts, calls } = fakeFonts();
  await withDocument({ fonts }, async () => { await loadFaces([broken, good] as unknown as FontFace[], { create: [{ type: "text", text: "x" }] }, []); });
  assert.deepEqual(calls.added, [good]);
});

test("loadFaces: before Excalidraw has made a face, one text element makes it do so", async () => {
  const { fonts } = fakeFonts();
  __converted.length = 0;
  await withDocument({ fonts }, async () => { await loadFaces([], { create: [{ type: "text", text: "x" }] }, []); });
  assert.equal(__converted.length, 1);
});

test("loadFaces: a request with no text loads nothing and makes nothing", async () => {
  const { fonts, calls } = fakeFonts();
  __converted.length = 0;
  await withDocument({ fonts }, async () => { await loadFaces([{}] as unknown as FontFace[], { create: [{ type: "rectangle", x: 0, y: 0 }] }, []); });
  assert.deepEqual([calls.added, calls.loaded, __converted.length], [[], [], 0]);
});

test("loadFaces: a face that fails to load does not fail the request", async () => {
  const { fonts } = fakeFonts();
  fonts.load = async () => { throw new Error("NetworkError"); };
  await withDocument({ fonts }, async () => { await loadFaces([{}] as unknown as FontFace[], { create: [{ type: "text", text: "x" }] }, []); });
});
