// The checks' seam to start the phone's two waits before the composer has its row (version "uicheck" only, as BoardCanvas's `__aiwbView`):
// `window.__aiwbPick`. No other build has it.
import { getState } from "@aiwb/core/state/store.ts";

import { pickPoint, startPick, startSelect } from "./refs.ts";

if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbPick?: unknown }).__aiwbPick = {
    startSelect,
    startPick: (chat: string) => startPick(chat, true),
    end: () => pickPoint(null),
    state: () => { const s = getState(); return { picking: s.picking, pickFor: s.pickFor }; },
  };
}
