// The phone composer's own icons (ux-improvements package C1): the "+" of the toolbar and the rows of the "+" sheet. Drawn as ui/icons.tsx draws its
// own (react-native-svg, a 16-point box, the colour given); kept here so the package adds nothing to the shared icon file.
import Svg, { Circle, Path, Rect } from "react-native-svg";

import type { IconProps } from "../../../ui/icons.tsx";

export const PlusIcon = ({ size = 18, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.6} strokeLinecap="round">
    <Path d="M8 2.5v11M2.5 8h11" />
  </Svg>
);

export const CameraIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round">
    <Path d="M2 5.2h2.6l1.2-1.7h4.4l1.2 1.7H14v7.3H2z" />
    <Circle cx={8} cy={8.6} r={2.3} />
  </Svg>
);

export const PhotoIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round">
    <Rect x={2} y={3} width={12} height={10} rx={1.5} />
    <Circle cx={5.6} cy={6.4} r={1.1} />
    <Path d="M2.5 11.5l3.4-3.1 2.4 2.1 2-1.6 3.2 2.6" />
  </Svg>
);

export const FileIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round">
    <Path d="M2 4.5h4.2l1.3 1.4H14v6.6H2z" />
  </Svg>
);

export const PromptIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round">
    <Path d="M2.5 5h7M2.5 8h5M2.5 11h7M11.5 6.5v5M9 9h5" />
  </Svg>
);

export const SelectionIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeDasharray="2 1.6">
    <Rect x={2.5} y={2.5} width={11} height={11} rx={1} />
  </Svg>
);

export const PointIcon = ({ size = 20, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round">
    <Circle cx={8} cy={8} r={3.6} />
    <Path d="M8 1.5v3M8 11.5v3M1.5 8h3M11.5 8h3" />
  </Svg>
);

export const TrashIcon = ({ size = 18, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
    <Path d="M2.5 4.2h11M6.2 4.2V2.6h3.6v1.6M3.8 4.2l.7 9.3h7l.7-9.3M6.6 6.6v4.6M9.4 6.6v4.6" />
  </Svg>
);

export const CloseIcon = ({ size = 12, color }: IconProps) => (
  <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round">
    <Path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
  </Svg>
);
