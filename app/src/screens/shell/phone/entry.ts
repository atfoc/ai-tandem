// The key of the stack entry a phone route draws (plans/ux-improvements/f2-design.md §6): PhoneStack wraps every route's component
// in it, so a part inside the route (the back, a bar) knows which entry it belongs to, even while another lies over it.
import { createContext, useContext } from "react";

export const EntryKeyContext = createContext<string | null>(null);

/** The key of the entry this part's route draws; null outside the phone's stack. */
export const useEntryKey = (): string | null => useContext(EntryKeyContext);
