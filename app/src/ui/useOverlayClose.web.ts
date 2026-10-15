// On web Esc closes the overlay on top. It is taken on keydown in the capture phase, as today's menus and dialogs take
// it (preventDefault and stopPropagation): what is under the overlay does not also see it. react-native-web's own Esc
// (a keyup, to the Modal's onRequestClose) is not used, so the overlay closes once.
import { useEffect } from "react";

import { useOverlayStack } from "./useOverlayStack.ts";

export function useOverlayClose(open: boolean, onClose: () => void): (() => void) | undefined {
  const { request } = useOverlayStack(open, onClose);
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      request();
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [open, request]);
  return undefined;
}
