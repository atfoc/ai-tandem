// The canvas of an open new board (kind "tl", plans/better-board/design.md 6): board-tl's view (platform/tlboard) where the
// Excalidraw view goes for an old board. Many people edit it at once through the board's server, so nothing of the old board's
// writer model is here: no bar that says who writes ("Edit here"), no banner of a save that waits, no note of a dropped edit, and
// the board side (`boardApp`) never sees the board. The screen opens the board's sync line (core's openTlLink) while it is
// mounted, gives the view the person's generated name (D12, tluser.ts), and registers the handle the view gives for an agent's
// get_view and show_board (core's tlRegistry).
import { useEffect, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";

import { openTlLink, type TlLink } from "@aiwb/core/tl/link.ts";
import { tlRegistry, type TlViewHandle } from "@aiwb/core/tl/registry.ts";

import { TlHost } from "../../platform/tlboard";
import { useStore } from "../../state/useStore.ts";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useSlots } from "../shell/slots.tsx";
import { BoardOff } from "./BoardOff.tsx";
import { tlUser } from "./tluser.ts";

export function TlCanvas({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const known = useStore((s) => !!s.boards[board]);
  const archived = useStore((s) => !!s.boards[board]?.archived);
  const gone = useStore((s) => !!s.gone[board]); // the board is no longer on its server
  const slots = useSlots();
  const user = useMemo(() => tlUser(), []);
  const [link, setLink] = useState<TlLink | null>(null);
  const live = known && !gone;

  // One link while the board is on screen; closed (its session with it) when the board is left.
  useEffect(() => {
    if (!live) return;
    const l = openTlLink(board);
    setLink(l);
    return () => { l.close(); setLink(null); };
  }, [board, live]);

  // (the host also clears the handle as the view goes; this covers a view that never mounted)
  useEffect(() => () => tlRegistry().setHandle(board, null), [board]);
  const onHandle = useMemo(() => (h: TlViewHandle | null) => tlRegistry().setHandle(board, h), [board]);

  let state: string;
  let content: React.ReactNode;
  if (!known) { state = "empty"; content = <View {...tid("canvas-empty")} style={styles.fill} />; }
  else if (gone) { state = "off"; content = <BoardOff board={board} view="gone" />; }
  else {
    state = link ? "ready" : "loading";
    content = (
      <>
        {link ? <TlHost key={board} board={board} link={link} user={user} onHandle={onHandle} /> : null}
        {!archived && <slots.BoardVoice board={board} />}
      </>
    );
  }
  return <View {...tid("board-canvas", { board, state, kind: "tl" })} style={[styles.fill, { backgroundColor: t.bg }]}>{content}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
});
