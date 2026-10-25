// A chat's thread (the old page's ChatView.tsx's Thread): the items of the branch it shows, cut at the point of a pending move, with a mark
// where the part shared with its source ends; what is on its way in the chat (State.waits) as logic/waits.ts threadWait decides; and,
// for a chat on a server that is not connected, the warning under the thread that stays or the sentence in its place.
//
// The thread is a LegendList (AD-75, goal 4.8): only the rows near the window are mounted, a row's height is measured as it is drawn,
// and while an answer streams only its last Markdown block is drawn again (screens/markdown). It opens at its end and follows the
// end while the user has not scrolled up; scrolled up (more than 40 px from the end) it stays where the user put it, and scrolling
// back to within 40 px follows again (scroll.ts, B-SM-06 to B-SM-09).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, View } from "react-native";

import { statusText, waitingText } from "@aiwb/core/logic/labels.ts";
import { inSection, serverOfKey } from "@aiwb/core/logic/keys.ts";
import { prefixText } from "@aiwb/core/logic/prefix.ts";
import { remoteView } from "@aiwb/core/logic/remoteview.ts";
import { serverConnected, serverName, serverState } from "@aiwb/core/logic/serverlists.ts";
import { threadWait } from "@aiwb/core/logic/waits.ts";
import { boardNames, inTurn, shownBranch, shownView, threadOf } from "@aiwb/core/state/store.ts";
import { openChat } from "../shell/nav.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { BranchIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { usePhone } from "../../ui/useLayout.ts";
import { Dots } from "./Dots.tsx";
import { EmptyThread } from "./Empty.tsx";
import { ItemView, UserSaid, phoneBubble } from "./ItemView.tsx";
import { RemoteBar, RemoteOff, useBackOnline } from "./Remote.tsx";
import { usePrefixEnd } from "./hooks.ts";
import { threadRows, isShort, type GroupItem, type Row } from "./rows.ts";
import { useChatParts } from "./parts.tsx";
import { foldOf } from "@aiwb/core/logic/steps.ts";
import { StickyList, THREAD_KEYBOARD, type ListHandle } from "./StickyList.tsx";
import { registerThreadScroller } from "./threadscroll.ts";
import { T2_TID } from "../tools/ids.ts";
import { clearViewable, setViewable } from "./threadview.ts";

const EMPTY: Item[] = [];
const GAP = 8;
const PHONE_GAP = 12;

export function Thread({ chatId }: { chatId: string }) {
  const c = useStore((s) => shownView(s, chatId));
  const loaded = useStore((s) => threadOf(s, chatId));
  const branch = useStore((s) => shownBranch(s, chatId));
  const cut = useStore((s) => s.moves[chatId]?.at);
  const all = loaded?.items ?? EMPTY;
  const items = useMemo(() => (cut === undefined ? all : all.slice(0, cut)), [all, cut]);
  const end = usePrefixEnd(chatId);
  // A chat of a section: what its thread's place shows while that server is not connected, or no longer has the chat.
  const server = serverOfKey(chatId);
  const serverIs = useStore((s) => serverName(s, server));
  const state = useStore((s) => serverState(s, server));
  const connected = useStore((s) => serverConnected(s, server));
  const gone = useStore((s) => !!s.gone[chatId]);
  const loadErr = useStore((s) => s.threadErrors[chatId]);
  const waits = useStore((s) => s.waits[chatId]);
  const forkedFrom = useStore((s) => !!s.chats[chatId]?.forkedFrom);
  const phone = usePhone();
  useBackOnline(chatId);
  if (!c) return null;
  const busy = inTurn(c.status); // a chat that waits for its background work is not in a turn: its foot is the waiting row
  const waiting = waitingText(c); // "" while in a turn
  const wait = threadWait(waits, { shown: branch, loaded: !!loaded, count: all.length, move: cut !== undefined, busy, server: inSection(chatId) ? serverIs : "", archived: !!c.archived });
  // (the history a wait keeps stands for the list: what is said of a server that is not connected is said beside it)
  const remote = remoteView({ connected, gone }, serverIs, state, !!loaded || !!wait.kept, loadErr);
  // Under the warning the thread is as the app had it when the connection ended (or when the chat went there): nothing in it is live,
  // and nothing in it takes a press that would ask the server: a message's actions and a permission request's answer are off by the
  // chat's own state (useOffWhy), here and in the subagent pane.
  const frozen = remote.kind === "bar";
  const pad = phone ? PHONE.margin : c.board ? 14 : 20;
  if (remote.kind !== "none" && remote.kind !== "bar") return (
    <View {...tid("thread", { chat: chatId })} style={styles.fill}>
      <RemoteOff kind={remote.kind} text={remote.text} state={remote.kind === "unreachable" ? remote.state : undefined} chatId={chatId} />
    </View>
  );
  const rows = threadRows({
    forked: forkedFrom, loaded: !!loaded, items, kept: wait.kept, branch, end, sent: wait.sent,
    typing: busy && !frozen && !wait.quiet && c.status !== "approval" && c.status !== "writing" ? statusText(c, boardNames(chatId)) : "",
    waiting: waiting && !frozen ? waiting : "",
    lines: wait.lines,
    fold: phone ? foldOf : undefined,
  });
  return (
    <View {...tid("thread", { chat: chatId, branch })} style={styles.fill}>
      {isShort(rows)
        ? <ShortThread rows={rows} chat={c} gone={gone} branch={branch} end={end} pad={pad} />
        : <ThreadList rows={rows} chat={c} gone={gone} branch={branch} end={end} pad={pad} />}
      {remote.kind === "bar" && <View style={{ paddingHorizontal: pad, paddingBottom: 6 }}><RemoteBar text={remote.text} state={remote.state} gone={remote.gone} /></View>}
    </View>
  );
}

