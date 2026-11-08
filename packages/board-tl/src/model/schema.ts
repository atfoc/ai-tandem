// The one tldraw schema of a new board (design 1.2, D1): the window's store and the board host's rooms are built from it.
// DOM-free: imports only `@tldraw/tlschema` and our DOM-free modules, so it loads in plain Node (test/schema.test.ts).
//
// tldraw's default shapes, with:
// - `geo`: tldraw's props plus `fillColor` and `labelSize` (styles.ts), and the rounded rectangle as a `geo` value;
// - `aiwb-sticky`: our sticky (shapes/sticky-props.ts);
// and tldraw's default bindings. The shape utils (`shapes/`) use these very props objects (`static props`).

import { createTLSchema, defaultBindingSchemas, defaultShapeSchemas, geoShapeMigrations, geoShapeProps } from "@tldraw/tlschema";
import { FILL_COLOR_PROP, LABEL_SIZE_PROP, STICKY_TYPE } from "./palette.ts";
import { FillColorStyle, LabelSizeStyle } from "./styles.ts";
import { stickyShapeMigrations, stickyShapeProps } from "./shapes/sticky-props.ts";

declare module "@tldraw/tlschema" {
  interface TLGeoShapeProps {
    fillColor: import("./styles.ts").FillColor;
    labelSize: import("./styles.ts").LabelSize;
  }
}

/**
 * Our geo's props: tldraw's and our two style props. No migration of our own for them: geo records written before them do not
 * exist (the prototype starts with them); a release that changes them adds a migration.
 */
export const aiwbGeoShapeProps = {
  ...geoShapeProps,
  [FILL_COLOR_PROP]: FillColorStyle,
  [LABEL_SIZE_PROP]: LabelSizeStyle,
} as const;
export const aiwbGeoShapeMigrations = geoShapeMigrations;

export const SHAPE_SCHEMAS = {
  ...defaultShapeSchemas,
  geo: { props: aiwbGeoShapeProps, migrations: aiwbGeoShapeMigrations },
  [STICKY_TYPE]: { props: stickyShapeProps, migrations: stickyShapeMigrations },
};

export const tlSchema = createTLSchema({ shapes: SHAPE_SCHEMAS, bindings: defaultBindingSchemas });
