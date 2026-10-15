// How the two prompt-library popups open (the old page's Library.tsx, the first part): the library popup from the sidebar's button or from the insert popup, the
// insert popup from a composer's text box (⌘P or the toolbar's Insert button, through core's `onInsertPopup`). No React here.
import { insertKeyName, isInsertKey, onInsertPopup } from "@aiwb/core/logic/insert.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { onKey } from "../../platform/keys";
import { keyPlatform } from "../shell/keyplatform.ts";
import { openInsert, openLibrary } from "./popups.ts";

export { openInsert, openLibrary };

/** The shortcut's name, for the popups' words ("⌘P in a message box inserts a prompt"). */
export const insertKey = (): string => insertKeyName(keyPlatform());

/** Plugs the insert popup in, for the life of the app: ⌘P in a composer's text box and a composer's Insert button open it. While it is open ⌘P is its
 *  own, wherever the focus is in it and however long the key is held: the page is not printed. Answers the function that takes it out again. */
export function plugInsert(): () => void {
  const off = onInsertPopup(openInsert);
  const offKey = onKey((e) => { if (getState().insertPopup && isInsertKey(e, keyPlatform())) { e.preventDefault(); e.stopPropagation(); } });
  return () => { off(); offKey(); };
}
