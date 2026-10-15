// get_image, the parts that need no canvas: reading the arguments, the box of an element (for rect and refs), the size
// of the picture from the size Excalidraw gives (and the refusals of a size above the limit or below a pixel), and the
// result text. DOM-free.

/** The first limits on a picture, after scale: its longest side in pixels, and its area. The agent's client may
 *  shrink what it gets anyway; these only keep a render (and the base64 that follows) from growing without bound. */
export const MAX_SIDE_PX = 8192;
export const MAX_PIXELS = 32_000_000;
/** The margin around the drawn elements, in board units. */
export const EXPORT_PADDING = 16;
export const DEFAULT_SCALE = 1;
export const MAX_SCALE = 2;

export type Scope = "selection" | "all" | "refs" | "rect";
const SCOPES: readonly string[] = ["selection", "all", "refs", "rect"];

export type ImageArgs = { scope?: Scope; scale: number; background: boolean };
export type Failure = { code: string; message: string };
export type Parsed<T> = { ok: true; value: T } | ({ ok: false } & Failure);

const bad = (message: string): { ok: false } & Failure => ({ ok: false, code: "BAD_ARGS", message });

/** The arguments of get_image that do not name elements: scope (left as given, undefined when omitted), scale
 *  (default 1; above 2 it is 2) and background (default true). */
export function parseImageArgs(args: any): Parsed<ImageArgs> {
  const a = args ?? {};
  let scope: Scope | undefined;
  if (a.scope !== undefined && a.scope !== null) {
    if (typeof a.scope !== "string" || !SCOPES.includes(a.scope)) return bad(`scope must be one of ${SCOPES.join(", ")}, not ${JSON.stringify(a.scope)}`);
    scope = a.scope as Scope;
  }
  let scale = DEFAULT_SCALE;
  if (a.scale !== undefined && a.scale !== null) {
    if (typeof a.scale !== "number" || !Number.isFinite(a.scale) || a.scale <= 0) return bad(`scale must be a number above 0 (at most ${MAX_SCALE}), not ${JSON.stringify(a.scale)}`);
    scale = Math.min(a.scale, MAX_SCALE);
  }
  let background = true;
  if (a.background !== undefined && a.background !== null) {
    if (typeof a.background !== "boolean") return bad(`background must be true or false, not ${JSON.stringify(a.background)}`);
    background = a.background;
  }
  return { ok: true, value: { scope, scale, background } };
}

export type Bounds = { x: number; y: number; width: number; height: number };
type Shaped = { x: number; y: number; width: number; height: number; points?: number[][]; angle?: number };

/** The box around the elements in board coordinates, as drawn: an arrow or line by its points, and a rotated element by
 *  its rotated corners (or points), as Excalidraw sizes the picture; null when there are none. */
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

