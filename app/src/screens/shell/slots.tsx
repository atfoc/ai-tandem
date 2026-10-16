// The places of the shell that the screens of the other packages fill. The shell lays the window out (the panes, the rail, the
// stack, Home, the board's bar); what goes inside a pane is the screen's, and a screen package registers itself with
// `setSlot` from its own `screens/<area>/index.ts`, which `screens/register.ts` imports. Until it does a slot draws a stand-in
// that carries the testID the checks' helpers wait for (`side-tree`, `chat-head`, `board-canvas`), so the shell and its checks
// run on their own.
//
//   Sidebar         S1: the sidebar's whole content (its head with `SideHideButton`, the sections, the foot). It fills the side pane
//                   on the wide layouts and is the first screen of the phone's stack.
//   ChatView        S4 (with K3's composer): one chat's header, thread and composer; given the chat's id. On the phone it is the
//                   screen over the chat's board or over the list.
//   Canvas          B4: the board screen's canvas, under the shell's `BoardBar`; given the board's id.
//   SubagentDrawer  S7: the drawer of a subagent (beside the page on the wide layouts, a pushed screen on the phone).
//   Overlays        the popups that are always mounted and show themselves from the store (the chat tree, the prompt library's
//                   popups, the Servers dialog): each one a component with no props.
import { useSyncExternalStore, type ComponentType } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { openBoard, openChat } from "./nav.ts";
import { ServersButton } from "../servers/ServersButton.tsx";
import { SideHideButton } from "./SideRail.tsx";

export type Slots = {
  Sidebar: ComponentType;
  ChatView: ComponentType<{ chat: string }>;
  Canvas: ComponentType<{ board: string }>;
  SubagentDrawer: ComponentType;
  Overlays: ComponentType[];
};

const Nothing = () => null;

/** The stand-in sidebar: the head's hide control, the foot's Servers button (S3's, so that the checks reach the dialog) and one flat row for each board and chat of the store, with the testID and the
 *  `dataSet { kind, key }` the checks' helpers read (`side-row`, `aria-selected` on the open one). S1's sidebar replaces it. */
function StandInSidebar() {
  const { tokens: t } = useTheme();
  const boards = useStore((s) => s.boards);
  const chats = useStore((s) => s.chats);
  const sel = useStore((s) => s.sel);
  return (
    <View {...tid("side-tree")} style={[styles.fill, { backgroundColor: t.panel }]}>
      <View style={styles.head}><SideHideButton /></View>
      <View style={styles.foot}><ServersButton /></View>
      <ScrollView>
        {Object.entries(boards).map(([key, b]) => (
          <Pressable key={"b" + key} {...tid("side-row", { kind: "board", key })} accessibilityState={{ selected: sel.board === key }} aria-selected={sel.board === key}
            style={styles.row} onPress={() => openBoard(key)}><Text numberOfLines={1}>{b.name}</Text></Pressable>
        ))}
        {Object.entries(chats).map(([key, c]) => (
          <Pressable key={"c" + key} {...tid("side-row", { kind: "chat", key })} accessibilityState={{ selected: sel.chat === key }} aria-selected={sel.chat === key}
            style={styles.row} onPress={() => openChat(c)}><Text numberOfLines={1}>{c.name}</Text></Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function StandInChat({ chat }: { chat: string }) {
  return (
    <View testID="chat-head" dataSet={{ chat }} style={styles.standIn}>
      <Text tone="muted" size={12}>{chat}</Text>
    </View>
  );
}

function StandInCanvas({ board }: { board: string }) {
  return (
    <View testID="board-canvas" dataSet={{ board }} style={styles.fill}>
      <Text tone="muted" size={12} style={styles.standIn}>{board}</Text>
    </View>
  );
}

let slots: Slots = { Sidebar: StandInSidebar, ChatView: StandInChat, Canvas: StandInCanvas, SubagentDrawer: Nothing, Overlays: [] };
const listeners = new Set<() => void>();

/** Registers a screen in a slot (once, at import: before the first render). `Overlays` adds to the list. */
export function setSlot<K extends keyof Slots>(name: K, component: K extends "Overlays" ? ComponentType : Slots[K]): void {
  slots = name === "Overlays" ? { ...slots, Overlays: [...slots.Overlays, component as ComponentType] } : { ...slots, [name]: component };
  for (const l of listeners) l();
}

/** The slots now. */
export function useSlots(): Slots {
  return useSyncExternalStore((l) => { listeners.add(l); return () => { listeners.delete(l); }; }, () => slots);
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", paddingHorizontal: 8, paddingTop: 10 },
  standIn: { padding: 12 },
  row: { paddingVertical: 6, paddingHorizontal: 12 },
  foot: { flexDirection: "row", paddingHorizontal: 8, paddingVertical: 6 },
});
