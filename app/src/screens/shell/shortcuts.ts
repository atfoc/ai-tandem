// The shortcuts of the window (AD-73; the old page's App.tsx): ⌘J hides and shows the board's chat panel, ⌘N makes a chat where the
// user is, ⌘B hides and shows the sidebar. They come through the keys port, whose handler gets the key (the KeyboardEvent on web,
// the object of aiwb-keys on a tablet's hardware keyboard). The handler is made over what it acts with, so a test can fake them.
// No React here and no import of nav.ts (it needs the platform's ports), so Node loads it.
import { isSideKey } from "@aiwb/core/logic/layout.ts";
import { isNewChatKey, newChatPlace } from "@aiwb/core/logic/newchatwhere.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";
import type { ChatPlace } from "@aiwb/core/api.ts";

import type { KeyLike } from "../../platform/keys.types.ts";

export type ShortcutActs = {
  /** navigator.platform on web: what makes the ⌘ keys (macOS, iPhone, iPad) from the Ctrl ones. */
  platform(): string;
  newChat(where: ChatPlace): void;
  setSideHidden(hidden: boolean): void;
};

/** Whether a dialog or a popup is open: ⌘N and ⌘B do nothing under one (the key is left alone, shown or hidden). */
const underDialog = () => {
  const s = getState();
  return !!(s.confirm || s.serversDialog || s.libraryDialog || s.insertPopup || s.treeNav);
};

export function shortcutHandler(acts: ShortcutActs): (e: KeyLike) => void {
  return (e) => {
    // ⌘J: hides the chat panel or shows it, from anywhere, also in a text box.
    if ((e.metaKey || e.ctrlKey) && e.code === "KeyJ") {
      e.preventDefault(); e.stopPropagation();
      setState({ panel: !getState().panel });
      return;
    }
    // ⌘N: a new chat where the user is, if that place offers one. Not under a dialog; a browser opens its window all the same.
    if (isNewChatKey(e, acts.platform())) {
      if (underDialog()) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      const s = getState();
      const where = newChatPlace({ sel: s.sel, chats: s.chats, boards: s.boards, groups: [...s.groups, ...Object.values(s.sections).flatMap((x) => x.groups)], reachable: (key) => reachable(s, key) });
      if (where) acts.newChat(where);
      return;
    }
    // ⌘B: hides the sidebar, or shows it. Not under a dialog, as ⌘N; neither the canvas nor a text box hears the key.
    if (isSideKey(e, acts.platform())) {
      if (underDialog()) return;
      e.preventDefault(); e.stopPropagation();
      if (e.repeat) return;
      acts.setSideHidden(!getState().sideHidden);
    }
  };
}
