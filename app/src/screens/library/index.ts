// The prompt library's screens (package S11): the library popup (the sidebar's button opens it: `libraryDialog` of the store) and the insert popup (⌘P in a composer's text box
// and its Insert button: core's `openInsertPopup`). Both are components with no props that show themselves from the store, registered in the shell's `Overlays` slot.
import { setSlot } from "../shell/slots.tsx";
import { LibraryPopups } from "./LibraryPopups.tsx";

setSlot("Overlays", LibraryPopups);

export { LibraryPopups } from "./LibraryPopups.tsx";
export { INSERT_POPUP_ID } from "./InsertPopup.tsx";
export { LIBRARY_DIALOG_ID } from "./LibraryDialog.tsx";
export { openInsert, openLibrary, plugInsert } from "./open.ts";
