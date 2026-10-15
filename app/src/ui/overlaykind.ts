// Which form the overlay around a component has (AD-70): content that is drawn in a popover, a dialog or a sheet can
// ask (a Menu loses its frame in a sheet and gets rows a finger can hit).
import { createContext, useContext } from "react";

export type OverlayKind = "popover" | "dialog" | "sheet";

const OverlayKindContext = createContext<OverlayKind | null>(null);

export const OverlayKindProvider = OverlayKindContext.Provider;

/** The form of the overlay this is drawn in, or null outside any. */
export const useOverlayKind = (): OverlayKind | null => useContext(OverlayKindContext);
