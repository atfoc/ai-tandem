// Registers the window's shortcuts (shortcuts.ts) with the keys port, once.
import { useEffect } from "react";

import { onKey } from "../../platform/keys";
import { keyPlatform } from "./keyplatform.ts";
import { newChat, setSideHidden } from "./nav.ts";
import { shortcutHandler } from "./shortcuts.ts";

const handler = shortcutHandler({ platform: keyPlatform, newChat: (where) => void newChat(where), setSideHidden: (hidden) => setSideHidden(hidden) });

export function useShortcuts(): void {
  useEffect(() => onKey(handler), []);
}
