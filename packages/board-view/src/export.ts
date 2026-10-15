// get_image, the drawing part (the old page's board.ts getImage): the PNG of the chosen elements and the bounds Excalidraw measured.
// Which elements to draw is the app's choice (it sends their ids); the sizes and limits are imagesize.ts's.
import { exportToBlob, getCommonBounds } from "@excalidraw/excalidraw";
import type { El, ExportValue, Files } from "@aiwb/board-bridge/messages.ts";
import { RpcError } from "./apply.ts";
import { EXPORT_PADDING, chooseElements, countElements, pictureSize, rootElements, type Bounds } from "./imagesize.ts";

export type ExportInput = {
  /** Every element of the scene, deleted ones included. */
  elements: readonly El[];
  files: Files;
  /** The colour of the sheet (a board file keeps it; white when it keeps none). */
  viewBackgroundColor?: string;
  /** The elements to draw (bound text of a named container goes with it); empty: every element. */
  ids: readonly string[];
  scale: number;
  background: boolean;
};

/** A blob as base64 with no `data:` prefix. */
function base64Of(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function exportPicture(input: ExportInput): Promise<ExportValue> {
  const chosen = chooseElements(input.elements as (El & { x: number; y: number; width: number; height: number })[], input.ids);
  if (!chosen.ok) throw new RpcError(chosen.code, chosen.message);
  const els = chosen.value;
  // render: after the fonts are ready, or the text is drawn in a fallback font
  try { await document.fonts?.ready; } catch { /* no font API: the first draw is not waited for */ }
  // Excalidraw measures the picture itself (a frame's name, the children clipped to a frame, an arrow by its curve); the limit
  // is checked on the size it hands getDimensions, before the canvas exists, and the bounds are that size
  const drawn: { bounds?: Bounds; size?: { width: number; height: number } } = {};
  let blob: Blob;
  try {
    blob = await exportToBlob({
      elements: els as never,
      appState: { exportBackground: input.background, viewBackgroundColor: input.viewBackgroundColor ?? "#ffffff", exportWithDarkMode: false },
      files: input.files as never,
      mimeType: "image/png",
      exportPadding: EXPORT_PADDING,
      getDimensions: (w: number, h: number) => {
        const size = pictureSize(w, h, input.scale);
        if (!size.ok) throw new RpcError(size.code, size.message);
        // the left edge and the bottom of what is drawn are the elements'; a frame's name adds to the top
        const [x0, , , y1] = getCommonBounds(rootElements(els as never[]) as never);
        drawn.bounds = { x: x0, y: y1 - (h - 2 * EXPORT_PADDING), width: w - 2 * EXPORT_PADDING, height: h - 2 * EXPORT_PADDING };
        drawn.size = size.value;
        return { ...size.value, scale: input.scale };
      },
    });
  } catch (err) {
    if (err instanceof RpcError) throw err;
    throw new RpcError("RENDER_FAILED", `the picture could not be drawn: ${(err as Error)?.message ?? String(err)}`);
  }
  if (!drawn.bounds || !drawn.size) throw new RpcError("RENDER_FAILED", "the picture could not be drawn: its size was never measured");
  return { png: await base64Of(blob), width: drawn.size.width, height: drawn.size.height, bounds: drawn.bounds, count: countElements(els as never[]) };
}
