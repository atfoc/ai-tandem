// The one place the board host takes its tldraw schema from (design 1.2, D1). For now tldraw's default schema; when the shared
// model of `@aiwb/board-tl` exists, this file imports its schema instead and nothing else changes.
import { createTLSchema, type TLRecord } from "@tldraw/tlschema";
import type { StoreSchema } from "@tldraw/store";

export type BoardRecord = TLRecord;
export type BoardSchema = StoreSchema<BoardRecord, any>;

export function boardSchema(): BoardSchema {
  return createTLSchema();
}
