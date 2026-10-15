// The wide layouts, tablet and desktop (AD-71, AD-72): one screen, the split view of today's `Grouped` — the sidebar pane (or, while
// it is hidden, the rail that shows it again), and beside it the selected board with its chat panel, the selected plain chat, or Home.
// On a tablet too narrow to hold the three at their least the sidebar lies over the stage and starts hidden (widths.ts).
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";

import { branchKey } from "@aiwb/core/logic/branches.ts";
import { viewedBranch } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import type { Layout } from "../../ui/breakpoints.ts";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { BoardBar } from "./BoardBar.tsx";
import { Guard } from "./Guard.tsx";
import { HomeOrWait } from "./Home.tsx";
import { SIDE_IDS, setSideHidden } from "./nav.ts";
import { Pane } from "./Pane.tsx";
import { SideRail } from "./SideRail.tsx";
import { useSlots } from "./slots.tsx";
import { useShellView } from "./useShellView.ts";
import { layoutWidths, sideOverlays } from "./widths.ts";

export function WideLayout({ layout }: { layout: Exclude<Layout, "phone"> }) {
  const { tokens: t } = useTheme();
  const { width } = useWindowDimensions();
  const slots = useSlots();
  const view = useShellView();
  const panelOn = useStore((s) => s.panel);
  const widths = useStore((s) => s.widths);
  const sideHidden = useStore((s) => s.sideHidden);
  const chats = useStore((s) => s.chats); // (the sidebar's fence draws it again when the lists change)
  // the composer is one per branch: on another branch it goes away with its draft saved, and a new one opens with that branch's
  const viewed = useStore((s) => (view.kind !== "home" && view.chat ? viewedBranch(s, view.chat) : "main"));

  const overlay = sideOverlays(layout, width);
  const hasPanel = view.kind === "board" && !!view.chat && panelOn;
  const w = layoutWidths(width, widths, { sideHidden, panel: hasPanel, overlay });
  const sel = view.kind === "home" ? "" : `${view.kind === "board" ? view.board : ""}|${view.chat}`;

  let main;
  if (view.kind === "board") {
    main = (
      <>
        {hasPanel && view.chat && (
          <Pane pane="panel" testID="board-panel" width={w.panel} room={w.roomPanel}>
            <slots.ChatView key={branchKey(view.chat, viewed)} chat={view.chat} />
          </Pane>
        )}
        <View {...tid("board-stage")} style={styles.stage}>
          <BoardBar board={view.board} chatOpen={hasPanel} />
          <View style={styles.canvas}><slots.Canvas board={view.board} /></View>
        </View>
      </>
    );
  } else if (view.kind === "chat") {
    main = (
      <View {...tid("chat-page")} style={[styles.stage, { backgroundColor: t.bg }]}>
        <slots.ChatView key={branchKey(view.chat, viewed)} chat={view.chat} />
      </View>
    );
  } else main = <HomeOrWait />;

  return (
    <View {...tid("app", { side: sideHidden ? "hidden" : "shown", layout })} style={styles.app}>
      {w.rail && <SideRail />}
      <Pane pane="side" testID={SIDE_IDS.pane} width={w.side} room={w.roomSide} hidden={sideHidden} over={overlay}>
        <Guard what="the sidebar" resetKey={chats}><slots.Sidebar /></Guard>
      </Pane>
      {overlay && !sideHidden && <Pressable {...tid("side-backdrop")} accessibilityLabel="Hide sidebar" focusable={false} style={styles.backdrop} onPress={() => setSideHidden(true)} />}
      <Guard what="this page" resetKey={sel}>{main}</Guard>
      <slots.SubagentDrawer />
    </View>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, flexDirection: "row", minHeight: 0 },
  stage: { flex: 1, minWidth: 0, minHeight: 0 },
  canvas: { flex: 1, minHeight: 0 },
  backdrop: { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, zIndex: 10 },
});
