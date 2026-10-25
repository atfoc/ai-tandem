// The seam of the browser checks (version "uicheck" only, as shell/phone/seam.ts's `__aiwbStack`): the library's phone sheets on
// `window.__aiwbLibrary`, so a check opens one on what it names without walking the screens. No other build has any of it.
import { closeAllSheets, libSheets, openEditor, openGroupForm, openMove } from "./sheets.ts";

if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") {
  (window as unknown as { __aiwbLibrary?: unknown }).__aiwbLibrary = { openEditor, openMove, openGroupForm, closeAllSheets, sheets: libSheets };
}
