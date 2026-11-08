// The sticky's record props and migrations (design 7.2, decisions U3 and window lane). DOM-free (only `@tldraw/tlschema` and
// `@tldraw/validate`), so `schema.ts` loads in plain Node; the util (`sticky.tsx`) uses these very objects.

import {
  DefaultFontStyle,
  DefaultHorizontalAlignStyle,
  DefaultVerticalAlignStyle,
  createShapePropsMigrationSequence,
  richTextValidator,
  type RecordProps,
  type TLDefaultFontStyle,
  type TLDefaultHorizontalAlignStyle,
  type TLDefaultVerticalAlignStyle,
  type TLRichText,
  type TLShape,
} from "@tldraw/tlschema";
import { T } from "@tldraw/validate";
import { STICKY_TYPE } from "../palette.ts";
import { StickyColorStyle } from "../styles.ts";
import type { StickyColor } from "../terms.ts";

export interface StickyProps {
  w: number;
  h: number;
  color: StickyColor;
  font: TLDefaultFontStyle;
  align: TLDefaultHorizontalAlignStyle;
  verticalAlign: TLDefaultVerticalAlignStyle;
  richText: TLRichText;
  /** 0: automatic (shrink to fit). Otherwise the font size in px, kept whether it fits or not (palette.ts STICKY_FONT_SIZES). */
  fontSize: number;
  /** The font size the text is drawn at: the fitted one when automatic. Written by the fit, never by a person or an agent. */
  fitted: number;
}

declare module "@tldraw/tlschema" {
  interface TLGlobalShapePropsMap {
    [STICKY_TYPE]: StickyProps;
  }
}

export type StickyShape = TLShape<typeof STICKY_TYPE>;

export const stickyShapeProps: RecordProps<StickyShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  color: StickyColorStyle,
  font: DefaultFontStyle,
  align: DefaultHorizontalAlignStyle,
  verticalAlign: DefaultVerticalAlignStyle,
  richText: richTextValidator,
  fontSize: T.number,
  fitted: T.number,
};

/** No migration yet: version 0 is the first stored form. */
export const stickyShapeMigrations = createShapePropsMigrationSequence({ sequence: [] });
