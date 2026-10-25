// Whether this app has a server of its own, and so a "This computer" section (goal 4.1). The web build runs in the desktop app or
// in the test host, which have one; a phone's and a tablet's native app lists remote servers only.
//
// A knob for the browser checks of a phone's Home (ux-h1, seeds `UXH1` of web/dev/mock-ui.js): a build whose version is "uicheck"
// answers false while the app's storage (the kv port: `localStorage` on the web) has `aiwb.uicheck.nolocal` = "1", as a phone's app does: this computer is then no entry of
// Home's chips or of the sidebar. A shipped build never reads it. The check sets the key before the page loads (the `ls` of
// `openApp`, or the `ls` field of a seeded state).
import { Platform } from "react-native";

import { safeGet } from "@aiwb/core/state/store.ts";

const NO_LOCAL = "aiwb.uicheck.nolocal";

export const hasThisComputer = (): boolean => {
  if (Platform.OS !== "web") return false;
  if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && safeGet(NO_LOCAL) === "1") return false; // (a storage that refuses reads as empty: this computer stays)
  return true;
};
