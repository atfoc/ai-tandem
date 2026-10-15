// A View that tells its width as it changes (the toolbar's row and its controls, AD-62), on the phone's platforms: onLayout, which the
// renderer delivers before the frame is drawn. See sized.web.tsx.
import { View, type ViewProps } from "react-native";

export type SizedProps = ViewProps & { onWidth(width: number): void };

export function Sized({ onWidth, onLayout, ...props }: SizedProps) {
  return <View {...props} onLayout={(e) => { onWidth(e.nativeEvent.layout.width); onLayout?.(e); }} />;
}
