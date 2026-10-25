// Both popups, each drawn while it is open, and the plug of the insert popup (the old page's Library.tsx `LibraryPopups`, `useInsertPopup`). On the phone also the sheets
// of the library's pushed screens (package S4).
import { useEffect } from "react";

import { useStore } from "../../state/useStore.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { InsertPopup } from "./InsertPopup.tsx";
import { LibraryDialog } from "./LibraryDialog.tsx";
import { plugInsert } from "./open.ts";
import { LibrarySheets } from "./phone/LibrarySheets.tsx";

export function LibraryPopups() {
  const target = useStore((s) => s.insertPopup);
  const phone = usePhone();
  useEffect(() => plugInsert(), []); // ⌘P in a composer's text box, and a composer's Insert button
  return <>{<LibraryDialog />}{target ? <InsertPopup key="insert" target={target} /> : null}{phone ? <LibrarySheets /> : null}</>;
}
