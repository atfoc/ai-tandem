// The box the board is drawn in, which hears the tap that puts a point while one is waited for (Overlays.tsx `PickLayer`).
import type { ReactNode } from "react";

import type { Spot } from "./taps.ts";

export type PickSurfaceProps = {
  /** A point is waited for: a tap in the box is told to `onTap`; with it off the box hears nothing. */
  on: boolean;
  /** A tap, where it was in the box. The board has had every pointer all the same: the board is in view mode meanwhile (logic/board side.ts), where a tap does nothing. */
  onTap(at: Spot): void;
  /** Where a mouse is in the box, null when it left (web: for the label that follows it). */
  onHover?(at: Spot | null): void;
  children: ReactNode;
};

/** What the layer marks as its own (its hint and Cancel): a press on it is not a press on the board. */
export const PICK_UI = "pickui";
