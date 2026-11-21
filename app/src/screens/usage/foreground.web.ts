export const isForeground = () => document.visibilityState !== "hidden";

export function watchForeground(change: () => void): () => void {
  document.addEventListener("visibilitychange", change);
  return () => document.removeEventListener("visibilitychange", change);
}
