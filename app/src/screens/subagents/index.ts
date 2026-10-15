// Subagents (package S7): their rows in the thread (`SubagentRow`, `SubResultRow`: the chat view's parts), the drawer (the shell's
// `SubagentDrawer` slot: beside the page on the wide layouts, the pushed screen of the phone's stack) and the Subagents chip of the composer's
// toolbar (`SubagentsChip`: the composer's part). Imported by screens/register.ts.
import { setChatPart } from "../chat/parts.tsx";
import { setComposerPart } from "../composer/parts.tsx";
import { setSlot } from "../shell/slots.tsx";
import { SubagentsChip } from "./Chip.tsx";
import { SubagentDrawer } from "./Drawer.tsx";
import { SubagentRow, SubResultRow } from "./Row.tsx";

setChatPart("SubagentRow", SubagentRow);
setChatPart("SubResultRow", SubResultRow);
setComposerPart("SubagentsChip", SubagentsChip);
setSlot("SubagentDrawer", SubagentDrawer);

export { SubagentDrawer } from "./Drawer.tsx";
export { SubagentsChip } from "./Chip.tsx";
export { SubagentRow, SubResultRow } from "./Row.tsx";
export { SubMark, SubName, SubStats } from "./Parts.tsx";
export { closeSub, openSub, toggleSub, useSubNav, useSubThread } from "./hooks.ts";
