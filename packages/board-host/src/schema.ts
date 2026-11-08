// The one place the board host takes its tldraw schema from (design 1.2, D1): the shared model of `@aiwb/board-tl` (the same
// schema and shape utils the window builds its store and editor from). The shape and binding utils the editor is built with
// (node/editor.ts) and the room's schema (rooms.ts) come from here, so the two agree.
//
// It imports `tldraw` (through the shape utils): in the process, the page (node/install-page.ts) is installed before this
// module is evaluated.
import type { StoreSchema } from "@tldraw/store";
import type { TLRecord } from "@tldraw/tlschema";
import { defaultBindingUtils } from "tldraw";
import { STICKY_TYPE as MODEL_STICKY_TYPE } from "@aiwb/board-tl/model/palette.ts";
import { tlSchema } from "@aiwb/board-tl/model/schema.ts";
import { SHAPE_UTILS } from "@aiwb/board-tl/model/shapes/index.ts";

export type BoardRecord = TLRecord;
export type BoardSchema = StoreSchema<BoardRecord, any>;

/** The shape utils of the board (the editor's): tldraw's defaults with our geo and frame, plus our sticky. */
export const shapeUtils = SHAPE_UTILS;
/** The binding utils of the board. */
export const bindingUtils = defaultBindingUtils;
/** The sticky's shape type. */
export const STICKY_TYPE = MODEL_STICKY_TYPE;

export function boardSchema(): BoardSchema {
  return tlSchema as unknown as BoardSchema;
}
