// Whether a dialog or a popup is open, for the composer's keys: ⌘Enter sends nothing under one (the library's edit form saves with it), and
// ⌘E opens no model and effort menu (Toolbar.tsx).
import { getState } from "@aiwb/core/state/store.ts";

export const underDialog = () => {
  const s = getState();
  return !!(s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav);
};
