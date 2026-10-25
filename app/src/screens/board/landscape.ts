// Whether the phone's board screen is in landscape (package B1, b1-design.md §4 "Landscape"): a native phone held wider than tall.
// The bar and the bottom row then become floating controls in the corners (chunk 5), and the board view gets no phone chrome
// (`setPhoneChrome(null)`: Excalidraw's own footer). The web build at a phone viewport is never in landscape.
import { Platform, useWindowDimensions } from "react-native";

import { usePhone } from "../../ui/useLayout.ts";

/** Pure: the rule, for tests. */
export const isBoardLandscape = (o: { phone: boolean; native: boolean; width: number; height: number }): boolean =>
  o.phone && o.native && o.width > o.height;

export function useBoardLandscape(): boolean {
  const phone = usePhone();
  const { width, height } = useWindowDimensions();
  return isBoardLandscape({ phone, native: Platform.OS !== "web", width, height });
}
