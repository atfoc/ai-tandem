// The phone's side of AD-76, apart from react-native so that a test can drive it with a fake AppState: when the app goes to
// the background the sends still waiting for their chat's view end and every board is written (a drawing is never left in a
// process the system may stop).
import type { AppStatePort } from "./nativetransport.ts";

export type Lifecycle = {
  flushAll(): Promise<void>;
  hasPendingSaves(): boolean;
  endSent(): void;
};

/** Listens to the app's state; answers the function that stops. */
export function installBackgroundFlush(l: Lifecycle, appState: AppStatePort): () => void {
  const sub = appState.addEventListener("change", (s) => {
    if (s === "background") { l.endSent(); void l.flushAll(); }
  });
  return () => sub.remove();
}
