// The stand-in page with the real native canvas and Excalidraw's own font files. It installs globals, so it lives in a file of its own
// (each test file is a process of its own).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { installPage } from "../src/page.ts";
import { runsOf } from "../src/fonts.ts";

const require = createRequire(import.meta.url);
const assets = path.dirname(require.resolve("@excalidraw/excalidraw")); // its dist/prod, which holds fonts/
const g = globalThis as any;

// the piece of Excalifont that holds basic Latin (Excalidraw declares it first, with a range that starts at U+20)
const LATIN = "Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2";
function declareExcalifont(): void {
  const file = path.join(assets, "fonts", "Excalifont", LATIN);
  assert.ok(fs.existsSync(file), `no ${file}`);
  new g.FontFace("Excalifont", `url(${pathToFileURL(file).href}) format("woff2")`, { unicodeRange: "U+20-7e" });
}

test("installPage: the globals Excalidraw reaches for are there, and a second install changes nothing", () => {
  installPage({ assets });
  const document = g.document;
  assert.equal(g.window, globalThis);
  assert.equal(g.devicePixelRatio, 1);
  assert.equal(g.EXCALIDRAW_ASSET_PATH, pathToFileURL(assets + "/").href);
  for (const name of ["FontFace", "FileReader", "Image", "Path2D", "DOMMatrix", "ImageData", "matchMedia", "requestAnimationFrame", "localStorage", "ResizeObserver"]) {
    assert.ok(g[name], name);
  }
  installPage({ assets: "/somewhere/else" });
  assert.equal(g.document, document);
  assert.equal(g.EXCALIDRAW_ASSET_PATH, pathToFileURL(assets + "/").href);
});

test("a canvas element is the native canvas: it measures text run by run with Excalidraw's own font", () => {
  installPage({ assets });
  declareExcalifont();
  const canvas = g.document.createElement("canvas");
  assert.equal(canvas.tagName, "CANVAS");
  assert.equal(canvas.isConnected, true);
  const ctx = canvas.getContext("2d");
  assert.equal(ctx.textRendering, "optimizeLegibility");
  ctx.font = "20px Excalifont, Xiaolai, Segoe UI Emoji";
  assert.equal(ctx.font, "20px Excalifont, Xiaolai, Segoe UI Emoji", "the font Excalidraw set reads back as it set it");
  const whole = ctx.measureText("ab c").width;
  assert.ok(whole > 0);
  // no kerning crosses a space: the width of a text is the sum of the widths of its words and spaces
  const parts = runsOf("20px Excalifont, Xiaolai, Segoe UI Emoji", "ab c").map((r) => r.text);
  assert.deepEqual(parts, ["ab", " ", "c"]);
  const sum = parts.reduce((s, p) => s + ctx.measureText(p).width, 0);
  assert.ok(Math.abs(whole - sum) < 1e-9, `${whole} vs ${sum}`);
});

test("fillText draws run by run: the pixels of a text with a space are those of its words drawn at their places", () => {
  installPage({ assets });
  declareExcalifont();
  const draw = (f: (ctx: any) => void): Buffer => {
    const c = g.document.createElement("canvas");
    c.width = 200;
    c.height = 60;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 200, 60);
    ctx.fillStyle = "black";
    ctx.font = "24px Excalifont";
    ctx.textBaseline = "alphabetic";
    f(ctx);
    return c.toBufferSync("raw");
  };
  const whole = draw((ctx) => ctx.fillText("ab c", 10, 40));
  const pieces = draw((ctx) => {
    const a = ctx.measureText("ab").width;
    const space = ctx.measureText(" ").width;
    ctx.fillText("ab", 10, 40);
    ctx.fillText("c", 10 + a + space, 40);
  });
  assert.ok(whole.equals(pieces));
  assert.ok(whole.some((b, i) => i % 4 === 0 && b < 128), "something was drawn");
});

test("dir=rtl sets the direction of the context; toBlob gives a PNG; FileReader makes a data URL of it", async () => {
  installPage({ assets });
  const canvas = g.document.createElement("canvas");
  canvas.setAttribute("dir", "rtl");
  assert.equal(canvas.getContext("2d").direction, "rtl");
  canvas.removeAttribute("dir");
  assert.equal(canvas.getContext("2d").direction, "ltr");
  canvas.width = 4;
  canvas.height = 4;
  const blob: Blob = await new Promise((res) => canvas.toBlob(res));
  assert.equal(blob.type, "image/png");
  const url: string = await new Promise((res) => {
    const r = new g.FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
  assert.match(url, /^data:image\/png;base64,iVBORw0KGgo/);
});

test("Image decodes a data URL and reports its natural size", async () => {
  installPage({ assets });
  const canvas = g.document.createElement("canvas");
  canvas.width = 3;
  canvas.height = 2;
  const png = canvas.toBufferSync("png");
  const img = g.document.createElement("img");
  assert.ok(img instanceof g.HTMLImageElement);
  img.src = `data:image/png;base64,${png.toString("base64")}`;
  await img.decode();
  assert.equal(img.naturalWidth, 3);
  assert.equal(img.naturalHeight, 2);
});
