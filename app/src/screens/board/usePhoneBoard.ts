// What the phone's board screen gives the board side while it is up (package B1, b1-design.md §4): the chrome of the view (the board's
// name, the measured inset, the app's colours), how a board opens (where it was left), and the carrying out of the menu's items. On the
// wide layouts, and in landscape for the chrome, it gives nothing: the view keeps Excalidraw's own. BoardCanvas calls it.
import { useEffect, useRef } from "react";
import { Platform } from "react-native";

import { serverNameOf } from "@aiwb/core/logic/boardsave.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { shareImage } from "../../platform/shareimage";
import { pictureName } from "../../platform/shareimagecore.ts";
import { useStore } from "../../state/useStore.ts";
import { useTheme } from "../../ui/theme.tsx";
import { showToast } from "../../ui/Toast.tsx";
import { boardApp } from "../shell/boardside.ts";
import { confirm } from "../shell/confirm.ts";
import { menuHandler } from "./menu.ts";
import { phoneChrome } from "./phonechrome.ts";
import { useRowInset } from "./rowinset.ts";
import { openViewFor, rememberView } from "./viewmemory.ts";

/** The write of a view waits for the view to stop moving for this long (a pan sends one message in a few frames). */
const REMEMBER_MS = 400;

const handler = menuHandler({
  picture: (b) => boardApp.boardPicture(b),
  clear: (b) => boardApp.clearBoard(b),
  share: shareImage,
  confirm,
  toast: (text) => { showToast({ text }); },
  boardName: (b) => getState().boards[b]?.name ?? "this board",
  serverName: (b) => serverNameOf(b, getState().servers),
  fileName: pictureName,
});

export function usePhoneBoard(board: string, o: { phone: boolean; landscape: boolean; loaded: boolean }): void {
  const { tokens: t } = useTheme();
  const name = useStore((s) => s.boards[board]?.name ?? "");
  const inset = useRowInset();
  const { phone, landscape, loaded } = o;

  // The chrome: portrait on the phone only. Leaving the board's screen for another on the phone leaves it as it is (the next board
  // screen sets its own); the wide layouts always get null, also when the window is made wide while a board is open.
  const share = Platform.OS !== "android";
  useEffect(() => {
    boardApp.setPhoneChrome(phoneChrome({ phone, landscape, name: name || "Board", inset, band: t.bg, line: t.line, share }));
  }, [phone, landscape, name, inset, t.bg, t.line, share]);

  // The top inset is the floating controls' (landscape on the native phone: FloatingControls sends it as it measures them and takes it back as
  // it goes); everywhere else none, so a window made wide, or a phone turned back, has none.
  useEffect(() => { if (!landscape) boardApp.setTopInset(0); }, [landscape]);

  // How a board opens, and where it was left.
  useEffect(() => {
    boardApp.setOpenView(phone ? openViewFor : null);
  }, [phone]);
  useViewMemory(board, phone, loaded);

  // The menu's items.
  useEffect(() => (phone ? boardApp.onMenu(handler) : undefined), [phone]);
}

/** Writes the view of the board shown (`loaded`: the view has drawn it), from the store's `view` (the board view's own messages), while it is shown on the phone. The
 *  store's view is the last board's until this board's first message after its load: that one is not this board's, so it is not kept. */
function useViewMemory(board: string, phone: boolean, loaded: boolean) {
  const view = useStore((s) => s.view);
  const stale = useRef<unknown>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<{ board: string; scrollX: number; scrollY: number; zoom: number } | null>(null);

  const flush = () => {
    clearTimeout(timer.current);
    const p = pending.current;
    pending.current = null;
    if (p) rememberView(p.board, p);
  };

  useEffect(() => { // (the board is drawn: what the store holds now is not this board's yet)
    stale.current = loaded ? getState().view : null;
    return flush;
  }, [loaded, board]);

  useEffect(() => {
    if (!phone || !loaded || view === stale.current || !view.width) return;
    pending.current = { board, scrollX: view.scrollX, scrollY: view.scrollY, zoom: view.zoom };
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, REMEMBER_MS);
  }, [view, phone, loaded, board]);

  useEffect(() => flush, []);
}
