// `aiwb-keys` in JS, for the tests of the keys port (and nothing else): `press` is what the native side does when a shortcut
// is pressed. `listening()` is the number of listeners now, which the native side turns into taking or giving back the keys.
import type { AiwbKeysEvents, AiwbKeysModule, KeyEvent } from "./AiwbKeys.ts";

export function createFakeAiwbKeys(): { module: AiwbKeysModule; press(e: KeyEvent): void; listening(): number } {
  const listeners = new Set<AiwbKeysEvents["onKey"]>();
  return {
    module: {
      addListener: (_name, listener) => {
        listeners.add(listener);
        return { remove: () => { listeners.delete(listener); } };
      },
    },
    press: (e) => { for (const l of [...listeners]) l(e); },
    listening: () => listeners.size,
  };
}
