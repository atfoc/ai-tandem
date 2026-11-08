// tldraw's own geo and frame, configured (goal 3.3, 7.2): a rounded rectangle as one more value of `GeoShapeGeoStyle`
// (tldraw 5.6 has no rounded rectangle; `customGeoTypes` adds values to the style, registered when the editor is made,
// like the theme's colours), and frames that show their colour as a background (`showColors`; off by default, the
// frame's `color` then only tints nothing visible).
import { FrameShapeUtil, GeoShapeUtil, PathBuilder } from "tldraw";

export const ROUNDED_RECT = "rounded-rectangle";

export const AiwbGeoShapeUtil = GeoShapeUtil.configure({
  customGeoTypes: {
    [ROUNDED_RECT]: {
      snapType: "polygon",
      icon: "geo-rectangle",
      getPath: (w, h) => {
        const r = Math.min(16, w / 4, h / 4);
        return new PathBuilder()
          .moveTo(r, 0)
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
});

export const AiwbFrameShapeUtil = FrameShapeUtil.configure({ showColors: true });
