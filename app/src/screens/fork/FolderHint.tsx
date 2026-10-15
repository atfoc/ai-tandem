// The "agents working in this folder" hint: the line in the tree popup's foot (the old page's fork/FolderHint.tsx; B-TR-19). It reads every branch's record,
// so it is a component of its own: only it draws again when some branch of some chat changes its state.
import { useMemo } from "react";
import { StyleSheet, View } from "react-native";

import { branchKey, currentBranch, stateFromView, stateOf } from "@aiwb/core/logic/branches.ts";
import { folderAgents, folderName } from "@aiwb/core/logic/folderagents.ts";
import { viewedBranch, type State } from "@aiwb/core/state/store.ts";
import type { BranchState, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";

/** Every branch's record: the ones kept, and for a chat whose current branch has none (a server that sends no records) the view's own. */
function allStates(chats: Record<string, ChatView>, states: State["states"]): BranchState[] {
  const all = Object.values(states);
  for (const c of Object.values(chats)) if (!states[branchKey(c.id, currentBranch(c))]) all.push(stateFromView(c));
  return all;
}

/** In the tree popup's foot: every agent working in the viewed branch's folder, its own too. Shown from two on: one agent alone shares the folder
 *  with nobody. */
export function TreeFolderHint({ chatId }: { chatId: string }) {
  const t = useTokens();
  const chats = useStore((s) => s.chats);
  const states = useStore((s) => s.states);
  const cwd = useStore((s) => stateOf(s.states, s.chats[chatId], viewedBranch(s, chatId))?.cwd ?? s.chats[chatId]?.cwd);
  const fa = useMemo(() => folderAgents({ chats, states: allStates(chats, states), cwd, chat: chatId }), [chats, states, cwd, chatId]);
  if (fa.total < 2 || !cwd) return null;
  return (
    <View {...tid("fk-folder-agents")} style={styles.row}>
      <View style={[styles.dot, { backgroundColor: t.warn }]} />
      <Text size={11.5} tone="muted" style={styles.text}>
        {`${fa.total} agents working in ${folderName(cwd)}${fa.elsewhere > 0 ? `: ${fa.here} in this chat, ${fa.elsewhere} in other chats` : ""}`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 5, minWidth: 0 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { flexShrink: 1 },
});
