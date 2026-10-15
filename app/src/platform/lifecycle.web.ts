// What the web build does when the page goes away or is shown (AD-76; the old page's main.tsx): the boards are written before the
// tab hides or the page unloads, the window of the desktop app asks `window.aiwbFlush` before it closes or reloads, and
// `window.aiwbReady` tells it the page drew (its blank-page check, AD-41).
export type Lifecycle = {
  /** Writes every board; answers when written. */
  flushAll(): Promise<void>;
  hasPendingSaves(): boolean;
  /** Ends the sends still waiting for their chat's view (core actions `endSent`). */
  endSent(): void;
};

declare global {
  interface Window {
    aiwbFlush?: () => Promise<boolean>;
    aiwbReady?: boolean;
  }
}

/** Installs the hooks; answers the function that removes them. `flush` is what `window.aiwbFlush` answers: true once every board is written. */
export function installLifecycle(l: Lifecycle): () => void {
  const flush = () => l.flushAll().then(() => !l.hasPendingSaves());
  window.aiwbFlush = flush;
  // Sent moves still waiting for their chat's view end before the composer's own pagehide listener saves the box.
  const pagehide = () => { l.endSent(); void l.flushAll(); };
  const hidden = () => { if (document.visibilityState === "hidden") void l.flushAll(); };
  const unload = (e: BeforeUnloadEvent) => { if (l.hasPendingSaves()) { void l.flushAll(); e.preventDefault(); } };
  window.addEventListener("pagehide", pagehide);
  document.addEventListener("visibilitychange", hidden);
  window.addEventListener("beforeunload", unload);
  return () => {
    window.removeEventListener("pagehide", pagehide);
    document.removeEventListener("visibilitychange", hidden);
    window.removeEventListener("beforeunload", unload);
    delete window.aiwbFlush;
  };
}

/** The root rendered: the window's check that the page is alive. */
export function markReady(): void {
  window.aiwbReady = true;
}
