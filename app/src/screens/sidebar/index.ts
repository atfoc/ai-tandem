// The sidebar (package S1): registers itself in the shell's slot. Its actions and parts are exported for the drag and drop (S2) and
// for the screens that make or rename the same things.
import { setSlot } from "../shell/slots.tsx";
import { Sidebar } from "./Sidebar.tsx";

setSlot("Sidebar", Sidebar);

export { Sidebar } from "./Sidebar.tsx";
export { canTakeGroup, markDrop, moveGroup, moveTo, newGroup, renameChat, renameGroup } from "./actions.ts";
