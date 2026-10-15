// The page is going away (the composer saves its draft at once, told to outlive the page): `pagehide`, as the old composer listened for it
// (the old page's Composer.tsx). Answers the function that removes the listener.
export function onLeaving(cb: () => void): () => void {
  window.addEventListener("pagehide", cb);
  return () => window.removeEventListener("pagehide", cb);
}
