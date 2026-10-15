// On web the layer is an overlay's place on the stack and its Esc (useOverlayClose.web.ts): taken on keydown in the capture phase, only
// while it is on top, and what is under it (the subagent drawer, the composer's Esc that stops the agent) does not also see the key.
import { useOverlayClose } from "./useOverlayClose.web.ts";

export function useEscLayer(open: boolean, onEsc: () => void): void {
  useOverlayClose(open, onEsc);
}
