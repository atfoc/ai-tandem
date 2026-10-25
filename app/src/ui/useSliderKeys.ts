// The keys of a slider, on the web (small-improvements goal 3.4). Native has no keyboard to speak of (a screen reader adjusts through
// accessibilityActions), so this does nothing there. useSliderKeys.web.ts is the web's.
import type { RefCallback } from "react";

import type { KeyPress } from "./sliderlogic.ts";

export function useSliderKeys(_on: (press: KeyPress) => boolean): RefCallback<any> | undefined {
  return undefined;
}
