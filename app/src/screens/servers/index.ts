// The Servers dialog (S3): registers itself in the shell's `Overlays` slot. `ServersButton` is the foot's button (S1 draws the foot);
// `openServers(form?)` opens the dialog, on a form to add or edit when one is given (the warnings of a chat and a board, S4/B4, and the
// phone's add-server flow, S12, call it).
import { setSlot } from "../shell/slots.tsx";
import { ServersDialog } from "./ServersDialog.tsx";

setSlot("Overlays", ServersDialog);

export { ServersButton } from "./ServersButton.tsx";
export { openServers } from "@aiwb/core/state/serversdialog.ts";
export { ServerForm } from "./ServerForm.tsx";
export { ServersDialog, SERVERS_DIALOG_ID } from "./ServersDialog.tsx";
