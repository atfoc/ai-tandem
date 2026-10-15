// Where the board puts a reference: the selection on the board, or a point clicked on it (⌘L and ⌘⇧L, the old page's Composer.tsx
// `insertRef` and `pickPoint` on the old page). The composer of a board chat registers what puts a reference into its box
// (K3) while it can take one; the board's pick layer calls `finishPick`. No React here, so Node loads it.
//
// The phone's wait for a point (AD-52, AD-71): a board's chat is a screen over its board, so the layer cannot be seen from the chat.
// "Point at" there (`startPick` with `away`) goes back to the board with the wait kept (`picking` in the store, `away` here), the layer
// and its hint show there, and a tap, Cancel, Esc and the stack's back all end the wait (`pickPoint(null)`) and open the chat again. The
// composer goes away and comes back on that way, so a reference made while the chat's box is not there is held (`held`) and put into
// the box when it is there again, at the caret it had when the wait began.
import type { Ref } from "@aiwb/core/logic/refs.ts";
import type { Sel } from "@aiwb/core/logic/sel.ts";
import { getState, setState } from "@aiwb/core/state/store.ts";

import { boardApp } from "../shell/boardside.ts";

/** Said by the composer when ⌘L finds nothing selected on the board. */
export const SELECT_FIRST = "Select something on the board first";

/** A place in the value of a box (the text with each chip as its tag). */
export type Place = { start: number; end: number };

type Slot = { put(r: Ref, at?: Place | null): void; caret?(): Place | null };
const inserters = new Map<string, Slot>();

/** The composer of `chat` registers what puts a reference into its box (at the caret, or in place of `at`) and where its caret is;
 *  answers the function that takes it away. */
export function registerInserter(chat: string, put: Slot["put"], caret?: Slot["caret"]): () => void {
  const slot: Slot = { put, caret };
  inserters.set(chat, slot);
  return () => { if (inserters.get(chat) === slot) inserters.delete(chat); };
}

/** Puts a reference into a chat's composer; false when it has none open that takes one. */
export function insertRef(chat: string, r: Ref, at?: Place | null): boolean {
  const slot = inserters.get(chat);
  if (!slot) return false;
  slot.put(r, at);
  return true;
}

// ---------------------------------------------------------------- the references a box that is not there is waiting for

const held = new Map<string, { ref: Ref; at: Place | null }[]>();

/** A reference for a chat whose box is not there: kept until the box is, in the order they were made. */
export function holdRef(chat: string, ref: Ref, at: Place | null = null): void {
  held.set(chat, [...(held.get(chat) ?? []), { ref, at }]);
}

/** What was held for a chat, which the box now takes (nothing is held after). */
export function takeHeld(chat: string): { ref: Ref; at: Place | null }[] {
  const h = held.get(chat) ?? [];
  held.delete(chat);
  return h;
}

// ---------------------------------------------------------------- the wait for a point

/** The wait that took the user to the board (the phone): the chat that waits, its board, and the caret its box had. */
let away: { chat: string; board: string; caret: Place | null } | null = null;

/** The phone's wait, while it lasts (the store's `picking` is its own: a wait that ended some other way leaves nothing here). */
export function awayNow(): { chat: string; board: string; caret: Place | null } | null {
  if (away && getState().picking !== away.chat) away = null;
  return away;
}

/** How a screen is opened: the app sets shell/nav.ts `select` (it loads what a chat shows and gives its box the focus); with none, the
 *  store's selection is set. */
let go: (sel: Sel) => void = (sel) => setState({ sel });
export function setPickGo(f: (sel: Sel) => void): void { go = f; }

/** Starts (or, when the chat is the one that waits, ends) the wait for a point on the chat's board. `away`: the chat is a screen over
 *  its board (the phone), which goes back so that the board is seen. The caret the box has is kept for the reference. */
export function startPick(chat: string, away_: boolean): void {
  const s = getState();
  if (s.picking === chat) return pickPoint(null);
  const board = s.chats[chat]?.board;
  setState({ picking: chat });
  if (!away_ || !board) return;
  away = { chat, board, caret: inserters.get(chat)?.caret?.() ?? null };
  go({ board, chat: null });
}

/** Waits for a point, or stops waiting (null). The phone's wait ends with the chat opened again. */
export function pickPoint(chat: string | null): void {
  const a = awayNow();
  setState({ picking: chat });
  if (chat || !a) return;
  away = null;
  go({ board: a.board, chat: a.chat });
}

/** The point is made: the reference goes into the chat's box (or is held for it), and the wait ends. */
export function finishPick(chat: string, r: Ref): void {
  const a = awayNow();
  const at = a?.chat === chat ? a.caret : null;
  if (!insertRef(chat, r, at)) holdRef(chat, r, at);
  pickPoint(null);
}

/** The composer of `chat` went away: a wait for a point ends with it, but not the phone's, whose composer goes away to show the board. */
export function composerGone(chat: string): void {
  if (getState().picking === chat && awayNow()?.chat !== chat) pickPoint(null);
}

/** For a test: nothing waits, nothing is held, no composer is registered. */
export function resetPick(): void {
  away = null;
  held.clear();
  inserters.clear();
  go = (sel) => setState({ sel });
}

/** ⌘L with no text selected in a message: the selection on the chat's board goes into its message. The sentence to say when it
 *  could not ("" when it did). */
export function addSelection(chat: string, board: string): string {
  const r = boardApp.selectionRefOn(board);
  if (!r) return SELECT_FIRST;
  insertRef(chat, r);
  return "";
}
