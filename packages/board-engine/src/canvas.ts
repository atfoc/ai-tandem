// The native canvas behind the stand-in page: skia-canvas (the same Skia as Chromium's; it finds the system's fonts through
// the system's font manager, which a browser's fallback needs). Canvas elements, Image, Path2D, DOMMatrix, ImageData, a font
// registrar and a PNG encoder.
import { Canvas, DOMMatrix, FontLibrary, Image, ImageData, Path2D } from "skia-canvas";
import type { CanvasRenderingContext2D } from "skia-canvas";

export { DOMMatrix, Image, ImageData, Path2D };
export type { Canvas, CanvasRenderingContext2D };

/** Text is drawn as Chromium draws it with `optimizeLegibility` (measured: the strongly differing pixels of a text board go
 *  from 0.96% to 0.12%; widths do not change). */
const CONTEXT_OPTIONS = { textRendering: "optimizeLegibility" } as const;

/** A canvas whose 2D context has `optimizeLegibility` from the start. */
export function createCanvas(width: number, height: number): Canvas {
  const canvas = new Canvas(width, height);
  const getContext = canvas.getContext.bind(canvas) as (type: string, options?: unknown) => CanvasRenderingContext2D | null;
  let configured = false;
  (canvas as { getContext: unknown }).getContext = (type: string, options?: unknown) => {
    const ctx = getContext(type, options);
    if (ctx && !configured) {
      configured = true;
      Object.assign(ctx, CONTEXT_OPTIONS);
    }
    return ctx;
  };
  return canvas;
}

/** Registers a font file under `alias`; false when the library cannot read it. */
export function register(file: string, alias: string): boolean {
  try {
    FontLibrary.use(alias, [file]);
    return true;
  } catch {
    return false;
  }
}

export const png = (canvas: Canvas): Promise<Buffer> => canvas.toBuffer("png");

