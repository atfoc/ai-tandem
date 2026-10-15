// The `Modal` the overlays (Popover, Dialog, Sheet) are drawn in. On native it is React Native's own; modal.web.tsx is the web's, with the overlays' own
// focus rule instead of react-native-web's (read its first comment).
import { Modal as NativeModal } from "react-native";

import type { OverlayModalProps } from "./modal.types.ts";

export function Modal({ returnTo: _returnTo, ...rest }: OverlayModalProps) {
  return <NativeModal {...rest} />;
}
