// The bar of an open board: the crumb ("Section / Group / Subgroup / Board"), the archived note, the "Chats N" button that shows the
// chat panel, and "+ Chat on this board" (the old page's App.tsx `BoardBar`, without the canvas that lies under it).
import { Fragment } from "react";
import { StyleSheet, View } from "react-native";

import { reachable } from "@aiwb/core/logic/sections.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { sectionName } from "@aiwb/core/logic/serverlists.ts";
import { boardChats, groupPath } from "@aiwb/core/logic/tree.ts";
import { groupsOn, setState } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { keyPlatform } from "./keyplatform.ts";
import { newChat, openBoard } from "./nav.ts";

export function BoardBar({ board, chatOpen, leading }: { board: string; chatOpen: boolean; leading?: React.ReactNode }) {
  const { tokens: t } = useTheme();
  const b = useStore((s) => s.boards[board]);
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const groups = useStore((s) => groupsOn(s, serverOfKey(board))); // the board's path is in the groups of its own server
  const section = useStore((s) => sectionName(s, board)); // the server of a section's board, before its path
  const can = useStore((s) => reachable(s, board)); // a board whose server is not connected, or no longer has it, takes no new chat
  const selChat = useStore((s) => s.sel.chat);
  if (!b) return null;
  const chats = boardChats(all, board, showArchived);
  const showChats = () => {
    if (!(selChat && all[selChat]?.board === board)) openBoard(board, false, true);
    setState({ panel: true });
  };
  const path = [...(section ? [section] : []), ...groupPath(groups, b.group)];
  const mac = /Mac|iPhone|iPad/.test(keyPlatform());
  return (
    <View {...tid("board-bar")} style={[styles.bar, { borderBottomColor: t.line }]}>
      {leading}
      <View {...tid("board-crumb")} style={styles.crumb}>
        {path.map((name, i) => (
          <Fragment key={i}>
            <Text tone="muted" numberOfLines={1}>{name}</Text><Text tone="faint">/</Text>
          </Fragment>
        ))}
        <BoardIcon color={t.accent} />
        <Text weight="600" numberOfLines={1} style={styles.name}>{b.name}</Text>
      </View>
      {b.archived && <Text {...tid("archived-note")} size={12} tone="muted" style={styles.archived}>Archived — read-only</Text>}
      <View style={styles.grow} />
      {!chatOpen && chats.length > 0 && (
        <Button {...tid("board-chats")} tone="ghost" size="sm" style={styles.centred} title={`Show chat (${mac ? "⌘J" : "Ctrl+J"})`} onPress={showChats}>
          <View style={styles.chats}>
            <Text size={12}>Chats</Text>
            <View style={[styles.pill, { backgroundColor: t.accentFill }]}><Text size={10} tone="onAccent">{chats.length}</Text></View>
          </View>
        </Button>
      )}
      {!b.archived && can && <Button {...tid("board-new-chat")} size="sm" style={styles.centred} label="+ Chat on this board" onPress={() => void newChat({ board })} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { height: 40, flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 14, paddingRight: 10, borderBottomWidth: 1 },
  crumb: { flexShrink: 1, flexDirection: "row", alignItems: "center", gap: 5, overflow: "hidden" },
  name: { flexShrink: 1 },
  archived: { fontStyle: "italic" },
  grow: { flex: 1 },
  centred: { alignSelf: "center" },
  chats: { flexDirection: "row", alignItems: "center", gap: 4 },
  pill: { minWidth: 16, paddingHorizontal: 5, borderRadius: 8, alignItems: "center" },
});
