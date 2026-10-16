// The native canvas behind the stand-in page, one of two libraries (AIWB_CANVAS=skia, the default, or napi), behind one face:
// a canvas element maker, Image, Path2D, DOMMatrix, ImageData, a font registrar and a PNG encoder.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const which = process.env.AIWB_CANVAS ?? "skia";
/** The version of an installed package, from the package.json above its entry (exports may hide the file). */
function versionOf(name) {
  let dir = path.dirname(createRequire(import.meta.url).resolve(name));
  for (;;) { const f = path.join(dir, "package.json"); if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, "utf8")); if (j.name === name) return j.version; } const up = path.dirname(dir); if (up === dir) return "?"; dir = up; }
}

async function napi() {
  const m = await import("@napi-rs/canvas");
  return {
    name: `@napi-rs/canvas ${versionOf("@napi-rs/canvas")}`,
    createCanvas: (w, h) => m.createCanvas(w, h), Image: m.Image, Path2D: m.Path2D, DOMMatrix: m.DOMMatrix, ImageData: m.ImageData,
    register: (file, alias) => !!m.GlobalFonts.registerFromPath(file, alias),
    png: async (c) => c.encode("png"),
  };
}
async function skia() {
  const m = await import("skia-canvas");
  return {
    name: `skia-canvas ${versionOf("skia-canvas")}`,
    createCanvas: (w, h) => new m.Canvas(w, h), Image: m.Image, Path2D: m.Path2D, DOMMatrix: m.DOMMatrix, ImageData: m.ImageData,
    register: (file, alias) => { try { m.FontLibrary.use(alias, [file]); return true; } catch { return false; } },
    png: async (c) => c.toBuffer("png"),
  };
}
export const lib = which === "napi" ? await napi() : await skia();
