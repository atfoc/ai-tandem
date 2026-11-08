// The new board's view on web (kind "tl", plans/better-board/design.md 6): board-tl's web target (`tl/tl.js`, loaded by the
// page beside `board/board.js`) is mounted in a box of this host, in-process, with its own React root, as board.web.tsx mounts
// board-view's. The view talks to the server through the link it is given; it gives back a handle for get_view and show_board.
//
// Focus (spike-ui.md, "focus when the board is opened, not while they type elsewhere"): the view focuses its container when it
// mounts, which is when the person opens the board. A board that comes on screen while the person types in a text field
// elsewhere (an agent's show_board while they write in the composer) gives the focus back to that field, unless the person
// has pressed or typed in the board meanwhile.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { Text } from "../ui/Text.tsx";
import type { TlHostProps, TlViewApi } from "./tlboard.types.ts";

export type { TlHostProps } from "./tlboard.types.ts";

declare global {
  interface Window { aiwbTlView?: TlViewApi }
}

export const TL_VIEW_ID = "tl-board-view";

/** How long after the mount a focus the view takes for itself is given back to the field the person types in (the view
 *  focuses once its fonts are loaded, a moment after the mount). */
const GIVE_BACK_MS = 3000;

/** Whether the element is one the person types in: a text input, a text area, an editable element. */
function typesIn(el: Element | null): el is HTMLElement {
  if (!el || el === document.body) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
}

/** Keeps the focus in the field the person was typing in when the view mounted in `box`; answers the function that stops it. */
function keepTyping(box: HTMLElement): () => void {
  const field = document.activeElement;
  if (!typesIn(field) || box.contains(field)) return () => {};
  let theirs = false; // the person pressed or typed in the board: the focus there is theirs
  const mine = () => { theirs = true; };
  const back = (e: FocusEvent) => {
    if (theirs || !field.isConnected || !box.contains(e.target as Node)) return;
    field.focus({ preventScroll: true });
  };
  box.addEventListener("pointerdown", mine, true);
  box.addEventListener("keydown", mine, true);
  box.addEventListener("focusin", back);
  const stop = () => {
    clearTimeout(timer);
    box.removeEventListener("pointerdown", mine, true);
    box.removeEventListener("keydown", mine, true);
    box.removeEventListener("focusin", back);
  };
  const timer = setTimeout(stop, GIVE_BACK_MS);
  return stop;
}

export function TlHost({ board, link, user, onHandle, testID = TL_VIEW_ID }: TlHostProps) {
  const box = useRef<View>(null);
  const latest = useRef(onHandle);
  latest.current = onHandle;
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    // (on web a View's ref is the DOM element it draws)
    const element = box.current as unknown as HTMLElement | null;
    if (!element) return;
    const api = window.aiwbTlView;
    if (!api) { setMissing(true); return; } // (tl.js did not load)
    setMissing(false);
    const stopKeeping = keepTyping(element);
    let live = true;
    const handle = api.mount(element, { board, link, user, testID, onHandle: (h) => { if (live) latest.current(h); } });
    return () => {
      live = false;
      stopKeeping();
      latest.current(null);
      handle.unmount();
    };
  }, [board, link, user.id, testID]);

  return (
    <View style={styles.fill}>
      <View ref={box} style={styles.fill} />
      {missing ? <View style={styles.cover}><Text tone="muted">Couldn't open this board: the board view did not load</Text></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  cover: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, alignItems: "center", justifyContent: "center" },
});
