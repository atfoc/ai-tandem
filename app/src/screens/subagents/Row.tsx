// A subagent in the thread (the old page's Subagents.tsx SubagentRow, SubBranch, SubRow, SubResultRow): the one-line row where the Agent / Task /
// spawn_subagent call is, with the rows of the subagents it started under it, and the line that carries a subagent's result. Both are
// buttons that open that subagent in the drawer; a second press on the open one closes it (B-SA-09).
import { useState } from "react";
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";

import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { subagentOf, subChildren, subLine, subResultLine, subStatus, subWaiting } from "@aiwb/core/logic/subagents.ts";
import { boardNames, inTurn, subsOf } from "@aiwb/core/state/store.ts";
import type { ChatView, Item, Subagent } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { useNow, useSubNav, useSubThread } from "./hooks.ts";
import { SubMark, SubName, SubStats } from "./Parts.tsx";

/** How many levels of nested rows are drawn under a row: more than a chat's depth can be, a guard against a loop in the records. */
const MAX_NESTED_ROWS = 8;

/** Below this width the row's stats go under its line instead of beside it. */
const NARROW = 400;

/** The one-line row in the thread where the call is, and under it the rows of the subagents that one started, each with its own under it.
 *  within: the subagent whose thread the call is in (the drawer); none in the chat's thread. */
export function SubagentRow({ item, chat, within }: { item: Item; chat: ChatView; within?: Subagent }) {
  const subs = useStore((s) => subsOf(s, chat.id));
  // a call not linked yet runs only while its caller's turn does
  const sa = subagentOf(item, subs, within ? within.status === "running" && !within.waiting : inTurn(chat.status));
  return <SubBranch it={item} sa={sa} chat={chat} />;
}

/** A subagent's row with the rows of the ones it started under it. it: the call that started it, or what is known of that call when its
 *  thread is not at hand (a nested one's is in its parent's). */
function SubBranch({ it, sa, chat, level = 0 }: { it: Item; sa: Subagent; chat: ChatView; level?: number }) {
  const t = useTokens();
  const subs = useStore((s) => subsOf(s, chat.id));
  const started = level < MAX_NESTED_ROWS ? subChildren(subs, sa.id) : [];
  const row = <SubRow it={it} sa={sa} chat={chat} />;
  if (!started.length) return row;
  return (
    <View {...tid("sub-tree")} style={styles.tree}>
      {row}
      <View {...tid("sub-children")} style={[styles.children, { borderLeftColor: t.line }]}>
        {started.map((x) => <SubBranch key={x.id} it={{ kind: "tool", toolId: x.tool }} sa={{ ...x, status: subStatus(x) }} chat={chat} level={level + 1} />)}
      </View>
    </View>
  );
}

/** One subagent's row. One at work loads its thread for the live line; a waiting or a finished one needs only its state. */
function SubRow({ it, sa, chat }: { it: Item; sa: Subagent; chat: ChatView }) {
  const t = useTokens();
  const subs = useStore((s) => subsOf(s, chat.id));
  const { on, toggle } = useSubNav(chat.id, sa.id);
  const waiting = subWaiting(sa);
  const items = useSubThread(chat.id, sa.id, sa.status === "running" && !waiting);
  const now = useNow(sa.status === "running");
  const server = serverOf(chat);
  const line = subLine(it, sa, items, boardNames(chat.id), subs);
  const [narrow, setNarrow] = useState(false);
  const open = () => { if (sa.id) toggle(); }; // not linked yet: nothing to open
  const measure = (e: LayoutChangeEvent) => { const n = e.nativeEvent.layout.width < NARROW; setNarrow((was) => (was === n ? was : n)); };
  const stats = <SubStats sa={sa} items={items} now={now} server={server} wrap={narrow} />;
  return (
    <Pressable {...tid("sub-row", { status: sa.status, waiting, on, sub: sa.id })} role="button" aria-pressed={on} accessibilityLabel={sa.description || "Subagent"} onPress={open} onLayout={measure}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [
        styles.row, { backgroundColor: on ? t.accentSoft : t.panel, borderColor: on ? t.accent : hovered ? t.line2 : t.line }, webStyle({ cursor: "pointer", userSelect: "none" }),
      ]}>
      <SubMark status={sa.status} waiting={waiting} />
      <View style={styles.main}>
        <SubName sa={sa} />
        <Text {...tid("sub-line", { tone: line.tone })} size={11} numberOfLines={1} style={{ color: line.tone === "live" ? t.ok : line.tone === "error" ? t.danger : t.muted }}>{line.text}</Text>
        {narrow ? <View style={styles.under}>{stats}</View> : null}
      </View>
      {narrow ? null : stats}
    </Pressable>
  );
}

/** The row of a subagent's result the app carried to the agent, or in a subagent's thread to that subagent: a system line, not a message.
 *  Its state is the subagent's, so it follows a later change with no change to the item. A press opens the subagent whose result it is. */
export function SubResultRow({ item, chat }: { item: Item; chat: ChatView }) {
  const t = useTokens();
  const sid = item.subagent ?? "";
  const sa = useStore((s) => subsOf(s, chat.id)?.[sid]);
  const { on, toggle } = useSubNav(chat.id, sid);
  const line = subResultLine(sa);
  const open = () => { if (sa) toggle(); };
  return (
    <Pressable {...tid("sub-result", { tone: line.tone, on, sub: sid })} role="button" aria-pressed={on} onPress={open} style={[styles.result, webStyle({ cursor: "pointer", userSelect: "none" })]}>
      {({ hovered }: { hovered?: boolean; pressed: boolean }) => (
        <Text size={12} numberOfLines={1} style={{ color: line.tone === "error" ? t.danger : t.muted }}>
          Subagent result · <Text size={12} weight="600" style={{ color: hovered || on ? t.accent : t.text }}>{line.name}</Text>{line.text ? ` · ${line.text}` : ""}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tree: { rowGap: 4, minWidth: 0 },
  children: { rowGap: 4, minWidth: 0, marginLeft: 15, paddingLeft: 8, borderLeftWidth: 1 },
  row: { flexDirection: "row", alignItems: "center", columnGap: 8, paddingVertical: 6, paddingHorizontal: 9, borderWidth: 1, borderRadius: 7, minWidth: 0, alignSelf: "stretch" },
  main: { flex: 1, minWidth: 0 },
  under: { flexDirection: "row", marginTop: 2, minWidth: 0 },
  result: { paddingHorizontal: 2, minWidth: 0 },
});
