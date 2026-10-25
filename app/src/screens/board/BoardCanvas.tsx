// The canvas of an open board (the old page's Canvas.tsx on the old page): the board view where the stand-in of the shell was, and
// over it what the app draws (Overlays.tsx). The canvas shows for every role (in view mode unless this window holds the board),
// with the bar that says which it is and offers "Edit here" (RoleBar.tsx); a board of a
// section whose server is not connected, with no scene kept here, or that is no longer on that server, the view that says so
// (BoardOff). A board that is open when its server drops stays open and is drawn on: its edit waits in this window, under the
// banner (SaveBanner). The board side (AD-55, `boardApp`) reads the scene and sends it to the view; this tells it which board
// is wanted and gives it the view's channel.
import { NavigationContext } from "@react-navigation/native";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Linking, StyleSheet, View } from "react-native";

import { boardView, droppedText, serverNameOf } from "@aiwb/core/logic/boardsave.ts";
import { ApiError } from "@aiwb/core/api.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import { getState, setDropped, setRole } from "@aiwb/core/state/store.ts";

import { BoardHost } from "../../platform/board";
import type { HostChannel } from "../../platform/board.types.ts";
import { onKey } from "../../platform/keys";
import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { usePhone } from "../../ui/useLayout.ts";
import { boardApp } from "../shell/boardside.ts";
import { useSlots } from "../shell/slots.tsx";
import { confirm, select } from "../shell/nav.ts";
import { BoardOff, SaveBanner } from "./BoardOff.tsx";
import { boardKeyHandler } from "./boardkeys.ts";
import { engine } from "./engine.ts";
import { useBoardLandscape } from "./landscape.ts";
import { onPhone } from "./phone.ts";
import { DroppedNote, FlashLayer, PickLayer, Presence } from "./Overlays.tsx";
import { setPickGo } from "./refs.ts";
import { BottomRow } from "./BottomRow.tsx";
import { usePickWait } from "./PickBar.tsx";
import { RoleBar, editHere } from "./RoleBar.tsx";
import { EDIT_HERE } from "./rolebar.ts";
import { FILL } from "./fill.ts";
import { usePhoneBoard } from "./usePhoneBoard.ts";

// The view of the board on screen (where it is scrolled and how far it is zoomed), for the browser checks of the pick layer (P7.4-board.mjs): a build
// made for the checks (version "uicheck", `buildAppDist`) shows it as `window.__aiwbView()`; no other build does.
if (process.env.EXPO_PUBLIC_AIWB_VERSION === "uicheck" && typeof window !== "undefined") (window as unknown as { __aiwbView?: () => unknown }).__aiwbView = () => getState().view;

/** The board the screen shows now: the one that put its view on screen last owns it, and only the owner lets it go. */
let owner: symbol | null = null;

/** A page tried to open an address (a link on an element of a scene an agent drew): nothing opens without the user's yes. */
function offerLink(url: string): void {
  confirm({
    title: "Open this address?", body: url,
    actions: [{ label: "Open", tone: "primary", run: async () => { await Linking.openURL(url); } }],
  });
}

function useViewStatus() {
  return useSyncExternalStore(boardApp.watchView, boardApp.viewStatus);
}

/** On the phone a board's screen is written when it is left for another (blur): the stack keeps it mounted beneath. */
function useBlurFlush(board: string) {
  const nav = useContext(NavigationContext); // (none on the wide layouts: the board is closed by the shell, which unmounts this)
  useEffect(() => nav?.addListener("blur", () => { void boardApp.flush(board); }), [nav, board]);
}

/** The phone says what the wide layouts draw over the board as toasts (b1-design.md §4): an edit made here that was dropped, once
 *  for each drop, whether this window still holds the board or came back to it as a reader, and this window losing the board to another, with the action that takes it back. */
function useBoardToasts(board: string, on: boolean) {
  const role = useStore((s) => s.roles[board]);
  const archived = useStore((s) => !!s.boards[board]?.archived);
  const agent = useStore((s) => s.writers[board] === "headless"); // (an agent has it by now: the bar says so)
  const dropped = useStore((s) => !!s.dropped[board] && !s.boards[board]?.archived); // (held: the canvas's note; a reader: the bar's line)
  const server = useStore((s) => serverNameOf(board, s.servers));
  const was = useRef(role);
  useEffect(() => {
    if (!on || !dropped) return;
    showToast({ text: droppedText(role === "held" && boardApp.droppedInOutage(board), server), kind: "board-dropped", ms: 8000 });
    setDropped(board, false); // (said: the next drop is another)
  }, [on, dropped]);
  useEffect(() => {
    const before = was.current;
    was.current = role;
    if (on && role === "lost" && before !== "lost" && !archived && !agent)
      showToast({ text: "Another window took over this board", kind: "board-lost", ms: 8000, action: { label: EDIT_HERE, run: () => editHere(board) } });
  }, [on, role]);
}

