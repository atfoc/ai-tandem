// Settings › Claude accounts (multiple-claude goal §1.1–§1.3, §1.6, §1.7): the phone's place screen `claude-accounts`, and the host in the
// shell's `Overlays` slot (the wide layouts' dialog, the phone's add/edit sheet, the requests of core's openAccounts).
import { openAccounts } from "@aiwb/core/state/aliases.ts";

import { registerScreen } from "../../shell/screens.ts";
import { setSlot } from "../../shell/slots.tsx";
import { ACCOUNTS_SPEC } from "./AccountsScreen.tsx";
import { AccountsHost } from "./AccountsHost.tsx";
import { ACCOUNTS_SCREEN } from "./ids.ts";

registerScreen(ACCOUNTS_SCREEN, ACCOUNTS_SPEC);
setSlot("Overlays", AccountsHost);

// The seam of the browser checks (version "uicheck" only): core's request to show the accounts, as the chat side makes it.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbAccounts?: unknown }).__aiwbAccounts = { openAccounts };
}

export { ACCOUNTS_TID, ACCOUNTS_SCREEN } from "./ids.ts";
export { openAccountsList } from "./open.ts";
