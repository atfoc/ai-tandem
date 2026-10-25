// Which board's Chats sheet is open (package B1, b1-design.md §4): the board's only chooser of a chat. The bar's Chats button and V1's
// voice card ("To:") open it; ChatsSheet.tsx draws it. No React Native here, so Node loads it.
import { useSyncExternalStore } from "react";

let open: string | null = null;
const listeners = new Set<() => void>();
const set = (v: string | null) => { if (open === v) return; open = v; for (const l of [...listeners]) l(); };

/** Opens the Chats sheet of `board`. */
export function openChatsSheet(board: string): void { set(board); }

export function closeChatsSheet(): void { set(null); }

/** The board whose Chats sheet is open, or null. */
export const chatsSheetBoard = (): string | null => open;

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export const useChatsSheet = (): string | null => useSyncExternalStore(subscribe, chatsSheetBoard, chatsSheetBoard);
