// Which way a quote is taken on this window (AD-64, goal 4.2): by the platform's own selection and ⌘L, with the comment field floating at the
// passage; or in the Quote sheet that a long press on a message opens, with the comment field in a sheet too. The native app has no selection
// in the thread, so it always takes the sheet. The web build takes it on the phone layout (a finger and a small window; the browser's
// selection has no action to quote with there) and keeps the selection and the float on the tablet and the desktop layouts.
import { Platform } from "react-native";

import { useLayout } from "../../ui/useLayout.ts";

export function useSheetPath(): boolean {
  const layout = useLayout();
  return Platform.OS !== "web" || layout === "phone";
}
