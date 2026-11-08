// get_image on a new board (package H3; design 3.5, decision O4): the board host's picture of the board in its editor, by
// node/export.ts (tldraw's SVG export → outlines → resvg). Scopes all (the default: the host knows no selection), refs and
// rect; scale and background and their wording as today's get_image (packages/core/src/logic/image.ts).
//
// How the export is called, and why (tldraw 5.6.0, getSvgJsx):
// - ids are expanded by tldraw to the shapes and all their descendants, so a frame's children come with it.
// - But a single frame id alone is tldraw's "export this frame" case: the frame itself is not drawn (no outline, no
//   heading), the picture is cropped to the frame without padding, and its background is the frame's fill. And when a
//   frame encloses everything exported, the padding is dropped too. To keep one rule (the frame drawn with what it holds,
//   the picture = bounds + 2 × padding), the ids passed are the drawn shapes themselves (descendants included, so never a
//   lone frame unless the frame is empty, in which case it is passed twice), and the bounds are passed explicitly.
// - getSvgElement([]) would export the whole page: an empty list never reaches it.
import type { Editor, TLShape, TLShapeId } from "tldraw";
import { Box } from "tldraw";
import { keyOf } from "@aiwb/board-tl/model/read.ts";
import { ToolError } from "./agent.ts";
import { exportPng } from "./node/export.ts";

/** The longest side of a picture, in pixels (decision O4). A larger picture is drawn at a lower scale. */
export const MAX_PICTURE_SIDE = 2000;
/** Around the drawn elements, in board units: tldraw's export default (a window's export uses the same). */
export const PICTURE_PADDING = 32;
/** Below this scale the cap refuses (TOO_LARGE) instead of lowering the scale. */
export const MIN_CAPPED_SCALE = 0.1;
const MAX_SCALE = 2;

type Scope = "selection" | "all" | "refs" | "rect";
const SCOPES: readonly string[] = ["selection", "all", "refs", "rect"];
type Rect = { x: number; y: number; width: number; height: number };

const bad = (message: string) => new ToolError("BAD_ARGS", message);

function parseArgs(args: unknown): { scope: Scope; scale: number; background: boolean; a: any } {
  const a: any = args && typeof args === "object" ? args : {};
  let scope: Scope = "all";
  if (a.scope !== undefined && a.scope !== null) {
    if (typeof a.scope !== "string" || !SCOPES.includes(a.scope)) throw bad(`scope must be one of ${SCOPES.join(", ")}, not ${JSON.stringify(a.scope)}`);
    scope = a.scope as Scope;
  }
  let scale = 1;
  if (a.scale !== undefined && a.scale !== null) {
    if (typeof a.scale !== "number" || !Number.isFinite(a.scale) || a.scale <= 0) throw bad(`scale must be a number above 0 (at most ${MAX_SCALE}), not ${JSON.stringify(a.scale)}`);
    scale = Math.min(a.scale, MAX_SCALE);
  }
  let background = true;
  if (a.background !== undefined && a.background !== null) {
    if (typeof a.background !== "boolean") throw bad(`background must be true or false, not ${JSON.stringify(a.background)}`);
    background = a.background;
  }
  return { scope, scale, background, a };
}

function parseRefs(refs: any): any[] {
  if (!Array.isArray(refs) || !refs.length) throw bad("scope refs needs refs: a list of {key} or {id}");
  for (const r of refs)
    if (!r || typeof r !== "object" || !((typeof r.id === "string" && r.id) || (typeof r.key === "string" && r.key)))
      throw bad(`each ref must be {key} or {id}, not ${JSON.stringify(r)}`);
  return refs;
}

