// Where the composer's focus goes (the old page's Composer.tsx focusComposer): the open boxes by chat, and what the shell's `focusComposer`
// (nav.ts) does a moment after a chat is opened. No React and no react-native here.
import { getState } from "@aiwb/core/state/store.ts";

export type Box = { focus(atEnd?: boolean): void };

const boxes = new Map<string, Box>();

/** A composer's box is open for `chat`; answers the function that takes it away. */
export function registerBox(chat: string, box: Box): () => void {
  boxes.set(chat, box);
  return () => { if (boxes.get(chat) === box) boxes.delete(chat); };
}

/** Gives the focus to the text box of the chat on screen, a moment later. Not under a popup of the prompt library opened by then: what is
 *  typed there is its search's, and the box has the focus again when the popup closes. */
export function focusSelectedBox(delay = 30): void {
  setTimeout(() => {
    const s = getState();
    if (s.insertPopup || s.libraryDialog) return;
    const chat = s.sel.chat;
    if (chat) boxes.get(chat)?.focus();
  }, delay);
}
