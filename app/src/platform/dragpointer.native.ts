// On the native platforms the gesture handler reports every move and the release's place, so there is nothing to follow.
import type { DragPointer } from "./dragpointer.types.ts";

export type { DragPointer, Point } from "./dragpointer.types.ts";

export const dragPointer: DragPointer = { follow: () => () => {}, now: () => null, nextPress: () => () => {} };
