// A haptic on the web: nothing (a browser has no haptic engine worth calling; the page does not vibrate).
import type { Haptic } from "./haptics.types.ts";

export type { Haptic } from "./haptics.types.ts";

export function haptic(_kind: Haptic): void {}
