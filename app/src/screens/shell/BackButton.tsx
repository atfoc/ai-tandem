// The phone's back (AD-71): the BackControl for the screen of its route (`nav-back`). It goes back to the screen under it (goback.ts) and
// never sets the stack itself. It stands in the bar of a screen of the stack: the board's bar, the chat's own header (S8: one bar for a
// chat, with its title and controls), the drawer's bar. Holding it opens the stack sheet.
import { useRef, useState } from "react";

import { haptic } from "../../platform/haptics";
import { BackControl } from "../../ui/BackControl.tsx";
import { goBack, popTo } from "./goback.ts";
import { entryIndex, navBackOf, type NavBackPlan } from "./navback.ts";
import { useEntryKey } from "./phone/entry.ts";
import { StackSheet } from "./StackSheet.tsx";
import { useStack } from "./useShellView.ts";

export { goBack };

/** The control that goes back (`nav-back`) from the screen of its route, or from the top one outside a route. Nothing on the bottom screen.
 *  On a place screen it names the screen under it; a press goes back there, a hold lists every screen under this one. */
export function NavBack() {
  const entries = useStack();
  const key = useEntryKey();
  const [sheet, setSheet] = useState(false);
  // A route whose entry the stack no longer holds is leaving: it keeps the back it had, not the top's.
  const live = key === null || entries.some((e) => e.key === key);
  const last = useRef<NavBackPlan | null>(null);
  if (live) last.current = navBackOf(entries, key);
  const plan = last.current;
  const own = entries[entryIndex(entries, key)];
  if (!plan || !own) return null;
  const press = plan.press;
  return (
    <>
      <BackControl label={plan.label} onPress={() => (press.kind === "back" ? goBack() : popTo(press.key))}
        onHold={live ? () => { haptic("select"); setSheet(true); } : undefined} />
      {sheet && live ? <StackSheet open onClose={() => setSheet(false)} entries={entries} own={own} /> : null}
    </>
  );
}

/** The back control under its old name, which the routes and the bars import. */
export const BackButton = NavBack;
