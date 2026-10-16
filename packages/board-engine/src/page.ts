// The stand-in page: what Excalidraw's element code and its export reach for in a browser, supplied around it (goal 4.5).
// Install it before Excalidraw is evaluated: Excalidraw makes <img> elements and FontFaces at module load.
//
// - window, self, document (createElement of canvas, img and anything else; fonts; the few listeners), location, navigator,
//   devicePixelRatio 1, matchMedia, requestAnimationFrame, localStorage, ResizeObserver, getComputedStyle.
// - canvas: skia-canvas (canvas.ts). Its font setter is wrapped so the family list Excalidraw sets is drawn and measured with
//   Excalidraw's own font files, piece by piece (fonts.ts). toBlob is added.
// - img / Image: the library's Image (decodes PNG, JPEG, GIF, WebP and SVG from a data: URL or bytes).
// - FontFace and document.fonts: every face Excalidraw declares is kept (fonts.ts); loading is immediate.
// - FileReader (readAsDataURL), enough for a Blob to become base64.
import { pathToFileURL } from "node:url";
import { DOMMatrix, Image, ImageData, Path2D, createCanvas, png, register } from "./canvas.ts";
import { declare, nativeFont, runsOf, setRegister } from "./fonts.ts";
import type { FaceDescriptors } from "./fonts.ts";

// The stand-in is the whole point of this file: it assigns to the global object what a browser has, so most of it is untyped.
type Any = any;

const g = globalThis as Any;
const noop = (): void => {};

export interface PageOptions {
  /** The folder that holds `fonts/` (Excalidraw's `dist/prod` layout): becomes `EXCALIDRAW_ASSET_PATH`. */
  assets: string;
}

