// The board host on web (AD-40, AD-52): board-view's web target (`board/board.js`, loaded by the page before the app's
// bundle) is mounted in a box of this host, in-process. `post` of the view is a function call into the channel and the
// channel's `post` a call into the view, so the web build speaks the messages the phone's web view speaks.
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import type {} from "@aiwb/board-view/web/api.ts"; // (the type of `window.aiwbBoardView`)

import { createHostChannel, drained } from "./boardchannel.ts";
import type { BoardHostProps } from "./board.types.ts";

export type { BoardHostProps, HostChannel } from "./board.types.ts";

export const BOARD_VIEW_ID = "board-view";

export function BoardHost({ onChannel, hidden, testID = BOARD_VIEW_ID }: BoardHostProps) {
  const box = useRef<View>(null);
  const latest = useRef(onChannel);
  latest.current = onChannel;

  useEffect(() => {
    // (on web a View's ref is the DOM element it draws)
    const element = box.current as unknown as HTMLElement | null;
    const api = window.aiwbBoardView;
    if (!element) return;
    let handle: ReturnType<NonNullable<typeof api>["mount"]> | null = null;
    const link = createHostChannel((m) => handle?.receive(m));
    latest.current(link.channel);
    if (!api) {
      // (board.js did not load: the screen says it as any failure of the view)
      link.receive({ t: "error", message: "the board view did not load" });
      return () => latest.current(null);
    }
    handle = api.mount(element, (m) => link.receive(m), { testID });
    return () => {
      latest.current(null);
      // The view may be asked for the scene it shows as the board is left (to write it): it answers, then it goes.
      void drained(link.channel).then(() => { link.reset("the board view was closed"); handle?.unmount(); handle = null; });
    };
  }, [testID]);

  return <View ref={box} style={hidden ? styles.hidden : styles.fill} pointerEvents={hidden ? "none" : "auto"} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" },
});
