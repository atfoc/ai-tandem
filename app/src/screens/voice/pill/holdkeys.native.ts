// Hold Space on a phone or a tablet: none. The keys port takes a hardware keyboard's shortcuts and never a typing key (AD-73), so the pill hears no Space.
import type { OnSpaceRelease, SpaceFocusNow } from "./holdkeys.types.ts";

export type { OnSpaceRelease, SpaceFocus, SpaceFocusNow } from "./holdkeys.types.ts";

export const spaceFocus: SpaceFocusNow = () => null;
export const onSpaceRelease: OnSpaceRelease = () => () => {};
