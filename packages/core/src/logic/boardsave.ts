// A board of any server of the server list, this computer's included: what a failed save does to the edit,
// what shows in place of its canvas while that server is not connected or the board is gone there,
// and the texts of the banner and the notice. DOM-free.
import { serverOfKey } from "./keys.ts";

/** What a failed save does to the edit. drop: the server refused it for good (the scene was changed elsewhere, or
 *  another window holds the board). keep: it did not get there (no answer, a 503 of this computer's server for a board
 *  whose server is away, `server_unreachable`, or being taken again there, `not_held_there`; any other error); the
 *  next change or flush writes it again, and so does the `held` event that ends the re-take (board.ts granted).
 *  `not_held_there` is never a lost edit and never an error to show: it is "not yet". */
export type SaveFailure = "drop" | "keep";
export function saveFailure(_status: number | undefined, code: string | undefined): SaveFailure {
  return code === "stale" || code === "not_holder" ? "drop" : "keep";
}

/** Whether a failed save of a board says its server is away, which raises the banner: the app could not reach the server
 *  (503), or reached it and got no answer because the link broke meanwhile (504). */
export const saveOutage = (status: number | undefined): boolean => status === 503 || status === 504;

/** What a failed save of a board says in the banner when neither waiting for its server mends it (that
 *  is the outage's banner) nor the edit is dropped (that is the notice): the server's own sentence. A drawing the
 *  server will not take as it is (413 `too_large`: at most 128 MB), an answer that cannot be read (502 `bad_answer`),
 *  any other refusal with a sentence. "" for every other failure and for an answer with no sentence of the server's.
 *  The edit stays in the window as after any failed save, and is written again at the next change: without the
 *  sentence nothing would tell that it does not arrive. */
export const saveRefusal = (status: number | undefined, code: string | undefined, sentence: string, said = true): string =>
  (said && status !== undefined && !saveOutage(status) && saveFailure(status, code) === "keep" ? `Not saved: ${sentence}` : "");

/** The banner over a canvas whose edit waits for the board's server. */
export const notSaved = (name: string): string => `Not saved, ${name} unreachable`;
/** The same banner while that server is connected: the save was answered 503 `not_held_there` (the board is being
 *  taken again there after the server came back) or got no answer. The edit is kept as under an outage, and the
 *  `held` that follows saves it at the revision it was made on, or drops it with the notice at another. */
export const notSavedYet = (name: string): string => `Not saved yet, waiting for ${name}`;
/** The banner's words. connected: the page holds the tree of the board's server. */
export const bannerText = (name: string, connected: boolean): string => (connected ? notSavedYet(name) : notSaved(name));

/** Said in the role bar of a board, and in the note on the canvas of a board that is held. */
export const DROPPED_TEXT = "A change made here was not saved in time and was dropped.";
/** The note after an edit was dropped; outage: it had waited for the board's server, which stored another scene meanwhile. */
export const droppedText = (outage: boolean, name: string): string =>
  outage ? `This board was changed while ${name} was unreachable. Your unsaved changes were dropped.` : DROPPED_TEXT;

/** What shows for a board. gone: it is no longer on its server. unreachable: its server is not connected and this
 *  window keeps no scene of it (scenes are kept in memory only). canvas: everything else.
 *  connected: the page holds that server's tree; gone: the page knows that the board was removed there. */
export type BoardView = "canvas" | "unreachable" | "gone";
export function boardView(at: { connected: boolean; gone?: boolean }, hasScene: boolean): BoardView {
  if (at.gone) return "gone";
  return at.connected || hasScene ? "canvas" : "unreachable";
}

/** The view in place of the canvas of a board that is not `canvas`. */
export const offText = (view: Exclude<BoardView, "canvas">, name: string): { title: string; body: string } =>
  view === "gone"
    ? { title: `No longer on ${name}`, body: `This whiteboard was on ${name} and is not there any more.` }
    : { title: `${name} is not connected`, body: `This whiteboard is on ${name}. It opens when the server is connected again.` };

/** The name of a board's server for these texts. board: its key. */
export const serverNameOf = (board: string | undefined, servers: { id: string; name: string }[]): string =>
  servers.find((v) => v.id === serverOfKey(board))?.name ?? "the server";
