// The layout (AD-72) of the window now, on every target; it follows a resize. layoutOf is breakpoints.ts.
import { useWindowDimensions } from "react-native";

import { layoutOf, type Layout } from "./breakpoints.ts";

export function useLayout(): Layout {
  return layoutOf(useWindowDimensions().width);
}