type ListProps = { rows: Row[]; chat: ChatView; gone: boolean; branch: string; end: number; pad: number };

/** A thread with nothing to scroll through but the empty state, the note of a fork and the lines at the foot. */
function ShortThread({ rows, chat, gone, branch, end, pad }: ListProps) {
  const phone = usePhone();
  const row = phone ? styles.rowPhone : styles.row; // (the phone's rows carry the side margin)
  // nothing to scroll: every row is in view (the permission dock reads it)
  const keys = rows.map((r) => r.key).join("\n");
  useEffect(() => {
    if (!phone) return;
    setViewable(chat.id, keys ? keys.split("\n") : []);
    return () => clearViewable(chat.id);
  }, [phone, chat.id, keys]);
  return (
    <ScrollView {...tid("thread-scroll")} {...(phone ? THREAD_KEYBOARD : undefined)} style={styles.fill} contentContainerStyle={[styles.short, { paddingHorizontal: phone ? 0 : pad, paddingTop: pad - 6 }]}>
      {/* (the phone's empty thread fills the height: its starters stand at the foot, right above the composer, package C2) */}
      {rows.map((r) => <View key={r.key} style={[row, phone && r.kind === "empty" && styles.grow]}><RowView row={r} chat={chat} gone={gone} branch={branch} end={end} /></View>)}
    </ScrollView>
  );
}

/** The thread: a sticky list of its rows. */
function ThreadList({ rows, chat, gone, branch, end, pad }: ListProps) {
  const phone = usePhone();
  const render = useCallback((row: Row) => <View style={phone ? styles.rowPhone : styles.row}><RowView row={row} chat={chat} gone={gone} branch={branch} end={end} /></View>, [chat, gone, branch, end, phone]);
  // what brings a message to the middle of the window for a quote that points at it (K5): the item rows are keyed by the branch and their place
  const list = useRef<ListHandle | null>(null);
  const onList = useCallback((l: ListHandle | null) => { list.current = l; }, []);
  useEffect(() => registerThreadScroller(chat.id, { toItem: (index, animated) => list.current?.scrollToKey(`${branch}:${index}`, animated) ?? false }), [chat.id, branch]);
  // the keys in view, for the permission dock (the phone only); gone with the thread
  const onViewable = useCallback((keys: string[]) => setViewable(chat.id, keys), [chat.id]);
  useEffect(() => (phone ? () => clearViewable(chat.id) : undefined), [phone, chat.id]);
  return <StickyList rows={rows} renderRow={render} resetKey={`${chat.id}:${branch}`} pad={pad} padX={phone ? 0 : undefined} onList={onList} latest={phone} tail={phone ? lastItem(rows) : undefined} onViewable={phone ? onViewable : undefined} />;
}

/** The item of the thread's last item row: another object whenever that message changed or another came after it (the Latest pill's news). */
function lastItem(rows: readonly Row[]): Item | undefined {
  for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (r.kind === "item") return r.item; }
  return undefined;
}

/** Whether two rows draw the same: an item row by its item (the store keeps an item that did not change), the others by their fields. */
function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "item" && b.kind === "item") return a.item === b.item && a.index === b.index && a.readOnly === b.readOnly;
  if (a.kind === "sending" && b.kind === "sending") return a.said === b.said;
  if (a.kind === "group" && b.kind === "group") return a.group === b.group && a.readOnly === b.readOnly && a.items.length === b.items.length && a.items.every((x, n) => x.item === b.items[n].item && x.index === b.items[n].index);
  return JSON.stringify(a) === JSON.stringify(b);
}

const RowView = memo(function RowView({ row, chat, gone, branch, end }: { row: Row; chat: ChatView; gone: boolean; branch: string; end: number }) {
  switch (row.kind) {
    case "forked": return <ForkedFrom chat={chat} />;
    case "empty": return <EmptyThread c={chat} gone={gone} />;
    case "item": return <ItemView item={row.item} chat={chat} branch={branch} index={row.index} readOnly={row.readOnly} />;
    case "group": return <GroupView row={row} chat={chat} branch={branch} />;
    case "mark": return <PrefixEnd at={end} branch={branch} />;
    case "sending": return <SendingMessage chat={chat} said={row.said} />;
    case "typing": return <Line kind="typing" text={row.text} dots />;
    case "waiting": return <Line kind="typing" text={row.text} />;
    case "wait": return <Line kind="wait-line" text={row.text} id={row.id} dots />;
  }
}, (a, b) => sameRow(a.row, b.row) && a.chat === b.chat && a.gone === b.gone && a.branch === b.branch && a.end === b.end);

