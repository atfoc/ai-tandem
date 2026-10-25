// The phone menu's two items the app carries out (package B1, b1-design.md §4 "Menu actions"): **Share image…** hands the whole board's
// picture to the platform's share, **Clear the board…** asks first and then deletes every shape as one change. The deps are given so
// that Node tests them; usePhoneBoard.ts gives the real ones. No React Native here.
import type { ConfirmRequest } from "@aiwb/core/state/store.ts";

export type MenuItem = "share" | "clear";

export type MenuDeps = {
  /** The board's picture (`boardApp.boardPicture`): `png` is base64. */
  picture(board: string): Promise<{ png: string }>;
  /** Every shape of the board deleted as one change (`boardApp.clearBoard`). */
  clear(board: string): Promise<void>;
  share(png: string, name: string): Promise<void>;
  confirm(req: ConfirmRequest): void;
  toast(text: string): void;
  boardName(board: string): string;
  serverName(board: string): string;
  /** A file name (no extension) for the board's picture. */
  fileName(name: string): string;
};

/** The question Clear asks (P4): the board's name, who it is removed for, the go button in the verb and the noun. */
export const clearRequest = (name: string, server: string, run: () => Promise<void>): ConfirmRequest => ({
  title: `Clear “${name}”?`,
  body: `Every shape on it is removed, for everyone who opens it on ${server}.`,
  confirmLabel: "Clear the board",
  actions: [{ label: "Clear the board", tone: "danger", run }],
});

export const NOTHING_TO_SHARE = "Nothing on the board to share";

const codeOf = (e: unknown): string => (e as { code?: unknown } | null)?.code as string ?? "";

/** What a failed Share says, in plain words. */
export function shareFailure(e: unknown): string {
  const c = codeOf(e);
  if (c === "EMPTY") return NOTHING_TO_SHARE;
  if (c === "TOO_LARGE") return "The board is too big to share as one picture";
  return "Couldn't share the board's picture";
}

/** What a failed Clear says, in plain words. */
export function clearFailure(e: unknown): string {
  const c = codeOf(e);
  if (c === "NOT_HOLDER") return "Edit here first: another window is editing this board";
  if (c === "ARCHIVED") return "This board is archived and can't be changed";
  return "Couldn't clear the board";
}

/** The function `boardApp.onMenu` is given: one per item, errors said as toasts. */
export function menuHandler(d: MenuDeps): (board: string, item: MenuItem) => void {
  const share = async (board: string) => {
    try {
      const pic = await d.picture(board);
      await d.share(pic.png, d.fileName(d.boardName(board)));
    } catch (e) { d.toast(shareFailure(e)); }
  };
  const clear = (board: string) => {
    d.confirm(clearRequest(d.boardName(board), d.serverName(board), async () => {
      try { await d.clear(board); } catch (e) { d.toast(clearFailure(e)); } // (the dialog goes: the toast says why nothing happened)
    }));
  };
  return (board, item) => { if (item === "share") void share(board); else if (item === "clear") clear(board); };
}
