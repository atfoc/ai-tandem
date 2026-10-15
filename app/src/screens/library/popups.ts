// How the two prompt-library popups are opened (the old page's Library.tsx openLibrary and openInsert), apart from the keys, the platform and React, which open.ts has.
import type { InsertTarget } from "@aiwb/core/logic/insert.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

/** Opens the library popup. back: the text box whose insert popup it is opened from, which has its focus and its caret again when the popup closes. */
export function openLibrary(back?: InsertTarget): void { setState({ libraryDialog: back ? { back } : {} }); }

/** Opens the insert popup for a text box. Under a dialog nothing opens, and the box is as it was. */
export function openInsert(target: InsertTarget): void {
  const s = getState();
  if (s.confirm || s.serversDialog || s.libraryDialog) return target.cancel();
  if (s.insertPopup && s.insertPopup !== target) s.insertPopup.cancel();
  setState({ insertPopup: target });
}
