import { AppState } from "react-native";

export const isForeground = () => AppState.currentState == null || AppState.currentState === "active";

export function watchForeground(change: () => void): () => void {
  const subscription = AppState.addEventListener("change", change);
  return () => subscription.remove();
}
