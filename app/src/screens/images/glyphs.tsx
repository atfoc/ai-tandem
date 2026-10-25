// The small glyphs of the images screens: the close cross and the two steps (the old page's ImageThumb.tsx, ImageLarge.tsx), and the phone viewer's three actions.
import Svg, { Path } from "react-native-svg";

export const CloseGlyph = ({ size = 12, color }: { size?: number; color: string }) => (
  <Svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round"><Path d="M2 2l8 8M10 2l-8 8" /></Svg>
);

export const ArrowGlyph = ({ back, color, size = 14 }: { back?: boolean; color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 14 14" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d={back ? "M9 2L4 7l5 5" : "M5 2l5 5-5 5"} /></Svg>
);

// The viewer's bottom row on the phone (ImageViewer.tsx): an arrow out of a tray, an arrow into one, and a speech bubble.
export const ShareGlyph = ({ color, size = 24 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d="M12 15V3M7.5 7.5L12 3l4.5 4.5M5 12v7h14v-7" /></Svg>
);

export const SaveGlyph = ({ color, size = 24 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d="M12 3v12M7.5 10.5L12 15l4.5-4.5M5 19h14" /></Svg>
);

export const AskGlyph = ({ color, size = 24 }: { color: string; size?: number }) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><Path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v6a2.5 2.5 0 0 1-2.5 2.5H11l-4 3.5V16h-.5A2.5 2.5 0 0 1 4 13.5z" /></Svg>
);