/** A run of items folded into one row on the phone (ux T2): the steps that only read, or a call's subagents. */
function GroupView({ row, chat, branch }: { row: Extract<Row, { kind: "group" }>; chat: ChatView; branch: string }) {
  const parts = useChatParts();
  const renderItem = useCallback((x: GroupItem) => <ItemView item={x.item} chat={chat} branch={branch} index={x.index} readOnly={row.readOnly} />, [chat, branch, row.readOnly]);
  const Group = row.group === "steps" ? parts.StepGroup : parts.SubagentGroup;
  return <Group chat={chat} branch={branch} items={row.items} readOnly={row.readOnly} renderItem={renderItem} />;
}

/** A line at the thread's foot that says what goes on ("Thinking…", "Starting the agent…"). */
function Line({ kind, text, id, dots }: { kind: "typing" | "wait-line"; text: string; id?: string; dots?: boolean }) {
  const phone = usePhone();
  if (phone && kind === "typing" && dots) return <BusyLine text={text} />;
  return (
    <View {...tid(kind, id ? { wait: id } : undefined)} style={styles.line}>
      {dots && <Dots />}
      <Text size={12} tone="muted">{text}</Text>
    </View>
  );
}

/** The busy line on the phone (ux T2): a spinner, the words at 15 pt and the seconds since this app saw them appear ("· 12 s"; none in the
 *  first second). The seconds are the app's own count, started again whenever the words change. */
function BusyLine({ text }: { text: string }) {
  const t = useTokens();
  const since = useRef({ text, at: Date.now() });
  if (since.current.text !== text) since.current = { text, at: Date.now() };
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(id); }, []);
  const seconds = Math.floor((Date.now() - since.current.at) / 1000);
  return (
    <View {...tid("typing")} style={styles.busy}>
      <ActivityIndicator size="small" color={t.muted} />
      <Text size={TYPE.busy} tone="muted">
        {text}
        {seconds > 0 && <Text {...tid(T2_TID.busySeconds)} size={TYPE.busy} tone="muted">{` · ${seconds} s`}</Text>}
      </Text>
    </View>
  );
}

/** A message that was sent and is in no list yet, in the pending look (logic/waits.ts). */
function SendingMessage({ chat, said }: { chat: ChatView; said: NonNullable<Parameters<typeof UserSaid>[0]["said"]> }) {
  const t = useTokens();
  return (
    <View {...tid("msg", { role: "user", sending: true })} style={[styles.sending, usePhone() && phoneBubble, { backgroundColor: t.accentSoft }]}>
      <UserSaid chat={chat} said={said} />
    </View>
  );
}

/** The line that marks where the part copied from the thread's source ends (B-TH-12). */
function PrefixEnd({ at, branch }: { at: number; branch: string }) {
  const t = useTokens(), phone = usePhone();
  return (
    <View {...tid("prefix-end", { at })} style={styles.mark}>
      <View style={[styles.rule, { backgroundColor: t.line }]} />
      <Text size={phone ? TYPE.secondary : 11} tone="muted">{prefixText(branch)}</Text>
      <View style={[styles.rule, { backgroundColor: t.line }]} />
    </View>
  );
}

/** The note that the chat was forked from another (B-TH-13); the title opens the source chat when it still exists. */
function ForkedFrom({ chat }: { chat: ChatView }) {
  const t = useTokens(), small = usePhone() ? TYPE.secondary : 12;
  const src = useStore((s) => (chat.forkedFrom ? s.chats[chat.forkedFrom] : undefined));
  if (!chat.forkedFrom) return null;
  const title = chat.forkedFromTitle || "another chat";
  return (
    <View {...tid("forked-from")} style={[styles.forked, { backgroundColor: t.panel, borderColor: t.line }]}>
      <Text size={small} tone="muted">
        <BranchIcon color={t.muted} /> Forked from{" "}
        {src
          ? <Text {...tid("forked-from-link")} size={small} tone="accent" accessibilityRole="link" onPress={() => openChat(src)}>{title}</Text>
          : <Text size={small} weight="600">{title}</Text>}
        . The history below was copied; this chat has its own agent session.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  row: { paddingBottom: GAP },
  rowPhone: { paddingBottom: PHONE_GAP, paddingHorizontal: PHONE.margin },
  short: { flexGrow: 1, justifyContent: "center" },
  grow: { flexGrow: 1 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, padding: 2 },
  busy: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 28 },
  sending: {
    alignSelf: "flex-end", maxWidth: "88%", minWidth: 0, paddingVertical: 7, paddingHorizontal: 11, opacity: 0.7,
    borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomRightRadius: 3, borderBottomLeftRadius: 12,
  },
  mark: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 2 },
  rule: { flex: 1, height: 1 },
  forked: { borderWidth: 1, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 10 },
});
