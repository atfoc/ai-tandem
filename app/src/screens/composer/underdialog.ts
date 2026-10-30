// Whether a dialog or a popup is open, for the composer's keys: ⌘Enter sends nothing under one (the library's edit form saves with it), and
// ⌘E opens no model and effort menu (Toolbar.tsx).
// `dialogOpen` is the same, of a state (for useStore): the native box takes no hardware Tab under one (Composer.tsx gives it no `editing` then).
import { getState, type State } from "@aiwb/core/state/store.ts";

export const dialogOpen = (s: State) => !!(s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav);

export const underDialog = () => dialogOpen(getState());
