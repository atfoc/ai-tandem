// The React hook over the store of @aiwb/core: the store knows nothing of React (AD-2), each UI makes its own. Every screen of
// the app reads the store through this one (the old page's useStore.ts is the old page's).
import { useSyncExternalStore } from "react";

import { getState, subscribe, type State } from "@aiwb/core/state/store.ts";

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(getState()));
}
