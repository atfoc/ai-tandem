// The small glyphs of the images screens: the close cross and the two steps (the old page's ImageThumb.tsx, ImageLarge.tsx).
import Svg, { Path } from "react-native-svg";

export const CloseGlyph = ({ size = 12, color }: { size?: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round"><Path d="M2 2l8 8M10 2l-8 8" /></Svg>
);

export const ArrowGlyph = ({ back, color, size = 14 }: { back?: boolean; color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d={back ? "M9 2L4 7l5 5" : "M5 2l5 5-5 5"} /></Svg>
);
