// The shape utils of a new board. Their `static props`/`migrations` are the very objects `schema.ts` builds the schema from.
import { defaultShapeUtils, type TLAnyShapeUtilConstructor } from "tldraw";
import { AiwbFrameShapeUtil } from "./frame.ts";
import { AiwbGeoShapeUtil } from "./geo.ts";
import { StickyShapeUtil, StickyTool } from "./sticky.tsx";

export { AiwbFrameShapeUtil, AiwbGeoShapeUtil, StickyShapeUtil, StickyTool };

/** Ours, for `<Tldraw shapeUtils>` (which adds tldraw's defaults and lets ours replace `geo` and `frame` by type). */
export const CUSTOM_SHAPE_UTILS: TLAnyShapeUtilConstructor[] = [StickyShapeUtil, AiwbGeoShapeUtil, AiwbFrameShapeUtil];

/** The complete list: tldraw's defaults with `geo` and `frame` replaced, plus the sticky (for a bare `new Editor`). */
export const SHAPE_UTILS: TLAnyShapeUtilConstructor[] = [
  ...defaultShapeUtils.map((u) => (u.type === "geo" ? AiwbGeoShapeUtil : u.type === "frame" ? AiwbFrameShapeUtil : u)),
  StickyShapeUtil,
];