/** The points turned by `angle` (radians) around the centre of their unrotated box, which is how Excalidraw rotates an element. */
function rotated(pts: number[][], angle = 0): number[][] {
  if (!angle) return pts;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return pts.map(([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos]);
}

/** The size of the picture in pixels: the bounds and the padding on both sides, times scale. */
export function pixelSize(b: Bounds, scale: number, padding = EXPORT_PADDING): { width: number; height: number } {
  return { width: Math.ceil((b.width + 2 * padding) * scale), height: Math.ceil((b.height + 2 * padding) * scale) };
}

/** The elements Excalidraw sizes the picture by: those that are not inside a frame that is itself drawn (a child of a
 *  frame is clipped to it, so it adds nothing), as its own getRootElements. */
export function rootElements<T extends { id: string; type?: string; frameId?: string | null }>(els: readonly T[]): T[] {
  const frames = new Set(els.filter((e) => e.type === "frame" || e.type === "magicframe").map((e) => e.id));
  return els.filter((e) => frames.has(e.id) || !e.frameId || !frames.has(e.frameId));
}

/** The canvas for the box Excalidraw measured (`w` x `h` board units, the padding in): its pixel size at `scale`, or the
 *  refusal. The size is rounded up as pixelSize does, and a scale that leaves a side under 1 px is BAD_ARGS, not a blank canvas. */
export function pictureSize(w: number, h: number, scale: number): Parsed<{ width: number; height: number }> {
  if (w * scale < 1 || h * scale < 1)
    return bad(`scale ${scale} would make the picture smaller than 1 px (${w * scale} x ${h * scale}); use a larger scale`);
  const size = { width: Math.ceil(w * scale), height: Math.ceil(h * scale) };
  const tooLarge = checkLimit(size);
  return tooLarge ? { ok: false, ...tooLarge } : { ok: true, value: size };
}

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

/** The one line of text that goes with the picture: the scope that was used, the bounds of the drawn elements and their
 *  count. `board` is the board's name and id. */
export function resultText(scope: Scope, b: Bounds, count: number, board: string): string {
  const n = (v: number) => Math.round(v);
  return `scope ${scope}, bounds x=${n(b.x)} y=${n(b.y)} w=${n(b.width)} h=${n(b.height)} (board coordinates), ${count} element${count === 1 ? "" : "s"}, ${board}`;
}

/** The elements that count as elements: bound text is part of its container. */
export const countElements = (els: readonly { containerId?: string | null }[]) => els.filter((e) => !e.containerId).length;

/** Without a scope: the selection when the board is on screen and something is selected on it, else everything. */
export function defaultScope(scope: Scope | undefined, onScreen: boolean, selected: number): Scope {
  return scope ?? (onScreen && selected > 0 ? "selection" : "all");
}

/** The rect argument: finite numbers, width and height above 0. */
export function parseRect(rect: any): Parsed<Bounds> {
  const r = rect;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!r || typeof r !== "object" || !num(r.x) || !num(r.y) || !num(r.width) || !num(r.height) || r.width <= 0 || r.height <= 0)
    return bad(`scope rect needs rect {x, y, width, height} in board coordinates: finite numbers, width and height above 0, not ${JSON.stringify(rect)}`);
  return { ok: true, value: { x: r.x, y: r.y, width: r.width, height: r.height } };
}

/** The refs argument of scope refs: a non-empty list of {key} or {id}. */
export function parseRefs(refs: any): Parsed<any[]> {
  if (!Array.isArray(refs) || !refs.length) return bad("scope refs needs refs: a list of {key} or {id}");
  for (const r of refs)
    if (!r || typeof r !== "object" || !((typeof r.id === "string" && r.id) || (typeof r.key === "string" && r.key)))
      return bad(`each ref must be {key} or {id}, not ${JSON.stringify(r)}`);
  return { ok: true, value: refs };
}

/** True when the element's box (an arrow or line by its points, a rotated element as rotated) lies completely inside the rect. An element that
 *  sticks out on any side, or only touches the rect from outside, is not inside; one that fits exactly is. */
export function insideRect(e: Shaped, r: Bounds): boolean {
  const b = imageBounds([e])!;
  return b.x >= r.x && b.y >= r.y && b.x + b.width <= r.x + r.width && b.y + b.height <= r.y + r.height;
}

type Placed = Shaped & { id: string; containerId?: string | null };

/** The elements of `scene` (scene order) that are in `chosen`, plus the bound text of every chosen container (a shape's
 *  or an arrow's label). Nothing else is added: not the elements an arrow is bound to, not the children of a frame. */
export function withBoundText<T extends Placed>(scene: readonly T[], chosen: ReadonlySet<string>): T[] {
  return scene.filter((e) => chosen.has(e.id) || (!!e.containerId && chosen.has(e.containerId)));
}

/** The ids of the elements completely inside the rect, bound text left to follow its container. */
export function idsInsideRect(scene: readonly Placed[], r: Bounds): Set<string> {
  return new Set(scene.filter((e) => !e.containerId && insideRect(e, r)).map((e) => e.id));
}
