// The bar of an open board on the phone (package B1, plans/ux-improvements/b1-design.md §4; goal 3.4): the back's chevron alone, the
// board's name as the title, the place (the board's nearest group, or its server's name at the root) and the state word beside it,
// and the labelled Chats button with its count. While an agent works on the board the word says so in the agent's colour and
// replaces the place. The wide layouts keep shell/BoardBar.tsx.
import { StyleSheet, View } from "react-native";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { reachable } from "@aiwb/core/logic/sections.ts";
import { serverName } from "@aiwb/core/logic/serverlists.ts";
import { boardWorker } from "@aiwb/core/logic/status.ts";
import { BOARD_WORDS, boardWord } from "@aiwb/core/logic/statewords.ts";
import { boardChats, groupPath } from "@aiwb/core/logic/tree.ts";
import { groupsOn } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { ContentBar } from "../../ui/Bars.tsx";
import { Button } from "../../ui/Button.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { StateWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { NavBack } from "../shell/BackButton.tsx";
import { B1_TID } from "./ids.ts";
import { openChatsSheet } from "./chatssheet.ts";
import { agentPaint } from "./Overlays.tsx";
import { usePickWait } from "./PickBar.tsx";

/** What the phone's bar and the landscape controls say of a board: its name, the place, the state word (in the agent's colour while
 *  one works), the number of its chats and whether one is busy. Null while the board is not known. */
export function useBoardBarModel(board: string) {
  const { tokens: t } = useTheme();
  const b = useStore((s) => s.boards[board]);
  const role = useStore((s) => s.roles[board]);
  const writer = useStore((s) => s.writers[board] ?? "");
  const groups = useStore((s) => groupsOn(s, serverOfKey(board)));
  const server = useStore((s) => serverName(s, serverOfKey(board)));
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  // (of a section's board whose server is not connected nothing is known: no agent is said to work on it)
  const worker = useStore((s) => boardWorker(s.chats, board, s.busyOn[board]?.agent, reachable(s, board))) ?? null;
  const waits = usePickWait(board); // a chat of the board waits for a point or for shapes: the word is the accent's and replaces the place
  if (!b) return null;
  const word = waits ? (waits.kind === "select" ? BOARD_WORDS.selecting : BOARD_WORDS.picking) : boardWord({ role, writer, archived: !!b.archived, worker });
  const paint = worker ? agentPaint(t, worker) : undefined;
  return {
    name: b.name, place: groupPath(groups, b.group).at(-1) ?? server, word, paint, colour: waits ? t.accent : paint?.main,
    count: boardChats(all, board, showArchived).length, busy: !!worker || !!waits, waits: !!waits,
  };
}

export function PhoneBoardBar({ board }: { board: string }) {
  const m = useBoardBarModel(board);
  if (!m) return null;
  return (
    <ContentBar testID={B1_TID.bar} back={<NavBack />} title={m.name} sub={m.busy ? undefined : m.place}
      state={<StateWord word={m.word} colour={m.colour} />}
      actions={<ChatsButton board={board} count={m.count} busy={m.busy} paint={m.paint} off={m.waits} />} />
  );
}

/** The count's badge is the accent, and the agent's colour while one of the board's chats is busy. */
export function ChatsButton({ board, count, busy, paint, off }: { board: string; count: number; busy: boolean; paint?: { main: string; on: string }; off?: boolean }) {
  const { tokens: t } = useTheme();
  return (
    <Button {...tid(B1_TID.chats, { count, busy: busy && !off, off: off || undefined })} size="touch" disabled={off} style={off ? styles.off : undefined}
      accessibilityLabel={count ? `Chats, ${count}` : "Chats"} onPress={() => openChatsSheet(board)}>
      <Text size={TYPE.control}>Chats</Text>
      {count > 0 ? (
        <View style={[styles.badge, { backgroundColor: paint?.main ?? t.accentFill }]}>
          <Text size={TYPE.secondary} weight="600" style={{ color: paint?.on ?? t.onAccent }}>{count}</Text>
        </View>
      ) : null}
    </Button>
  );
}

const styles = StyleSheet.create({
  off: { opacity: 0.45 },
  badge: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, alignItems: "center", justifyContent: "center" },
});
