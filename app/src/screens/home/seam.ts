// The seam of the browser checks for Home (version "uicheck" only, as screens/shell/phone/seam.ts): `window.__aiwbHome` says where a thing sits
// (its server, its groups outermost first, its board) so a check can walk from Home to it by pressing rows, and which server Home shows.
// No other build has any of it.
import { getState } from "@aiwb/core/state/store.ts";

import { getHomePlace } from "../shell/homeplace.ts";
import { pathOf, type RowKind } from "./model.ts";
import { openRename, type RenameItem } from "./RenameSheet.tsx";

if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbHome?: unknown }).__aiwbHome = {
    placeOf: (kind: RowKind, key: string) => pathOf(getState(), kind, key),
    server: () => getHomePlace().server,
    rename: (kind: RenameItem["kind"], key: string) => openRename({ kind, key }),
  };
}
