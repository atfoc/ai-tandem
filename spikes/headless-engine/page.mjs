// The stand-in page: what Excalidraw's element code and its export reach for in a browser, supplied around it (goal 4.5).
// Import it before Excalidraw is evaluated: Excalidraw makes <img> elements and FontFaces at module load.
//
// - window, self, document (createElement of canvas, img and anything else; fonts; the few listeners), location, navigator,
//   devicePixelRatio 1, matchMedia, requestAnimationFrame, localStorage, ResizeObserver, getComputedStyle.
// - canvas: skia-canvas or @napi-rs/canvas (canvaslib.mjs; both Skia). Its font setter is wrapped so the family list Excalidraw sets is drawn and measured with
//   Excalidraw's own font files, piece by piece (fonts.mjs). toBlob is added.
// - img / Image: the library's Image (decodes PNG, JPEG, GIF, WebP and SVG from a data: URL or bytes).
// - FontFace and document.fonts: every face Excalidraw declares is kept (fonts.mjs); loading is immediate.
// - FileReader (readAsDataURL), enough for a Blob to become base64.
import { lib } from "./canvaslib.mjs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { declare, nativeFont, runsOf } from "./fonts.mjs";

const g = globalThis;
const noop = () => {};

/** Where Excalidraw's fonts are: its own dist/prod/fonts (the installed package, goal 4.5). */
export function excalidrawRoot() {
  const req = createRequire(import.meta.url);
  let dir = path.dirname(req.resolve("@excalidraw/excalidraw"));
  while (!dir.endsWith(`${path.sep}excalidraw`)) dir = path.dirname(dir);
  return dir;
}

