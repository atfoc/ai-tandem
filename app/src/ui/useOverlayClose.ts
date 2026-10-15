// What closes the overlay on top: the back button of Android (the Modal's `onRequestClose`). Only the overlay on top
// answers (overlaystack.ts). Returns the `onRequestClose` to give the Modal. useOverlayClose.web.ts is the web's: Esc.
import { useOverlayStack } from "./useOverlayStack.ts";

export function useOverlayClose(open: boolean, onClose: () => void): (() => void) | undefined {
  return useOverlayStack(open, onClose).request;
}
