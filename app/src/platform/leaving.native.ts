// The app is going away from the screen (the composer saves its draft at once, C-DR-04's touch half): it goes to the background, or is
// interrupted (a call, the app switcher). Answers the function that removes the listener.
import { AppState } from "react-native";

export function onLeaving(cb: () => void): () => void {
  const sub = AppState.addEventListener("change", (s) => { if (s === "background" || s === "inactive") cb(); });
  return () => sub.remove();
}
