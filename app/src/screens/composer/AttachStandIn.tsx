// The attach button until K4 draws its own (parts.tsx `AttachButton`): the toolbar's geometry is the final one (a 26-point icon button that
// never leaves the row), and the button takes no press yet, as one that has nothing to add does (`off`), so nothing is promised that the
// app cannot do. K4 (screens/composerimages) replaces this part when it is imported; the AttachIcon is shared with it.
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { IconButton } from "../../ui/IconButton.tsx";
import { tid } from "../../ui/tid.ts";
import { useMeasuring } from "./measure.tsx";
import type { AttachButtonProps } from "./parts.tsx";

export const AttachIcon = ({ color }: { color?: string }) => (
  <Svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
    <Rect x={2} y={2.75} width={12} height={10.5} rx={2} />
    <Circle cx={5.75} cy={6.25} r={1.1} />
    <Path d="m2.5 11.5 3.25-3 2.5 2.25 2-1.75 3.25 3" />
  </Svg>
);

export function AttachStandIn({ off, onPress }: AttachButtonProps) {
  const measuring = useMeasuring();
  return (
    <IconButton {...(measuring ? {} : tid("attach-btn"))} title={off || "Add images"} disabled keepFocus onPress={onPress}>
      {(colour) => <AttachIcon color={colour} />}
    </IconButton>
  );
}
