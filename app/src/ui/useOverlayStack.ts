// An overlay's place on the stack (overlaystack.ts) while it is open, and the guarded close: only the overlay on top
// answers a request to close.
import { useCallback, useEffect, useRef } from "react";

import { isTopOverlay, pushOverlay } from "./overlaystack.ts";

export function useOverlayStack(open: boolean, onClose: () => void): { request(): void } {
  const token = useRef<symbol | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const mine = pushOverlay();
    token.current = mine.token;
    return () => { mine.remove(); token.current = null; };
  }, [open]);
  const request = useCallback(() => { if (token.current && isTopOverlay(token.current)) close.current(); }, []);
  return { request };
}
