// The effects of a back on the phone (AD-71): the plan stack.ts makes (`planPopTo`) applied to the stores. A back never sets the
// stack itself: it sets Home's place, closes the drawer, sets the selection and takes the pushed screens away; the stack follows.
import { getState, setState } from "@aiwb/core/state/store.ts";

import { awayNow, pickPoint } from "../board/refs.ts";
import { getHomePlace, setHomePlace } from "./homeplace.ts";
import { withLastGroups } from "./phone/lastgroups.ts";
import { select } from "./nav.ts";
import { popScreen, pushedEntries } from "./screens.ts";
import { backTarget, planPopTo, stackOf, type StackEntry } from "./stack.ts";

/** The stack now. */
export const entriesNow = (): StackEntry[] => stackOf(withLastGroups(getState(), getHomePlace()), getHomePlace(), pushedEntries());

/** Goes back to the screen `key` of the stack: everything above it goes. Nothing for a key that is not in the stack, or is the top. */
export function popTo(key: string): void {
  const plan = planPopTo(getState(), entriesNow(), key, getHomePlace());
  if (!plan) return;
  if (plan.place) setHomePlace(plan.place);
  if (plan.closeDrawer) setState({ subDrawer: null });
  if (plan.sel) select(plan.sel);
  if (plan.popPushed) popScreen(plan.popPushed);
}

/** A back from the screen on top: to the one under it. While the phone waits for a point on the board, the board is the screen on top and
 *  its back ends the wait, with the chat opened again and nothing added to it (board/refs.ts). */
export function goBack(): void {
  if (awayNow()) return pickPoint(null);
  const target = backTarget(entriesNow());
  if (target) popTo(target);
}
