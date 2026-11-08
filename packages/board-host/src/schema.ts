// The one place the board host takes its tldraw schema from (design 1.2, D1): the shape and binding utils the editor is built
// with (node/editor.ts) and the room's schema (rooms.ts), made from the same utils so the two agree. For now tldraw's defaults,
// with tldraw's `note` standing in for our sticky; when the shared model of `@aiwb/board-tl` exists, this file imports its
// schema and utils instead and nothing else changes.
//
// It imports `tldraw`: in the process, the page (node/install-page.ts) is installed before this module is evaluated.
import type { StoreSchema } from "@tldraw/store";
import type { TLRecord } from "@tldraw/tlschema";
import { createTLSchemaFromUtils, defaultBindingUtils, defaultShapeUtils } from "tldraw";

export type BoardRecord = TLRecord;
export type BoardSchema = StoreSchema<BoardRecord, any>;

/** The shape utils of the board (the editor's and the schema's). */
export const shapeUtils = defaultShapeUtils;
/** The binding utils of the board. */
export const bindingUtils = defaultBindingUtils;
/** The sticky's shape type: tldraw's note until our sticky exists. */
export const STICKY_TYPE = "note";

export function boardSchema(): BoardSchema {
  return createTLSchemaFromUtils({ shapeUtils, bindingUtils });
}
