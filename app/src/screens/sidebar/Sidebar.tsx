// The sidebar: one section per server of the server list, this computer's first. A section shows that server's whole tree: the groups
// the user made there, each holding subgroups, whiteboards (each with its own chats) and plain chats, plus the ungrouped area
// (logic/sections.ts). The sidebar is sections only, with a head (the logo, the control that hides it, a "+") above and a foot below
// (the old page's Sidebar.tsx). It fills the shell's slot `Sidebar`: the side pane on the wide layouts, the first screen of the phone's stack.
import { useContext, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { sidebarEntries } from "@aiwb/core/logic/sections.ts";
import { getState } from "@aiwb/core/state/store.ts";
import { LOCAL_SERVER, UNGROUPED } from "@aiwb/core/types.ts";

import { hasThisComputer } from "../../platform/thiscomputer.ts";
import { useStore } from "../../state/useStore.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { BoardIcon, ChatIcon, GroupIcon, Logo } from "../../ui/icons.tsx";
import { Menu, MenuItem, MenuSep } from "../../ui/Menu.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useLayout, windowLayout } from "../../ui/useLayout.ts";
import { addBoard, attempt, newChat, setEditRow, setExpandBoardRow } from "../shell/nav.ts";
import { clipRef, DragGhost, LOCK_SCROLL, setScroller, useDragActive } from "./drag.tsx";
import { SideHideButton } from "../shell/SideRail.tsx";
import { stackOf } from "../shell/stack.ts";
import { newGroup } from "./actions.ts";
import { mayRename } from "./editguard.ts";
import { Foot } from "./Foot.tsx";
import { Still, later } from "./menus.tsx";
import { useSideHidden, Text } from "./parts.tsx";
import { setBoardRowOpen } from "./rowsopen.ts";
import type { Make } from "./rows.tsx";
import { SectionNode } from "./Section.tsx";

export function Sidebar() {
  const t = useTokens();
  const layout = useLayout();
  const insets = useContext(SafeAreaInsetsContext);
  const servers = useStore((s) => s.servers);
  const dragging = useDragActive();
  const list = useScrolling();
  const [editing, setEditing] = useState<string | null>(null);
  // (what is made while the sidebar is hidden gets no rename box: nobody would see it, and hiding wins)
  // (on the phone what is made may open its own screen over the list, which hides it as well: a board does, a group does not)
  const edit = (key: string | null) => { if (mayRename(getState().sideHidden, windowLayout(), stackOf(getState()))) setEditing(key); };
  useEffect(() => { setEditRow(edit); return () => setEditRow(() => {}); }, []);
  useEffect(() => { setExpandBoardRow((board) => setBoardRowOpen(board, true)); return () => setExpandBoardRow(() => {}); }, []);
  useSideHidden(() => setEditing(null));

  const make: Make = {
    board: addBoard,
    group: (server, parent = "") => attempt("Couldn't create the group", async () => edit("group:" + await newGroup(server, parent))),
  };
  const entries = sidebarEntries(servers).filter((v) => hasThisComputer() || (!v.local && v.id !== LOCAL_SERVER));

  return (
    <View {...tid("side")} style={[styles.side, { backgroundColor: t.panel }]}>
      <View {...tid("side-head")} style={[styles.head, { paddingTop: 10 + (insets?.top ?? 0) }]}>
        <View {...tid("side-brand")} style={styles.brand}>
          <Logo />
          <Text weight="600" numberOfLines={1} style={styles.brandName}>AI Whiteboard</Text>
        </View>
        {layout !== "phone" && <SideHideButton />}
        {hasThisComputer() && <HeadPlus make={make} />}
      </View>
      {/* (the box the tree is seen through: a place scrolled out of it takes no drop, drag.tsx) */}
      <View ref={clipRef} collapsable={false} style={styles.tree}>
        <ScrollView {...tid("side-tree")} {...list.props} style={styles.tree} contentContainerStyle={styles.treeBody} keyboardShouldPersistTaps="handled" scrollEnabled={!(LOCK_SCROLL && dragging)}>
          {entries.map((v, i) => <SectionNode key={v.id} v={v} first={i === 0} editing={editing} setEditing={setEditing} make={make} />)}
        </ScrollView>
      </View>
      <View style={{ paddingBottom: insets?.bottom ?? 0 }}><Foot /></View>
      <DragGhost />
    </View>
  );
}

/** The list's scroll position, kept by its own events, so that a drag held near its edge can scroll it (drag.tsx setScroller). */
function useScrolling() {
  const ref = useRef<ScrollView>(null);
  const at = useRef({ y: 0, content: 0, view: 0 });
  useEffect(() => {
    setScroller((dy) => {
      const s = at.current, y = Math.max(0, Math.min(Math.max(0, s.content - s.view), s.y + dy));
      if (y === s.y) return;
      s.y = y;
      ref.current?.scrollTo({ y, animated: false });
    });
    return () => setScroller(null);
  }, []);
  return {
    props: {
      ref,
      scrollEventThrottle: 16,
      onScroll: (e: { nativeEvent: { contentOffset: { y: number } } }) => { at.current.y = e.nativeEvent.contentOffset.y; },
      onContentSizeChange: (_w: number, h: number) => { at.current.content = h; },
      onLayout: (e: { nativeEvent: { layout: { height: number } } }) => { at.current.view = e.nativeEvent.layout.height; },
    },
  };
}

/** The head's "+": makes things of this computer only (a section's head has its own), and nothing while this computer's server is not
 *  connected. */
function HeadPlus({ make }: { make: Make }) {
  const t = useTokens();
  const connected = useStore((s) => s.connected);
  const [open, setOpen] = useState(false);
  const anchor = useRef<View>(null);
  const close = () => setOpen(false);
  const hidden = useSideHidden(close, open);
  return (
    <View ref={anchor} collapsable={false}>
      <IconButton {...tid("side-new")} filled title={connected ? "New…" : "New… (this computer's server is not connected)"} disabled={!connected} on={open} onPress={() => setOpen(!open)}>
        {(color) => <Text size={17} style={{ color, marginTop: -1 }}>+</Text>}
      </IconButton>
      {open && connected && !hidden && (
        <Overlay open onClose={close} label="New" kind="popover" anchor={anchor} align="right">
          <Still>
            <Menu>
              <MenuItem icon={<ChatIcon color={t.muted} />} label="New chat" onPress={() => { close(); later(() => void newChat({ group: UNGROUPED })); }} />
              <MenuItem icon={<BoardIcon color={t.accent} />} label="New whiteboard" onPress={() => { close(); later(() => make.board(UNGROUPED)); }} />
              <MenuSep />
              <MenuItem icon={<GroupIcon color={t.muted} />} label="New group" onPress={() => { close(); later(() => make.group(LOCAL_SERVER)); }} />
            </Menu>
          </Still>
        </Overlay>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  side: { flex: 1, minWidth: 0, minHeight: 0 },
  head: { flexDirection: "row", alignItems: "center", gap: 6, paddingRight: 8, paddingBottom: 8, paddingLeft: 14, minHeight: 46 },
  brand: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, overflow: "hidden", paddingRight: 6 },
  brandName: { flexShrink: 1 },
  tree: { flex: 1, minHeight: 0 },
  treeBody: { paddingTop: 2, paddingRight: 6, paddingBottom: 16, paddingLeft: 6 },
});
