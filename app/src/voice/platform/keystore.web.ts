// The key in the web build: in the desktop window the main process holds it and the page can only ask (`window.aiwbVoice.key`, no
// `get`: the key never enters the page, VC-3); in a browser (the checks) it is a variable in memory, gone on reload, in no storage.
import type { Keystore } from "../ports.ts";
import { cleanKey, createKeystore, memoryVault } from "./keystore.core.ts";
import type { VoiceWindow } from "./bridge.types.ts";

/** The store of a window: main's when the window has the bridge, else one in memory. */
export function webKeystore(win: VoiceWindow): Keystore {
  const bridge = win.aiwbVoice;
  if (!bridge) return createKeystore(memoryVault());
  return {
    has: () => bridge.key.has(),
    set: async (key) => { await bridge.key.set(cleanKey(key)); },
    clear: () => bridge.key.clear(),
  };
}
