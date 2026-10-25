// Whether a row that was just made may open in rename mode: the box is for the user to see, so not while the sidebar is hidden, and not on the
// phone while a screen lies over the list (a board made from the list opens its own screen: the stack is more than the list). A group made
// from the list does not change the stack, so its header opens in rename mode there. No React and no react-native here, so Node loads it.
import type { Layout } from "../../ui/breakpoints.ts";

export function mayRename(sideHidden: boolean, layout: Layout, stack: readonly unknown[]): boolean {
  if (sideHidden) return false;
  return !(layout === "phone" && stack.length > 1);
}
