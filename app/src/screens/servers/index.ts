// The Servers dialog (S3): registers itself in the shell's `Overlays` slot. `ServersButton` is the foot's button (S1 draws the foot);
// `openServers(form?)` opens the dialog, on a form to add or edit when one is given (the warnings of a chat and a board, S4/B4, and the
// phone's add-server flow, S12, call it).
//
// On the phone (ux-improvements package S2) the servers are pushed screens and sheets instead: `servers` (the list), `server` {id} (a
// server's detail, its one place), `server-cert` {id} (its certificate), and the hosts of the server's sheet, its edit form and the add
// flow, mounted once in `Overlays`. The ways in are in open.ts; the dialog on the phone hands `openServers()` to them.
import { getState } from "@aiwb/core/state/store.ts";

import { setAddServer, setServerSheet } from "../home/serverseam.ts";
import { registerScreen } from "../shell/screens.ts";
import { setSlot } from "../shell/slots.tsx";
import { CertScreen } from "./CertChanged.tsx";
import { ServerDetail, ServerEditButton } from "./ServerDetail.tsx";
import { PhoneServerHosts } from "./Hosts.tsx";
import { ServersDialog } from "./ServersDialog.tsx";
import { ServersPlus, ServersScreen } from "./ServersScreen.tsx";
import { SCREEN, openAddServer, openServer, openServerCert, openServerEdit, openServerSheet, type ServerParams } from "./open.ts";

setSlot("Overlays", ServersDialog);

setSlot("Overlays", PhoneServerHosts);

const nameOf = (id: string): string => getState().servers.find((v) => v.id === id)?.name ?? "Server";

registerScreen<Record<string, never>>(SCREEN.servers, { kind: "place", title: () => "Servers", component: ServersScreen, right: ServersPlus });
registerScreen<ServerParams>(SCREEN.server, { kind: "place", title: (p) => nameOf(p.id), component: ServerDetail, right: ServerEditButton });
registerScreen<ServerParams>(SCREEN.cert, {
  kind: "place",
  title: (p) => (getState().servers.find((v) => v.id === p.id)?.state === "certificate_changed" ? "Compare" : "Certificate"),
  component: CertScreen,
});

// Home (H1) opens a chip's sheet and the first run's add flow through its seam: S2's own from here on (goal open question 8).
setServerSheet(openServerSheet);
setAddServer(openAddServer);

// The seam of the browser checks (version "uicheck" only): the ways into the phone's server screens and sheets.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbServers?: unknown }).__aiwbServers = { openServerSheet, openServerEdit, openAddServer, openServer, openServerCert };
}

export { ServersButton } from "./ServersButton.tsx";
export { openServers } from "@aiwb/core/state/serversdialog.ts";
export { ServerForm } from "./ServerForm.tsx";
export { ServersDialog, SERVERS_DIALOG_ID } from "./ServersDialog.tsx";
export { closeServerSheet, openAddServer, openServer, openServerCert, openServerEdit, openServerSheet, openServersList, type AddHow } from "./open.ts";
export { ServerFacts, type ServerFactsProps } from "./ServerFacts.tsx";
export { ServerSheet } from "./ServerSheet.tsx";
