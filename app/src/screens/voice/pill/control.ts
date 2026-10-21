// What the pill gives the voice engine when a turn starts (VC-28, VC-29): where the turn goes, and how it is sent. The engine imports no
// screen, so the shell's `newChat` and the composer's `sendMessage` are handed to it here.
import { lastChat, getState } from "@aiwb/core/state/store.ts";

import { voice } from "../../../voice/index.ts";
import { sendMessage } from "../../composer/send.ts";
import { newChat } from "../../shell/nav.ts";
import { pickTarget } from "./logic.ts";
import { selectionSent, selectionTag } from "./selection.ts";

/** The id the pill gives the engine and the problem popover for a board: the popover hangs from the orb. */
export const pillAnchor = (board: string): string => `pill:${board}`;

/** The chat the pill talks to now: the chat used last, else the newest the sidebar lists; null when the board has none. */
export function targetNow(board: string): string | null {
  const s = getState();
  return pickTarget(s.chats, board, lastChat.get(board), s.showArchived);
}

/** The chat a turn goes to, at the moment it is sent: the target, or a new chat of the board when it has none. The new chat is the same
 *  action as the sidebar's + (`newChat`), made without opening the chat view (goal 3.6). Null when the chat could not be made (the refusal
 *  was reported where `newChat` makes it). */
export async function targetOrNew(board: string): Promise<string | null> {
  return targetNow(board) ?? (await newChat({ board }, { open: false }))?.id ?? null;
}

/** The words of a turn as the chat gets them: the selection chip's tag in front of them, as ⌘L puts it in a typed message (VC-28). */
export function turnText(board: string, words: string): string {
  const text = selectionTag(board) + words;
  selectionSent();
  return text;
}

/** The orb was pressed with no session: listen, for a chat of this board. */
export function startPill(board: string): Promise<void> {
  return voice.startPill({
    board,
    anchor: pillAnchor(board),
    target: () => targetOrNew(board),
    send: (chat, words) => sendMessage(chat, turnText(board, words)),
  });
}

/** + New chat: a fresh chat of the board, the target at once and shown under the board's row; the chat view stays as it is. */
export async function newPillChat(board: string): Promise<void> {
  await newChat({ board }, { open: false });
}

/** A pick in the chip: the chat becomes the board's last, as opening it in the sidebar would make it. */
export function pickChat(board: string, chat: string): void {
  lastChat.set(board, chat);
}