function parseRect(rect: any): Rect {
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (!rect || typeof rect !== "object" || !num(rect.x) || !num(rect.y) || !num(rect.width) || !num(rect.height) || rect.width <= 0 || rect.height <= 0)
    throw bad(`scope rect needs rect {x, y, width, height} in board coordinates: finite numbers, width and height above 0, not ${JSON.stringify(rect)}`);
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/** Every shape of the current page, at any depth. */
function pageShapes(editor: Editor): TLShape[] {
  return [...editor.getCurrentPageShapeIds()].map((id) => editor.getShape(id)!).filter(Boolean);
}

/** The shape a ref names on the current page, or undefined. */
function resolveRef(editor: Editor, shapes: TLShape[], ref: { id?: string; key?: string }): TLShape | undefined {
  if (typeof ref.id === "string" && ref.id) {
    const ids = ref.id.startsWith("shape:") ? [ref.id] : [ref.id, "shape:" + ref.id];
    const s = shapes.find((s) => ids.includes(s.id));
    if (s) return s;
  }
  if (typeof ref.key === "string" && ref.key) return shapes.find((s) => keyOf(s) === ref.key);
  void editor;
  return undefined;
}

const fmt = (s: number) => String(Number(s.toPrecision(3)));
const n = (v: number) => Math.round(v);

export async function getImage(editor: Editor, args: unknown, board: { id: string; name: string }): Promise<{ text: string; image: { mimeType: "image/png"; data: string } }> {
  const { scope, scale: asked, background, a } = parseArgs(args);
  const name = board.name;
  const shapes = pageShapes(editor);

  let chosen: TLShape[];
  let rect: Rect | undefined;
  if (scope === "selection") {
    throw new ToolError("NO_SELECTION", "no window's selection is known to the board host; use scope all, refs or rect");
  } else if (scope === "refs") {
    const refs = parseRefs(a.refs);
    chosen = [];
    for (const ref of refs) {
      const s = resolveRef(editor, shapes, ref);
      if (!s) throw new ToolError("UNKNOWN_REF", `${JSON.stringify(ref)} names no element of this board`);
      chosen.push(s);
    }
  } else if (scope === "rect") {
    const r = (rect = parseRect(a.rect));
    chosen = shapes.filter((s) => {
      const b = editor.getShapePageBounds(s);
      return !!b && b.x >= r.x && b.y >= r.y && b.maxX <= r.x + r.width && b.maxY <= r.y + r.height;
    });
  } else {
    chosen = shapes;
  }

  // what is drawn: the chosen shapes and everything they hold (a frame's children, a group's members), in page order
  const drawnIds = editor.getShapeAndDescendantIds(chosen.map((s) => s.id));
  const drawn = shapes.filter((s) => drawnIds.has(s.id) && s.type !== "group");
  let bounds: Box | null = null;
  const withExtent: TLShape[] = [];
  for (const s of drawn) {
    const b = editor.getShapeMaskedPageBounds(s.id);
    if (!b || (b.w === 0 && b.h === 0)) continue;
    withExtent.push(s);
    bounds = bounds ? bounds.union(b) : b.clone();
  }
  if (!bounds || !withExtent.length) {
    if (rect) throw new ToolError("EMPTY", `no element on ${name} lies completely inside x=${rect.x} y=${rect.y} w=${rect.width} h=${rect.height}; use read_board for where things are`);
    throw new ToolError("EMPTY", `${name} has no elements to draw`);
  }

  // the size (O4): (bounds + 2 × padding) × scale, the long side capped at MAX_PICTURE_SIDE by lowering the scale
  const w1 = bounds.w + 2 * PICTURE_PADDING, h1 = bounds.h + 2 * PICTURE_PADDING;
  const long = Math.max(w1, h1);
  let scale = asked;
  let capped = false;
  if (long * scale > MAX_PICTURE_SIDE) {
    const fit = MAX_PICTURE_SIDE / long;
    if (fit < MIN_CAPPED_SCALE)
      throw new ToolError("TOO_LARGE", `the picture would be ${Math.round(w1)}×${Math.round(h1)} px at scale 1; the board host draws at most ${MAX_PICTURE_SIDE} px on the longest side, which would need scale ${fmt(fit)} (below ${MIN_CAPPED_SCALE}); ask for a smaller scope (refs or rect)`);
    scale = fit;
    capped = true;
  }
  if (w1 * scale < 1 || h1 * scale < 1)
    throw bad(`scale ${asked} would make the picture smaller than 1 px (${w1 * scale} x ${h1 * scale}); use a larger scale`);

  const ids = withExtent.map((s) => s.id) as TLShapeId[];
  if (ids.length === 1 && editor.isShapeFrameLike(withExtent[0])) ids.push(ids[0]); // not tldraw's lone-frame export (see the header)
  let png;
  try {
    png = await exportPng(editor, ids, { padding: PICTURE_PADDING, background, scale, bounds });
  } catch (e) {
    throw new ToolError("RENDER_FAILED", e instanceof Error ? e.message : String(e));
  }
  if (!png) throw new ToolError("RENDER_FAILED", `the export of ${withExtent.length} element(s) on ${name} gave no picture`);

  const count = withExtent.length;
  let text = `scope ${scope}, bounds x=${n(bounds.x)} y=${n(bounds.y)} w=${n(bounds.w)} h=${n(bounds.h)} (board coordinates), ${count} element${count === 1 ? "" : "s"}, "${name}" (${board.id})`;
  if (capped) text += `, drawn at scale ${fmt(scale)} (the board host's limit is ${MAX_PICTURE_SIDE} px on the longest side)`;
  return { text, image: { mimeType: "image/png", data: png.png.toString("base64") } };
}
