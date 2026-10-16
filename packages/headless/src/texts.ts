// What the headless writer tells an agent in its own words (architecture 2.10). The other texts an agent gets (a call cut by a
// hand-off, the writer stopped, no writer at all) are the server's: the relay writes them.
import { boardRef } from "@aiwb/core/logic/context.ts";
import { ownId } from "@aiwb/core/logic/keys.ts";

/** How a board is named to the agent: `name (id)` as boardRef writes it, the bare id for a board the store does not know. */
export const nameOf = (id: string, board?: { name: string; id: string }): string => (board ? boardRef(board) : ownId(id));

/** A call reaches the writer while it yields the board (the code prefix is added where the error is answered). */
export const takenText = (name: string): string =>
  `${name} is being taken over in a window; call again in a moment and that window answers.`;

/** get_image with scope "selection": no window shows the board, so nothing is selected on it. */
export const noSelectionText = (name: string): string =>
  `no window shows ${name} now, so nothing is selected on it; use scope all, refs or rect`;

/** get_view reaches the writer (the server does not send it one): not an error. */
export const noViewText = (name: string): string =>
  `No window shows ${name} now, so there is no view and no selection to read. The board itself can be read and changed as usual: use read_board, and get_image for a picture.`;

/** show_board reaches the writer: not an error either. */
export const noShowText = (name: string): string =>
  `No window shows this chat's board now, so ${name} could not be put on a screen. Your changes are saved in the board; the user sees them when they open it.`;

/** apply or delete_elements was done, and could not be saved: the agent is not told it is done. */
export const saveFailedText = (why: string): string => `the change was made but could not be saved: ${why}`;
