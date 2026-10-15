// What the phone's app does when it goes to the background (AD-76, goal 4.5): a drawing is saved before the screen goes away.
import { AppState } from "react-native";

import { installBackgroundFlush, type Lifecycle } from "./backgroundflush.ts";

export type { Lifecycle };

/** Installs the hook; answers the function that removes it. */
export function installLifecycle(l: Lifecycle): () => void {
  return installBackgroundFlush(l, AppState);
}

/** Nothing waits for the root on the phone. */
export function markReady(): void {}
