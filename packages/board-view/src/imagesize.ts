// The part of get_image that needs no canvas (packages/core/src/logic/image.ts, copied for what the view needs): which elements a
// picture draws, the size of the picture from the size Excalidraw measured, and the limit on it. DOM-free, so node tests it.

/** The first limits on a picture, after scale: its longest side in pixels, and its area. */
export const MAX_SIDE_PX = 8192;
export const MAX_PIXELS = 32_000_000;
/** The margin around the drawn elements, in board units. */
export const EXPORT_PADDING = 16;

export type Failure = { code: string; message: string };
type Parsed<T> = { ok: true; value: T } | ({ ok: false } & Failure);

export type Bounds = { x: number; y: number; width: number; height: number };
type Shaped = { x: number; y: number; width: number; height: number; points?: readonly (readonly number[])[]; angle?: number };

/** The points turned by `angle` (radians) around the centre of their unrotated box, which is how Excalidraw rotates an element. */
function rotated(pts: number[][], angle = 0): number[][] {
  if (!angle) return pts;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return pts.map(([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]);
}

/** The box around the elements in board coordinates, as drawn: an arrow or line by its points, and a rotated element by
 *  its rotated corners (or points); null when there are none. */
export function imageBounds(elements: readonly Shaped[]): Bounds | null {
  if (!elements.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of elements) {
    const pts = e.points ? e.points.map((p) => [e.x + p[0], e.y + p[1]]) : [[e.x, e.y], [e.x + e.width, e.y], [e.x + e.width, e.y + e.height], [e.x, e.y + e.height]];
    for (const [px, py] of rotated(pts, e.angle)) {
      x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
    }
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** False for an element that draws nothing and that Excalidraw drops before it sizes the picture: a line, arrow or freedraw
 *  with fewer than two points, or any element whose own box has no width and no height. A straight horizontal or vertical
 *  line (one side 0) has an extent and stays. */
export function hasExtent(e: Shaped): boolean {
  if (e.points && e.points.length < 2) return false;
  const b = imageBounds([e])!;
  return b.width !== 0 || b.height !== 0;
}

/** The elements Excalidraw sizes the picture by: those that are not inside a frame that is itself drawn (a child of a
 *  frame is clipped to it, so it adds nothing), as its own getRootElements. */
export function rootElements<T extends { id: string; type?: string; frameId?: string | null }>(els: readonly T[]): T[] {
  const frames = new Set(els.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  return els.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId));
}

/** The elements of `scene` (scene order) that are in `chosen`, plus the bound text of every chosen container (a shape's
 *  or an arrow's label). Nothing else is added: not the elements an arrow is bound to, not the children of a frame. */
export function withBoundText<T extends { id: string; containerId?: string | null }>(scene: readonly T[], chosen: ReadonlySet<string>): T[] {
  return scene.filter((e) => chosen.has(e.id) || (!!e.containerId && chosen.has(e.containerId)));
}

/** The elements that count as elements: bound text is part of its container. */
export const countElements = (els: readonly { id: string; containerId?: string | null }[]) => els.filter((e) => !e.containerId).length;

/** null when the picture may be drawn, else the TOO_LARGE refusal naming the size and the limit. */
export function checkLimit(size: { width: number; height: number }): Failure | null {
  const pixels = size.width * size.height;
  if (Math.max(size.width, size.height) <= MAX_SIDE_PX && pixels <= MAX_PIXELS) return null;
  return {
    code: "TOO_LARGE",
    message: `the picture would be ${size.width}x${size.height} px (${(pixels / 1e6).toFixed(1)} megapixels); the limit is ${MAX_SIDE_PX} px on the longest side and ${MAX_PIXELS / 1e6} megapixels. ` +
      "Ask for a smaller scope (refs or rect), or a smaller scale",
  };
}

/** The canvas for the box Excalidraw measured (`w` x `h` board units, the padding in): its pixel size at `scale`, or the
 *  refusal. The size is rounded up, and a scale that leaves a side under 1 px is BAD_ARGS, not a blank canvas. */
export function pictureSize(w: number, h: number, scale: number): Parsed<{ width: number; height: number }> {
  if (w * scale < 1 || h * scale < 1)
    return { ok: false, code: "BAD_ARGS", message: `scale ${scale} would make the picture smaller than 1 px (${w * scale} x ${h * scale}); use a larger scale` };
  const size = { width: Math.ceil(w * scale), height: Math.ceil(h * scale) };
  const tooLarge = checkLimit(size);
  return tooLarge ? { ok: false, ...tooLarge } : { ok: true, value: size };
}

/** The elements a picture draws: the elements named by `ids` (all of them when `ids` is empty) and the bound text of the named
 *  containers, those with an extent. Deleted elements are never drawn. Nothing to draw is the EMPTY refusal. */
export function chooseElements<T extends Shaped & { id: string; isDeleted?: boolean; containerId?: string | null }>(
  scene: readonly T[], ids: readonly string[],
): Parsed<T[]> {
  const all = scene.filter((e) => !e.isDeleted);
  const chosen = new Set(ids.length ? ids : all.map((e) => e.id));
  const withText = withBoundText(all, chosen);
  if (!withText.length) return { ok: false, code: "EMPTY", message: "there are no elements to draw" };
  // elements with no extent are left out before anything is measured or counted, as Excalidraw drops them: they would only stretch the bounds
  const drawn = withText.filter(hasExtent);
  if (!drawn.length) return { ok: false, code: "EMPTY", message: "the chosen elements have no extent (zero width and height), so there is nothing to draw" };
  return { ok: true, value: drawn };
}
