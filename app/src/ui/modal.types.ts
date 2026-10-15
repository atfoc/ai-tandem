import type { RefObject } from "react";
import type { ModalProps } from "react-native";

export type OverlayModalProps = ModalProps & {
  /** Web: the control the overlay hangs from, which the focus goes back to if the one that had it when the overlay opened has been drawn anew meanwhile. */
  returnTo?: RefObject<unknown>;
};
