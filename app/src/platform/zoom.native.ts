// The screen's scale on the phone's platforms: PixelRatio, which does not change while the app runs (see zoom.web.ts).
import { PixelRatio } from "react-native";

export const zoom = (): number => PixelRatio.get();

export function useZoom(): number {
  return PixelRatio.get();
}
