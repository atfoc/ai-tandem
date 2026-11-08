// Our geo (goal 3.2, 3.3; decisions, window lane): tldraw's `GeoShapeUtil`, type `geo`, with
// - the rounded rectangle as a custom geo value (`customGeoTypes`; the value itself is added to `GeoShapeGeoStyle` by
//   styles.ts, so it validates in the schema without this util);
// - a fill colour separate from the border colour: our `fillColor` style prop drawn as the fill (with the colour variant tldraw
//   uses for the shape's `fill` style; `semi` and `none` stay tldraw's), `color` the border;
// - a label size separate from the border width: our `labelSize` drives the label's font size (and its min width), through
//   tldraw's display values, which its label measure (growY), its drawing and its SVG export all read; `size` stays the
//   border width.
// tldraw's geo `onBeforeUpdate` re-measures the label only when the text, font or `size` changed, so a change of `labelSize`
// alone is passed on to it as if `size` had changed.
import { GeoShapeUtil, PathBuilder, getColorValue, type TLGeoShape } from "tldraw";
import { LABEL_FONT_SIZES } from "../palette.ts";
import { aiwbGeoShapeMigrations, aiwbGeoShapeProps } from "../schema.ts";
import { ROUNDED_RECT } from "../styles.ts";

/** tldraw's `DEFAULT_FILL_COLOR_NAMES` (not exported): the colour variant each `fill` style draws with. */
const FILL_VARIANT = { solid: "semi", pattern: "pattern", fill: "fill", "lined-fill": "linedFill" } as const;
/** tldraw's `GEO_SHAPE_MIN_WIDTHS` (not exported): a label's min width per size. */
const LABEL_MIN_WIDTHS = { s: 12, m: 14, l: 16, xl: 20 } as const;

const Configured = GeoShapeUtil.configure({
  customGeoTypes: {
    [ROUNDED_RECT]: {
      snapType: "polygon",
      icon: "geo-rectangle",
      getPath: (w: number, h: number, shape: TLGeoShape) => {
        const r = Math.min(16, w / 4, h / 4);
        // isFilled, as tldraw's own geo paths: the fill is drawn (toD onlyFilled) and the inside is hit
        const isFilled = shape.props.fill !== "none";
        return new PathBuilder()
          .moveTo(r, 0, { geometry: { isFilled } })
          .lineTo(w - r, 0)
          .circularArcTo(r, false, true, w, r)
          .lineTo(w, h - r)
          .circularArcTo(r, false, true, w - r, h)
          .lineTo(r, h)
          .circularArcTo(r, false, true, 0, h - r)
          .lineTo(0, r)
          .circularArcTo(r, false, true, r, 0)
          .close();
      },
    },
  },
  getCustomDisplayValues(_editor, shape, theme, colorMode) {
    const { fill, fillColor, labelSize } = shape.props;
    const colors = theme.colors[colorMode];
    const out: Record<string, unknown> = {
      labelFontSize: theme.fontSize * LABEL_FONT_SIZES[labelSize],
      labelMinWidth: LABEL_MIN_WIDTHS[labelSize],
    };
    if (fill !== "none" && fill !== "semi") {
      out.fillColor = getColorValue(colors, fillColor, FILL_VARIANT[fill as keyof typeof FILL_VARIANT] ?? "fill");
      out.patternFillFallbackColor = getColorValue(colors, fillColor, "semi");
    }
    return out;
  },
});

export class AiwbGeoShapeUtil extends Configured {
  static override props = aiwbGeoShapeProps as typeof GeoShapeUtil.props;
  static override migrations = aiwbGeoShapeMigrations;

  override getDefaultProps(): TLGeoShape["props"] {
    return { ...super.getDefaultProps(), fillColor: "white", labelSize: "m" };
  }

  override onBeforeUpdate(prev: TLGeoShape, next: TLGeoShape) {
    if (prev.props.labelSize !== next.props.labelSize && prev.props.size === next.props.size) {
      // tldraw's hook compares `size` to decide whether to re-measure; `prev`'s size is only read for that comparison
      const other = next.props.size === "s" ? "m" : "s";
      return super.onBeforeUpdate({ ...prev, props: { ...prev.props, size: other } }, next);
    }
    return super.onBeforeUpdate(prev, next);
  }
}