/** Installs the stand-in page on the global object. Idempotent: a second call does nothing. */
export function installPage({ assets }: PageOptions): void {
  if (g.__aiwbPage) return;
  g.__aiwbPage = true;
  const assetPath = pathToFileURL(assets.replace(/[\\/]?$/, "/")).href;
  setRegister(register);

  // ---- the canvas: Excalidraw's font strings name its families; the native canvas is given the pieces of each
  const probe = createCanvas(1, 1).getContext("2d") as Any;
  const proto = Object.getPrototypeOf(probe);
  const fontProp = (() => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, "font");
      if (d) return { owner: p, d };
    }
    return null;
  })();
  if (!fontProp) throw new Error("stand-in page: the native canvas has no font property");
  const asked = new WeakMap<object, string>();
  const setNative = (ctx: Any, v: string): void => fontProp.d.set!.call(ctx, v);
  Object.defineProperty(fontProp.owner, "font", {
    configurable: true,
    get(this: Any) {
      return asked.get(this) ?? fontProp.d.get!.call(this);
    },
    set(this: Any, v: unknown) {
      asked.set(this, String(v));
      setNative(this, nativeFont(String(v)));
    },
  });
  // measureText, fillText and strokeText go run by run when a text needs more than one face (fonts.ts runsOf)
  const methodOwner = (name: string): Any => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) if (Object.hasOwn(p, name)) return p;
    return null;
  };
  const native = Object.fromEntries(["measureText", "fillText", "strokeText"].map((m) => [m, methodOwner(m)[m]])) as Record<string, Any>;
  const runs = (ctx: Any, text: unknown, forDrawing = false) => {
    const f = asked.get(ctx);
    return f ? runsOf(f, String(text), { forDrawing }) : null;
  };
  const widths = (ctx: Any, rs: { font: string; text: string }[]): number[] =>
    rs.map((r) => {
      setNative(ctx, r.font);
      return native.measureText.call(ctx, r.text).width;
    });
  methodOwner("measureText").measureText = function (this: Any, text: unknown) {
    const rs = runs(this, text);
    if (!rs || rs.length < 2) {
      if (rs) setNative(this, rs[0].font);
      const m = native.measureText.call(this, text);
      if (rs) setNative(this, nativeFont(asked.get(this)!));
      return m;
    }
    setNative(this, rs[0].font);
    const first = native.measureText.call(this, rs[0].text);
    const width = widths(this, rs).reduce((a, b) => a + b, 0);
    setNative(this, nativeFont(asked.get(this)!));
    return {
      actualBoundingBoxAscent: first.actualBoundingBoxAscent,
      actualBoundingBoxDescent: first.actualBoundingBoxDescent,
      fontBoundingBoxAscent: first.fontBoundingBoxAscent,
      fontBoundingBoxDescent: first.fontBoundingBoxDescent,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: width,
      width,
    };
  };
  for (const m of ["fillText", "strokeText"]) {
    methodOwner(m)[m] = function (this: Any, text: unknown, x: number, y: number, maxWidth?: number) {
      const rs = runs(this, text, true);
      if (!rs || rs.length < 2) {
        if (rs) setNative(this, rs[0].font);
        const r = maxWidth === undefined ? native[m].call(this, text, x, y) : native[m].call(this, text, x, y, maxWidth);
        if (rs) setNative(this, nativeFont(asked.get(this)!));
        return r;
      }
      const ws = widths(this, rs);
      const total = ws.reduce((a, b) => a + b, 0);
      const align = this.textAlign;
      const rtl = this.direction === "rtl";
      let at = x - (align === "center" ? total / 2 : align === "right" || (align === "end" && !rtl) || (align === "start" && rtl) ? total : 0);
      this.textAlign = "left";
      rs.forEach((r, i) => {
        setNative(this, r.font);
        native[m].call(this, r.text, at, y);
        at += ws[i];
      });
      this.textAlign = align;
      setNative(this, nativeFont(asked.get(this)!));
    };
  }

  const element = (tag: string): Any => ({
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    appendChild: (c: unknown) => c,
    removeChild: (c: unknown) => c,
    remove: noop,
    addEventListener: noop,
    removeEventListener: noop,
    getBoundingClientRect: () => ({ x: 0, y: 0, top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    getContext: () => null,
    cloneNode: () => element(tag),
  });

  function canvasElement(w = 300, h = 150): Any {
    const c: Any = createCanvas(w, h);
    // the `dir` of a canvas is the direction its text is laid out in (Excalidraw sets it for right-to-left text)
    const setDir = (v: unknown): void => {
      const x = c.getContext("2d");
      if (x && "direction" in x) x.direction = v === "rtl" ? "rtl" : "ltr";
    };
    Object.assign(c, {
      tagName: "CANVAS",
      style: {},
      dataset: {},
      classList: { add: noop, remove: noop },
      isConnected: true,
      setAttribute: (k: string, v: unknown) => {
        if (k === "dir") setDir(v);
      },
      removeAttribute: (k: string) => {
        if (k === "dir") setDir("ltr");
      },
      addEventListener: noop,
      removeEventListener: noop,
      remove: noop,
      toBlob(cb: (b: Blob | null) => void) {
        Promise.resolve()
          .then(() => png(c))
          .then(
            (buf) => cb(new Blob([new Uint8Array(buf)], { type: "image/png" })),
            () => cb(null),
          );
      },
    });
    return c;
  }

  class ImageElement extends (Image as Any) {
    style: Record<string, unknown> = {};
    crossOrigin: string | null = null;
    decoding = "auto";
    // (Excalidraw draws an uncropped picture by its natural size)
    get naturalWidth(): number {
      return (this as Any).width;
    }
    get naturalHeight(): number {
      return (this as Any).height;
    }
    addEventListener(type: string, f: unknown): void {
      if (type === "load") (this as Any).onload = f;
      else if (type === "error") (this as Any).onerror = f;
    }
    removeEventListener(): void {}
    decode(): Promise<void> {
      const self = this as Any;
      return self.complete
        ? Promise.resolve()
        : new Promise((res, rej) => {
            const l = self.onload;
            const e = self.onerror;
            self.onload = () => {
              l?.();
              res();
            };
            self.onerror = (x: unknown) => {
              e?.(x);
              rej(x);
            };
          });
    }
  }

  const fontSet = new Set<unknown>();
  const fonts: Any = {
    add: (f: unknown) => (fontSet.add(f), fonts),
    has: (f: unknown) => fontSet.has(f),
    delete: (f: unknown) => fontSet.delete(f),
    clear: () => fontSet.clear(),
    forEach: (fn: (a: unknown, b: unknown, s: unknown) => void) => fontSet.forEach((f) => fn(f, f, fonts)),
    [Symbol.iterator]: () => fontSet.values(),
    get size() {
      return fontSet.size;
    },
    check: () => true,
    load: async () => [],
    ready: Promise.resolve(),
    status: "loaded",
    addEventListener: noop,
    removeEventListener: noop,
  };

  class FontFace {
    family: string;
    source: unknown;
    unicodeRange: string;
    weight: string;
    style: string;
    display: string;
    status = "loaded";
    loaded: Promise<FontFace>;
    constructor(family: string, source: string | ArrayBuffer | ArrayBufferView, descriptors: FaceDescriptors & { display?: string } = {}) {
      this.family = family;
      this.source = source;
      this.unicodeRange = descriptors.unicodeRange ?? "U+0-10FFFF";
      this.weight = descriptors.weight ?? "400";
      this.style = descriptors.style ?? "normal";
      this.display = descriptors.display ?? "auto";
      this.loaded = Promise.resolve(this);
      declare(family, source, descriptors);
    }
    load(): Promise<FontFace> {
      return Promise.resolve(this);
    }
  }

  class FileReader {
    result: unknown;
    error: unknown;
    [handler: string]: Any;
    readAsDataURL(blob: Blob): void {
      blob.arrayBuffer().then(
        (ab) => {
          this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(ab).toString("base64")}`;
          this.onload?.({ target: this });
          this.onloadend?.({ target: this });
        },
        (e) => {
          this.error = e;
          this.onerror?.({ target: this });
        },
      );
    }
    readAsArrayBuffer(blob: Blob): void {
      blob.arrayBuffer().then((ab) => {
        this.result = ab;
        this.onload?.({ target: this });
        this.onloadend?.({ target: this });
      });
    }
    addEventListener(t: string, f: unknown): void {
      this["on" + t] = f;
    }
  }

  const document = {
    documentElement: element("html"),
    body: element("body"),
    head: element("head"),
    fonts,
    createElement: (tag: string) => (String(tag).toLowerCase() === "canvas" ? canvasElement() : String(tag).toLowerCase() === "img" ? new ImageElement() : element(tag)),
    createElementNS: (_ns: unknown, tag: string) => element(tag),
    createTextNode: () => element("#text"),
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    visibilityState: "visible",
    hidden: false,
    readyState: "complete",
  };

  const observer = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  Object.assign(g, {
    window: g,
    self: g,
    document,
    FontFace,
    FileReader,
    Image: ImageElement,
    HTMLImageElement: ImageElement,
    Path2D,
    DOMMatrix,
    ImageData,
    devicePixelRatio: 1,
    innerWidth: 1024,
    innerHeight: 768,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    requestIdleCallback: (f: (d: unknown) => void) => setTimeout(() => f({ didTimeout: false, timeRemaining: () => 50 }), 0),
    cancelIdleCallback: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop },
    sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    ResizeObserver: observer,
    IntersectionObserver: observer,
    MutationObserver: class {
      observe(): void {}
      disconnect(): void {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    location: new URL("http://localhost/"),
    EXCALIDRAW_ASSET_PATH: assetPath,
  });
  if (!g.navigator?.userAgent || !g.navigator.platform) {
    Object.defineProperty(g, "navigator", { configurable: true, value: { userAgent: "Node", platform: process.platform, language: "en", clipboard: {} } });
  }
  for (const c of ["HTMLElement", "Element", "Node", "Document", "HTMLCanvasElement", "HTMLBRElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement"]) {
    g[c] ??= class {};
  }
}
