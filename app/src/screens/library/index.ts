// The prompt library's screens (package S11): the library popup (the sidebar's button opens it: `libraryDialog` of the store) and the insert popup (⌘P in a composer's text box
// and its Insert button: core's `openInsertPopup`). Both are components with no props that show themselves from the store, registered in the shell's `Overlays` slot.
// On the phone (package S4) the library is a stack of pushed screens, `library` (from Settings' row) and `library-group` (a group; a nested group is one more push), with
// their sheets (phone/LibrarySheets.tsx, mounted by LibraryPopups); the insert popup is the "Prompt" sheet.
import { pushScreen, registerScreen } from "../shell/screens.ts";
import { setSlot } from "../shell/slots.tsx";
import { LibraryPopups } from "./LibraryPopups.tsx";
import { GroupMore, GroupScreen, groupTitle, type GroupParams } from "./phone/GroupScreen.tsx";
import { LibraryPlus, LibraryScreen } from "./phone/LibraryScreen.tsx";
import "./phone/seam.ts";

setSlot("Overlays", LibraryPopups);
registerScreen<Record<string, never>>("library", { kind: "place", title: () => "Prompt library", component: LibraryScreen, right: LibraryPlus });
registerScreen<GroupParams>("library-group", { kind: "place", title: groupTitle, component: GroupScreen, right: GroupMore });

export { LibraryPopups } from "./LibraryPopups.tsx";
export { INSERT_POPUP_ID } from "./InsertPopup.tsx";
export { LIBRARY_DIALOG_ID } from "./LibraryDialog.tsx";
export { openInsert, openLibrary, plugInsert } from "./open.ts";
export { S4_TID } from "./phone/ids.ts";
/** The phone's Library screen, pushed. */
export const openLibraryScreen = (): string => pushScreen("library", {});
/** A group's screen, pushed over the screen of the group it is in. */
export const openGroupScreen = (p: GroupParams): string => pushScreen("library-group", p);
