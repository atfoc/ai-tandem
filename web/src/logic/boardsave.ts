// A board on another server (Board.server): what a failed save does to the edit, what shows in
// place of its canvas while that server is away or the board is gone there, and the texts of the
// banner, the notice and the take-over panel. A local board keeps the texts it had. DOM-free.
import type { Board } from "../types.ts";

/** What a failed save does to the edit. drop: the server refused it for good (the scene was changed elsewhere, or
 *  another window holds the board). keep: it did not get there (no answer, a 503 of this computer's server for a board
 *  whose server is away or being taken again, any other error); the next change or flush writes it again. */
export type SaveFailure = "drop" | "keep";
export function saveFailure(_status: number | undefined, code: string | undefined): SaveFailure {
  return code === "stale" || code === "not_holder" ? "drop" : "keep";
}

/** Whether a failed save of a board says its server is away, which raises the banner: this computer's server could not
 *  pass the write on (503), or passed it on and got no answer because the link broke meanwhile (504). Only for a board
 *  on another server. */
export const saveOutage = (status: number | undefined, remote: boolean): boolean =>
  remote && (status === 503 || status === 504);

/** The banner over a canvas whose edit waits for the board's server. */
export const notSaved = (name: string): string => `Not saved, ${name} unreachable`;

/** Said in the take-over panel, and in the note on the canvas of a board that is held. */
export const DROPPED_TEXT = "A change made here was not saved in time and was dropped.";
/** The note after an edit was dropped; outage: it had waited for the board's server, which stored another scene meanwhile. */
export const droppedText = (outage: boolean, name: string): string =>
  outage ? `This board was changed while ${name} was unreachable. Your unsaved changes were dropped.` : DROPPED_TEXT;

/** What shows for a board. gone: it is no longer on its server. unreachable: its server is not connected and this
 *  window keeps no scene of it (scenes are kept in memory only). canvas: everything else, and every local board. */
export type BoardView = "canvas" | "unreachable" | "gone";
export function boardView(b: Board, connected: boolean, hasScene: boolean): BoardView {
  if (!b.server) return "canvas";
  if (b.gone) return "gone";
  return connected || hasScene ? "canvas" : "unreachable";
}

/** The view in place of the canvas of a board that is not `canvas`. */
export const offText = (view: Exclude<BoardView, "canvas">, name: string): { title: string; body: string } =>
  view === "gone"
    ? { title: `No longer on ${name}`, body: `This whiteboard was on ${name} and is not there any more.` }
    : { title: `${name} is not connected`, body: `This whiteboard is on ${name}. It opens when the server is connected again.` };

/** The take-over panel of a board another client holds: for a board on another server that may be a window there. */
export const takeoverText = (b: Board, name: string): { title: string; body: string } =>
  b.server
    ? { title: "In use elsewhere", body: `This whiteboard is in use in another window or on ${name}. Only one can draw on it at a time.` }
    : { title: "Open in another window", body: "This whiteboard is in use in another tab or window. Only one can draw on it at a time." };

/** The name of a board's server for these texts. */
export const serverNameOf = (b: Board | undefined, servers: { id: string; name: string }[]): string =>
  servers.find((v) => v.id === b?.server)?.name ?? "the server";