export function BoardCanvas({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const b = useStore((s) => s.boards[board]);
  const role = useStore((s) => s.roles[board]);
  const gen = useStore((s) => s.sceneGen[board] ?? 0); // raised when the scene kept for the board was dropped: it is read again
  const connected = useStore((s) => serverConnected(s, serverOfKey(board))); // the page holds the tree of the board's server
  const gone = useStore((s) => !!s.gone[board]); // the board is no longer on its server
  const known = !!b, archived = !!b?.archived;
  const [err, setErr] = useState("");
  const [away, setAway] = useState(false); // the read of the scene was answered 503: the board's server is not connected
  const [channel, setChannel] = useState<HostChannel | null>(null);
  const status = useViewStatus();
  const slots = useSlots();
  const phone = usePhone();
  const landscape = useBoardLandscape();
  const picking = !!usePickWait(board); // (on the phone the pick bar is the whole bottom row while a chat of the board waits: the voice pill is not drawn over it, b2-design.md §6)

  useBoardToasts(board, phone);
  usePhoneBoard(board, { phone, landscape, loaded: status.board === board && status.loaded });
  useBlurFlush(board);
  useEffect(() => onKey(boardKeyHandler(onPhone)), []);
  useEffect(() => { setPickGo(select); }, []); // (the phone's wait for a point goes between the chat and the board by the shell's own selection)

  // An archived board is nobody's to write: it shows read-only whatever window held it last, and has no role. A board on screen
  // that is not archived is never taken here: a window takes it when the user presses the button of the bar.
  useEffect(() => { if (known && archived && role) setRole(board, null); }, [board, known, archived, role]);

  // (a board of a section: gone there; or that server is away and this window keeps no scene of it. When the section's
  // tree arrives the scene is read again: sectionBack)
  const off = boardView({ connected: connected && !away, gone }, boardApp.scene(board) !== undefined);
  const wanted = known && off === "canvas" && !err;

  // A read that failed is tried again for another board, and once the scene kept for the board was dropped (the section is back).
  useEffect(() => { setErr(""); setAway(false); }, [board, gen]);

  // The board is shown in the view once the view is there; a read that fails says why. Declared before the attach below: on
  // the way out the board is written first (the view is asked for its scene), then the view is let go.
  const shownGen = useRef(-1); // the gen the board was last asked for with
  const ask = (live: () => boolean) => {
    shownGen.current = gen;
    boardApp.show(board).catch((e: unknown) => {
      if (!live()) return;
      setErr((e as Error)?.message ?? String(e));
      setAway(e instanceof ApiError && e.status === 503);
    });
  };
  useEffect(() => {
    if (!wanted || !channel) return;
    let live = true;
    const me = Symbol();
    owner = me;
    ask(() => live);
    return () => { live = false; if (owner === me) { owner = null; boardApp.hide(); } };
  }, [board, wanted, channel]);

  // The scene kept for the board was dropped (gen): the board shown is read again and applied in place, not hidden first (the
  // view keeps its scroll and zoom, and a reader following a new revision sees no loading state).
  useEffect(() => {
    if (!wanted || !channel || shownGen.current === gen) return;
    let live = true;
    ask(() => live);
    return () => { live = false; };
  }, [gen]);

  useEffect(() => {
    if (!channel) return;
    const detach = boardApp.attachView(channel);
    engine.setVisible(channel);
    return () => { detach(); engine.setVisible(null); };
  }, [channel]);

  let state: string;
  let content: React.ReactNode;
  if (!b) { state = "empty"; content = <View {...tid("canvas-empty")} style={styles.fill} />; }
  else if (off === "gone") { state = "off"; content = <BoardOff board={board} view="gone" />; }
  else if (off !== "canvas") { state = "off"; content = <BoardOff board={board} view={off} />; }
  else {
    const mine = status.board === board;
    const failed = err || (mine ? status.error : "");
    const loaded = mine && status.loaded;
    state = failed ? "error" : loaded ? "ready" : "loading";
    content = (
      <>
        <PickLayer board={board}>
          {!err && <BoardHost onChannel={setChannel} onOpenLink={offerLink} />}
          {/* (while the scene is read, and until the view has drawn it, the stage is empty: no other board's drawing shows) */}
          {!loaded && (
            <View {...tid("canvas-empty")} style={[styles.cover, { backgroundColor: t.bg }]}>
              {failed ? <Text {...tid("canvas-error")} tone="muted" style={styles.error}>Couldn't open this board: {failed}</Text> : null}
            </View>
          )}
          <FlashLayer board={board} />
          {!phone && <Presence board={board} />}
        </PickLayer>
        {!archived && !phone && <RoleBar board={board} />}
        {!archived && !(phone && picking) && <slots.BoardVoice board={board} />}
        <SaveBanner board={board} />
        {!phone && <DroppedNote board={board} />}
        {phone && !landscape && <BottomRow board={board} />}
      </>
    );
  }
  return <View {...tid("board-canvas", { board, state })} style={[styles.fill, { backgroundColor: t.bg }]}>{content}</View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  cover: { ...FILL, alignItems: "center", justifyContent: "center", zIndex: 2 },
  error: { maxWidth: 380, textAlign: "center" },
});
