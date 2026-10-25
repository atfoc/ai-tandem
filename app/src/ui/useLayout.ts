// The layout (AD-72) of the window now, on every target; it follows a resize or a turn of the device. layoutOfWindow is
// breakpoints.ts.
import { Dimensions, Platform, useWindowDimensions } from "react-native";

import { layoutOfWindow, type Layout } from "./breakpoints.ts";

const native = (): boolean => Platform.OS !== "web";

export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  return layoutOfWindow(width, height, native());
}

/** The layout of the window now, for code that is not a component (it does not follow a resize by itself). */
export function windowLayout(): Layout {
  const { width, height } = Dimensions.get("window");
  return layoutOfWindow(width, height, native());
}

/** Whether the window has the phone layout (goal: "phone layout"). On a phone that holds in landscape too (decision D4). The parts
 *  that change shape on the phone ask this; the wide layouts keep their shape (ux-improvements goal 4.2). */
export function usePhone(): boolean {
  return useLayout() === "phone";
}
