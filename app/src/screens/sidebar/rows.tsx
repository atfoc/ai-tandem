// The rows of a server's tree: a group and, inside it, its subgroups, boards and plain chats; a board with its own chats; a chat
// (the old page's Sidebar.tsx GroupNode, BoardNode, ChatRow, TreeRows). Every section draws its tree with these, so with the same rows.
import React, { createContext, memo, useContext, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";

import { api } from "@aiwb/core/api.ts";
import { dotState, rowLine } from "@aiwb/core/logic/labels.ts";
import { catalogFor } from "@aiwb/core/logic/agentlist.ts";
import { BOARD_MENU_LABEL, boardMenu, moveTargets, type BoardMenuItem } from "@aiwb/core/logic/boardrow.ts";
import { chatHasDraft, otherDrafts } from "@aiwb/core/logic/drafts.ts";
import { serverOf } from "@aiwb/core/logic/serverlists.ts";
import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { chatBusy } from "@aiwb/core/logic/status.ts";
import { boardChats, contents, groupPath, treeEmpty, type GroupTree, type Tree } from "@aiwb/core/logic/tree.ts";
import { boardNames, chatTitle, groupsOn, isLegacy, statesOfChat, threadOf, upsertBoard, viewedBranch } from "@aiwb/core/state/store.ts";
import type { Board, ChatView } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { AgentGlyph, BoardIcon, ChatIcon, GroupIcon, agentClass } from "../../ui/icons.tsx";
import { MenuItem } from "../../ui/Menu.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid, type DataSet } from "../../ui/tid.ts";
import { boardApp } from "../shell/boardside.ts";
import { attempt, newChat, openBoard, openChat } from "../shell/nav.ts";
import { archiveBoard, archiveGroup, deleteBoard, deleteChat, deleteGroup, isCollapsed, renameChat, renameGroup, setCollapsed } from "./actions.ts";
import { useDragGesture, useIsDragged, usePlace } from "./drag.tsx";
import { AddChat, AddMenu, RowMenu, later, type RowItem } from "./menus.tsx";
import { subline } from "./subline.ts";
import { ArchivedTag, BranchBadge, Caret, DisabledTag, DraftTag, Frame, InlineName, Line, NewDot, PressArea, PressFrame, StatusDot, useDoublePress, Text } from "./parts.tsx";

/** What the rows share: which row is in rename mode, and what a "+" makes (a board or a group, its row in rename mode). */
export type Edit = { editing: string | null; setEditing: (k: string | null) => void };
export type Make = { board: (group: string) => void; group: (server: string, parent?: string) => void };

/** A row inside an archived group is not faded again (the group is). */
const InArchived = createContext(false);

// ---------------------------------------------------------------- the tree

/** The rows of one server's tree: what is in no group first (a drop zone: the server's ungrouped area), then its groups. loose: the
 *  key of the server's ungrouped area. empty: what stands in the ungrouped area of a tree that holds nothing. */
export function TreeRows({ tree, loose, editing, setEditing, make }: Edit & { tree: Tree; loose: string; make: Make }) {
  return (
    <>
      <Zone group={loose} testID="side-loose" style={styles.loose}>
        {tree.loose.boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
        {tree.loose.chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
      </Zone>
      {tree.groups.map((n) => <GroupNode key={n.group.id} n={n} depth={0} editing={editing} setEditing={setEditing} make={make} />)}
    </>
  );
}

/** A place things are dropped in: a group or a server's ungrouped area. It is lit while the drop mark names it (logic/dropmark.ts). */
function Zone({ group, testID, data, style, children }: { group: string; testID: string; data?: DataSet; style?: object; children: React.ReactNode }) {
  const t = useTokens();
  const over = useStore((s) => s.dropAt.zone === group);
  const place = usePlace("zone", group);
  return (
    <View ref={place} collapsable={false} {...tid(testID, { group, ...data, drop: over || undefined })} style={[styles.zone, style, over && { backgroundColor: t.accentSoft, boxShadow: `inset 0 0 0 1px ${t.accent}` } as object]}>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------- a group

/** A group and, nested inside it, its subgroups (first), boards and plain chats. depth 0 is the top level of its server's tree. A group
 *  of a section is renamed, moved, nested, archived and deleted as a local one, on its server; only its collapse is this app's own. */
function GroupNode({ n, depth, editing, setEditing, make }: Edit & { n: GroupTree; depth: number; make: Make }) {
  const t = useTokens();
  const { group: g, boards, chats, children } = n;
  const server = serverOfKey(g.id);
  const all = useStore((s) => s.chats);
  const groups = useStore((s) => groupsOn(s, server));
  const showArchived = useStore((s) => s.showArchived);
  const dropBefore = useStore((s) => s.dropAt.before === g.id);
  const collapsed = useStore((s) => isCollapsed(s, g));
  const inArchived = useContext(InArchived);
  const inside = contents(n);
  const count = inside.boards.length + inside.chats.length;
  const working = inside.chats.some(chatBusy) || inside.boards.some((b) => boardChats(all, b.id, showArchived).some(chatBusy));
  const rename = (v: string) => { setEditing(null); renameGroup(g, v); };
  const press = useDoublePress(() => setCollapsed(g.id, !collapsed), () => { if (!g.archived) setEditing("group:" + g.id); });
  const menu: RowItem[] = g.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the group", () => api.unarchive("groups", g.id)) },
       { label: "Delete", tone: "danger", run: () => deleteGroup(g) }]
    : [{ label: "Rename", run: () => setEditing("group:" + g.id) },
       { label: "Archive", run: () => archiveGroup(g) },
       { label: "Delete", tone: "danger", run: () => deleteGroup(g) }];
  const title = groupPath(groups, g.id).join(" / ");
  const head = usePlace("head", g.id);
  const dragged = useIsDragged("group:" + g.id);
  const gesture = useDragGesture(editing !== "group:" + g.id, () => ({ kind: "group", id: g.id, title: g.name, server }));
  return (
    <InArchived.Provider value={inArchived || !!g.archived}>
      <Zone group={g.id} testID="side-group" data={{ depth, archived: g.archived || undefined }} style={[styles.group, depth > 0 && styles.groupSub, g.archived && !inArchived && styles.faded]}>
        {/* a group dropped on the top part of the header goes before this group; lower, into it (the zone) */}
        <GestureDetector gesture={gesture} touchAction="pan-y">
        <Frame title={title} place={head} {...tid("side-group-head", { group: g.id, depth, dropBefore: dropBefore || undefined })} style={(hovered) => [styles.groupHead, depth > 0 && hovered && { backgroundColor: t.hover }, dropBefore && { boxShadow: `inset 0 2px 0 ${t.accent}` } as object, dragged && styles.dragged]}>
          {(hovered) => (
            <>
              <PressArea editing={editing === "group:" + g.id} expanded={!collapsed} label={title || g.name} style={styles.press} onPress={press}>
                <Caret open={!collapsed} />
                {depth > 0 && <View style={styles.groupIcon}><GroupIcon color={t.muted} /></View>}
                {editing === "group:" + g.id
                  ? <InlineName small value={g.name} onDone={rename} />
                  : <Text {...tid("side-group-name")} numberOfLines={1} weight="600" tone={depth ? "text" : "muted"} size={depth ? 12.5 : 11.5}
                      style={[styles.grow, !depth && styles.caps]}>{g.name}</Text>}
                {g.archived && <ArchivedTag />}
                {collapsed && working && <StatusDot inline state="thinking" />}
                {collapsed && count > 0 && <Count n={count} />}
              </PressArea>
              {!g.archived && (
                <AddMenu title={`New in ${g.name}`} head={`New in ${g.name}`} hovered={hovered}>
                  {(close) => <>
                    <MenuItem icon={<ChatIcon color={t.muted} />} label="Chat" onPress={() => { close(); later(() => void newChat({ group: g.id })); }} />
                    <MenuItem icon={<BoardIcon color={t.accent} />} label="Whiteboard" onPress={() => { close(); later(() => make.board(g.id)); }} />
                    <MenuItem icon={<GroupIcon color={t.muted} />} label="Group" onPress={() => { close(); later(() => make.group(server, g.id)); }} />
                  </>}
                </AddMenu>
              )}
              <RowMenu label="More" items={menu} hovered={hovered} />
            </>
          )}
        </Frame>
        </GestureDetector>
        {/* (no row of a collapsed group is drawn) */}
        {!collapsed && (
          <View {...tid("side-group-body")} style={[styles.groupBody, depth > 0 && { marginLeft: 11, paddingLeft: 4, borderLeftWidth: 1, borderLeftColor: t.line2 }]}>
            {children.map((c) => <GroupNode key={c.group.id} n={c} depth={depth + 1} editing={editing} setEditing={setEditing} make={make} />)}
            {boards.map((b) => <BoardNode key={b.id} b={b} editing={editing} setEditing={setEditing} />)}
            {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} />)}
            {!children.length && !boards.length && !chats.length && <Line {...tid("side-empty")} style={styles.empty}>Empty — use + or drag chats here.</Line>}
          </View>
        )}
      </Zone>
    </InArchived.Provider>
  );
}

/** What a collapsed head holds. */
export function Count({ n }: { n: number }) {
  const t = useTokens();
  return <View {...tid("side-count")} style={[styles.count, { backgroundColor: t.hover2 }]}><Text size={10.5} tone="faint" weight="500" style={styles.countText}>{n}</Text></View>;
}

// ---------------------------------------------------------------- a board

export const BoardNode = memo(function BoardNode({ b, editing, setEditing }: Edit & { b: Board }) {
  const t = useTokens();
  const sel = useStore((s) => s.sel);
  const groups = useStore((s) => groupsOn(s, serverOf(b))); // the groups of the board's own server: its path, and where it can be moved to
  const all = useStore((s) => s.chats);
  const showArchived = useStore((s) => s.showArchived);
  const other = useStore((s) => s.busyOn[b.id]?.agent);
  const inArchived = useContext(InArchived);
  const [open, setOpen] = useState(true);
  const [err, setErr] = useState("");
  const chats = boardChats(all, b.id, showArchived);
  const working = chats.find((c) => !c.archived && chatBusy(c))?.agent ?? other;
  const on = sel.board === b.id;
  const lit = on && !sel.chat;
  const key = "board:" + b.id;
  const rename = async (v: string) => {
    setEditing(null);
    if (!v || v === b.name) return;
    try { await boardApp.flush(b.id); upsertBoard(await api.renameBoard(b.id, v)); setErr(""); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  };
  const press = useDoublePress(() => openBoard(b.id, true), () => { if (!b.archived) setEditing(key); });
  // (a board of a section: its menu has no file to reveal, and moves it between the groups of its own server)
  const targets = moveTargets(groups, b.group).map((g) => ({ label: g.label, run: () => attempt("Couldn't move the board", () => api.moveBoard(b.id, g.id)) }));
  const run: Record<BoardMenuItem, () => void> = {
    rename: () => setEditing(key),
    move: () => {},
    reveal: () => attempt("Couldn't reveal the board", () => boardApp.flush(b.id).then(() => api.reveal(b.id))),
    archive: () => archiveBoard(b),
    unarchive: () => attempt("Couldn't unarchive the board", () => api.unarchive("boards", b.id)),
    delete: () => deleteBoard(b),
  };
  const menu = boardMenu(b).filter((i) => i !== "move" || targets.length > 0)
    .map((i) => ({ label: BOARD_MENU_LABEL[i], tone: i === "delete" ? "danger" as const : undefined, run: run[i], sub: i === "move" ? targets : undefined }));
  const title = [...groupPath(groups, b.group), b.name].join(" / ");
  const dragged = useIsDragged(key);
  const gesture = useDragGesture(!b.archived && editing !== key, () => ({ kind: "row", key, title: b.name, server: serverOf(b) }));
  return (
    <View {...tid("side-board", { board: b.id, archived: b.archived || undefined })} style={[b.archived && !inArchived && styles.faded]}>
      <GestureDetector gesture={gesture} touchAction="pan-y">
      <PressFrame editing={editing === key} label={title} onPress={press} title={title} {...tid("side-row", { kind: "board", key: b.id, archived: b.archived || undefined })} aria-selected={on} accessibilityState={{ selected: on }}
        style={(hovered) => [styles.row, styles.rowBoard, hovered && !lit && { backgroundColor: t.hover }, lit && { backgroundColor: t.bg, boxShadow: `0 0 0 1px ${t.line}` } as object, dragged && styles.dragged]}>
        {(hovered) => (
          <>
            <View style={styles.rowPress}>
              <Pressable accessibilityRole="button" aria-label={open ? "Hide chats" : "Show chats"} aria-expanded={open} disabled={!chats.length}
                onPress={() => setOpen(!open)} hitSlop={4}>
                <Caret open={open} hidden={!chats.length} />
              </Pressable>
              <View style={styles.boardIcon}>{working ? <AgentGlyph agent={working} size={12} /> : <BoardIcon color={t.accent} />}</View>
              {editing === key
                ? <InlineName value={b.name} onDone={(v) => void rename(v)} />
                : <Text {...tid("side-name")} numberOfLines={1} weight="500" tone={on && sel.chat ? "accent" : "text"} style={styles.grow}>{b.name}</Text>}
              {b.new && <NewDot />}
              {b.archived && <ArchivedTag />}
              {!open && chats.length > 0 && <Count n={chats.length} />}
            </View>
            {!b.archived && <AddChat title="New chat on this board" hovered={hovered} onPress={() => { setOpen(true); void newChat({ board: b.id }); }} />}
            <RowMenu label="More" items={menu} hovered={hovered} />
          </>
        )}
      </PressFrame>
      </GestureDetector>
      {err ? <Text {...tid("side-err")} size={11.5} tone="danger" style={styles.err}>{err}</Text> : null}
      {open && chats.length > 0 && (
        <View {...tid("side-board-chats")} style={styles.boardChats}>
          <View pointerEvents="none" style={[styles.boardLine, { backgroundColor: t.line2 }]} />
          {chats.map((c) => <ChatRow key={c.id} c={c} editing={editing} setEditing={setEditing} nested />)}
        </View>
      )}
    </View>
  );
});

// ---------------------------------------------------------------- a chat

export const ChatRow = memo(function ChatRow({ c, editing, setEditing, nested }: Edit & { c: ChatView; nested?: boolean }) {
  const t = useTokens();
  const on = useStore((s) => s.sel.chat === c.id);
  const items = useStore((s) => threadOf(s, c.id)?.items);
  const cat = useStore((s) => catalogFor(s, serverOf(c), c.agent)); // the models of the chat's own server name its model
  const inArchived = useContext(InArchived);
  const key = "chat:" + c.id;
  // (the row is the same for a chat of this computer and of a section, which names no server: the section does)
  const sub = rowLine(c, subline(c, cat), boardNames(c.id)), st = dotState(c);
  const legacy = isLegacy(c);
  const title = chatTitle(c, items);
  const menu: RowItem[] = c.archived
    ? [{ label: "Unarchive", run: () => attempt("Couldn't unarchive the chat", () => api.unarchive("chats", c.id)) },
       { label: "Delete", tone: "danger", run: () => deleteChat(c) }]
    : legacy
    ? [{ label: "Archive", run: () => attempt("Couldn't archive the chat", () => api.archive("chats", c.id)) },
       { label: "Delete", tone: "danger", run: () => deleteChat(c) }]
    : [{ label: "Rename", run: () => setEditing(key) },
       { label: "Archive", run: () => attempt("Couldn't archive the chat", () => api.archive("chats", c.id)) },
       { label: "Delete", tone: "danger", run: () => deleteChat(c) }];
  // a draft on any branch; the open chat shows the one of the branch it is on in the composer, so only another branch's counts
  const other = useStore((s) => s.sel.chat === c.id && otherDrafts(statesOfChat(s, c.id), viewedBranch(s, c.id)));
  const draft = (on ? other : chatHasDraft(c)) && !c.archived && !legacy;
  const press = useDoublePress(() => openChat(c), () => { if (!c.archived && !legacy) setEditing(key); });
  const faded = (c.archived || legacy) && !inArchived;
  const dragged = useIsDragged(key);
  const gesture = useDragGesture(!nested && !c.archived && editing !== key, () => ({ kind: "row", key, title, server: serverOf(c) }));
  const soft = (t as Record<string, string>)[agentClass(c.agent) + "Soft"] ?? "transparent";
  const subTone = st === "thinking" || st === "writing" || st === "tool" ? t.ok : st === "approval" ? t.warn : st === "stopped" || st === "error" ? t.danger : t.muted;
  return (
    <GestureDetector gesture={gesture} touchAction="pan-y">
    <PressFrame editing={editing === key} label={`${title} — ${sub}`} onPress={press} title={`${title} — ${sub}`} {...tid("side-row", { kind: "chat", key: c.id, archived: c.archived || legacy || undefined })} aria-selected={on} accessibilityState={{ selected: on }}
      style={(hovered) => [styles.row, nested ? styles.rowNested : styles.rowChat, hovered && !on && { backgroundColor: t.hover }, on && { backgroundColor: t.bg, boxShadow: `0 0 0 1px ${t.line}` } as object, faded && styles.faded, dragged && styles.dragged]}>
      {(hovered) => (
        <>
          <View style={styles.rowPress}>
            <View style={[styles.glyph, { backgroundColor: soft }]}>
              <AgentGlyph agent={c.agent} size={11} />
              <StatusDot state={st} />
            </View>
            <View style={styles.main}>
              {editing === key
                ? <InlineName value={title} onDone={(v) => { setEditing(null); renameChat(c, v, title); }} />
                : <Text {...tid("side-name")} numberOfLines={1} tone={c.name ? "text" : "muted"} style={[c.name ? null : styles.italic]}>{title}</Text>}
              <Text {...tid("side-sub")} numberOfLines={1} size={10.5} style={[styles.sub, { color: subTone }]}>{sub}</Text>
            </View>
            <BranchBadge chat={c} />
            {draft && <DraftTag other={on} />}
            {c.archived && <ArchivedTag />}
            {!c.archived && legacy && <DisabledTag />}
          </View>
          {editing !== key && <RowMenu label="More" items={menu} hovered={hovered} />}
        </>
      )}
    </PressFrame>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  zone: { borderRadius: 8, paddingVertical: 1 },
  loose: { minHeight: 6 },
  group: { marginTop: 8 },
  groupSub: { marginTop: 2 },
  faded: { opacity: 0.55 },
  dragged: { opacity: 0.45 },
  groupHead: { flexDirection: "row", alignItems: "center", gap: 4, height: 26, paddingRight: 2, borderRadius: 6 },
  groupIcon: { alignItems: "center", justifyContent: "center", flexShrink: 0 },
  groupBody: { paddingLeft: 6 },
  press: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "stretch", paddingLeft: 4, borderRadius: 6 },
  rowPress: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "stretch" },
  caps: { textTransform: "uppercase", letterSpacing: 0.35 },
  grow: { flexShrink: 1, minWidth: 0 },
  count: { borderRadius: 8, paddingHorizontal: 6, height: 16, justifyContent: "center", flexShrink: 0 },
  countText: { lineHeight: 16 },
  empty: { paddingTop: 4, paddingRight: 10, paddingBottom: 6, paddingLeft: 18 },
  row: { flexDirection: "row", alignItems: "center", gap: 7, paddingVertical: 4, paddingRight: 4, minHeight: 30, borderRadius: 7 },
  rowBoard: { paddingLeft: 4 },
  rowChat: { paddingLeft: 20 },
  rowNested: { paddingLeft: 34, minHeight: 26 },
  boardIcon: { width: 20, height: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  boardChats: { position: "relative" },
  boardLine: { position: "absolute", left: 21, top: 0, bottom: 6, width: 1 },
  err: { paddingRight: 8, paddingBottom: 4, paddingLeft: 44 },
  glyph: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  main: { flex: 1, minWidth: 0 },
  italic: { fontStyle: "italic" },
  sub: { marginTop: -1 },
});
