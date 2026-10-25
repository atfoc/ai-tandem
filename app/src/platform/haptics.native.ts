// A haptic on a phone (expo-haptics: the system's own feedback). It never throws and never waits: a device without a haptic engine, or a
// call the system refuses, is a haptic that did not happen.
import * as Haptics from "expo-haptics";

import type { Haptic } from "./haptics.types.ts";

export type { Haptic } from "./haptics.types.ts";

export function haptic(kind: Haptic): void {
  try {
    const done = kind === "select" ? Haptics.selectionAsync()
      : kind === "impact" ? Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      : Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    done.catch(() => {});
  } catch { /* nothing to feel */ }
}