export function install({ assetPath = process.env.AIWB_EXCALIDRAW_ASSETS ? pathToFileURL(process.env.AIWB_EXCALIDRAW_ASSETS.replace(/\/?$/, "/")).href : pathToFileURL(path.join(excalidrawRoot(), "dist/prod/")).href } = {}) {
  if (g.__aiwbPage) return;
  g.__aiwbPage = true;

  // ---- the canvas: Excalidraw's font strings name its families; the native canvas is given the pieces of each
  const { createCanvas, Path2D, DOMMatrix, ImageData } = lib;
  const Image = lib.Image;
  const probe = createCanvas(1, 1).getContext("2d");
  const proto = Object.getPrototypeOf(probe);
  const fontProp = (() => { for (let p = proto; p; p = Object.getPrototypeOf(p)) { const d = Object.getOwnPropertyDescriptor(p, "font"); if (d) return { owner: p, d }; } return null; })();
  if (!fontProp) throw new Error("stand-in page: the native canvas has no font property");
  const asked = new WeakMap();
  const setNative = (ctx, v) => fontProp.d.set.call(ctx, v);
  Object.defineProperty(fontProp.owner, "font", {
    configurable: true,
    get() { return asked.get(this) ?? fontProp.d.get.call(this); },
    set(v) { asked.set(this, String(v)); setNative(this, nativeFont(String(v))); },
  });
  // measureText, fillText and strokeText go run by run when a text needs more than one face (fonts.mjs runsOf)
  const methodOwner = (name) => { for (let p = proto; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, name)) return p; return null; };
  const native = Object.fromEntries(["measureText", "fillText", "strokeText"].map((m) => [m, methodOwner(m)[m]]));
  const runs = (ctx, text, forDrawing = false) => { const f = asked.get(ctx); return f ? runsOf(f, String(text), { forDrawing }) : null; };
  function widths(ctx, rs) { const w = rs.map((r) => { setNative(ctx, r.font); return native.measureText.call(ctx, r.text).width; }); return w; }
  methodOwner("measureText").measureText = function (text) {
    const rs = runs(this, text);
    if (!rs || rs.length < 2) { if (rs) setNative(this, rs[0].font); const m = native.measureText.call(this, text); if (rs) setNative(this, nativeFont(asked.get(this))); return m; }
    const first = (setNative(this, rs[0].font), native.measureText.call(this, rs[0].text));
    const width = widths(this, rs).reduce((a, b) => a + b, 0);
    setNative(this, nativeFont(asked.get(this)));
    return { actualBoundingBoxAscent: first.actualBoundingBoxAscent, actualBoundingBoxDescent: first.actualBoundingBoxDescent, fontBoundingBoxAscent: first.fontBoundingBoxAscent, fontBoundingBoxDescent: first.fontBoundingBoxDescent, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, width };
  };
  for (const m of ["fillText", "strokeText"]) {
    methodOwner(m)[m] = function (text, x, y, maxWidth) {
      const rs = runs(this, text, true);
      if (!rs || rs.length < 2) { if (rs) setNative(this, rs[0].font); const r = maxWidth === undefined ? native[m].call(this, text, x, y) : native[m].call(this, text, x, y, maxWidth); if (rs) setNative(this, nativeFont(asked.get(this))); return r; }
      const ws = widths(this, rs), total = ws.reduce((a, b) => a + b, 0);
      const align = this.textAlign, rtl = this.direction === "rtl";
      let at = x - (align === "center" ? total / 2 : align === "right" || (align === "end" && !rtl) || (align === "start" && rtl) ? total : 0);
      this.textAlign = "left";
      rs.forEach((r, i) => { setNative(this, r.font); native[m].call(this, r.text, at, y); at += ws[i]; });
      this.textAlign = align;
      setNative(this, nativeFont(asked.get(this)));
    };
  }

  const element = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, children: [], childNodes: [],
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, appendChild: (c) => c, removeChild: (c) => c, remove: noop,
    addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    querySelector: () => null, querySelectorAll: () => [], getContext: () => null, cloneNode() { return element(tag); },
  });

  // Text is drawn as Chromium draws it with skia-canvas's `optimizeLegibility` (measured: the strongly differing pixels of a
  // text board go from 0.96% to 0.12%; widths do not change). AIWB_CTX_OPTS (JSON) replaces it, to try others.
  const ctxOpts = process.env.AIWB_CTX_OPTS ? JSON.parse(process.env.AIWB_CTX_OPTS) : lib.name.startsWith("skia-canvas") ? { textRendering: "optimizeLegibility" } : null;
  function canvasElement(w = 300, h = 150) {
    const c = createCanvas(w, h);
    if (ctxOpts) { const get = c.getContext.bind(c); let done = false; c.getContext = (t, o) => { const x = get(t, o); if (x && !done) { done = true; Object.assign(x, ctxOpts); } return x; }; }
    // the `dir` of a canvas is the direction its text is laid out in (Excalidraw sets it for right-to-left text)
    const setDir = (v) => { const x = c.getContext("2d"); if (x && "direction" in x) x.direction = v === "rtl" ? "rtl" : "ltr"; };
    Object.assign(c, {
      tagName: "CANVAS", style: {}, dataset: {}, classList: { add: noop, remove: noop }, isConnected: true,
      setAttribute: (k, v) => { if (k === "dir") setDir(v); }, removeAttribute: (k) => { if (k === "dir") setDir("ltr"); },
      addEventListener: noop, removeEventListener: noop, remove: noop,
      toBlob(cb, type = "image/png", quality) {
        const mime = type === "image/jpeg" || type === "image/webp" ? type : "image/png";
        Promise.resolve().then(() => lib.png(c)).then((buf) => cb(new Blob([buf], { type: "image/png" })), () => cb(null));
      },
    });
    return c;
  }

  class ImageElement extends Image {
    constructor(w, h) { super(w, h); this.style = {}; this.crossOrigin = null; this.decoding = "auto"; }
    // (Excalidraw draws an uncropped picture by its natural size)
    get naturalWidth() { return this.width; }
    get naturalHeight() { return this.height; }
    addEventListener(type, f) { if (type === "load") this.onload = f; else if (type === "error") this.onerror = f; }
    removeEventListener() {}
    decode() { return this.complete ? Promise.resolve() : new Promise((res, rej) => { const l = this.onload, e = this.onerror; this.onload = () => { l?.(); res(); }; this.onerror = (x) => { e?.(x); rej(x); }; }); }
  }

  const fontSet = new Set();
  const fonts = {
    add: (f) => { fontSet.add(f); return fonts; }, has: (f) => fontSet.has(f), delete: (f) => fontSet.delete(f), clear: () => fontSet.clear(),
    forEach: (fn) => fontSet.forEach((f) => fn(f, f, fonts)), [Symbol.iterator]: () => fontSet.values(), get size() { return fontSet.size; },
    check: () => true, load: async () => [], ready: Promise.resolve(), status: "loaded", addEventListener: noop, removeEventListener: noop,
  };

  class FontFace {
    constructor(family, source, descriptors = {}) {
      this.family = family; this.source = source; this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
      this.weight = descriptors.weight ?? "400"; this.style = descriptors.style ?? "normal"; this.display = descriptors.display ?? "auto";
      this.status = "loaded"; this.loaded = Promise.resolve(this);
      declare(family, source, descriptors);
    }
    load() { return Promise.resolve(this); }
  }

  class FileReader {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((ab) => {
        this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(ab).toString("base64")}`;
        this.onload?.({ target: this }); this.onloadend?.({ target: this });
      }, (e) => { this.error = e; this.onerror?.({ target: this }); });
    }
    readAsArrayBuffer(blob) { blob.arrayBuffer().then((ab) => { this.result = ab; this.onload?.({ target: this }); this.onloadend?.({ target: this }); }); }
    addEventListener(t, f) { this["on" + t] = f; }
  }

  const documentElement = element("html");
  const document = {
    documentElement, body: element("body"), head: element("head"), fonts,
    createElement: (tag) => (String(tag).toLowerCase() === "canvas" ? canvasElement() : String(tag).toLowerCase() === "img" ? new ImageElement() : element(tag)),
    createElementNS: (_ns, tag) => element(tag), createTextNode: () => element("#text"),
    addEventListener: noop, removeEventListener: noop, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
    visibilityState: "visible", hidden: false, readyState: "complete",
  };

  Object.assign(g, {
    window: g, self: g, document, FontFace, FileReader, Image: ImageElement, HTMLImageElement: ImageElement, Path2D, DOMMatrix, ImageData,
    devicePixelRatio: 1, innerWidth: 1024, innerHeight: 768,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true,
    requestAnimationFrame: (f) => setTimeout(() => f(performance.now()), 0), cancelAnimationFrame: (t) => clearTimeout(t),
    requestIdleCallback: (f) => setTimeout(() => f({ didTimeout: false, timeRemaining: () => 50 }), 0), cancelIdleCallback: (t) => clearTimeout(t),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop }, sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    location: new URL("http://localhost/"), EXCALIDRAW_ASSET_PATH: assetPath,
  });
  if (!g.navigator?.userAgent || !g.navigator.platform) Object.defineProperty(g, "navigator", { configurable: true, value: { userAgent: "Node", platform: process.platform, language: "en", clipboard: {} } });
  for (const c of ["HTMLElement", "Element", "Node", "Document", "HTMLCanvasElement", "HTMLBRElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement"]) g[c] ??= class {};
}
