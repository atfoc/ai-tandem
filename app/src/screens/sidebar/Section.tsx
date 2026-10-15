// The section of one server (an entry of the server list): its head with the entry's name and state, and under it that server's
// tree, drawn with the rows every section has (TreeRows), or the line that says why there is none. This computer's is the first and
// always there (on a phone or a tablet's native app there is none: platform/thiscomputer.ts). The rows come from the tree the app
// holds of that server and from nothing else: without one the section shows no row, whatever is still on screen of that server.
//
// A section is not a group. A press on its head collapses or expands it, which is all the head has in common with a group's: it has
// no rename, no archive, no delete and no menu; it is not dragged, and nothing is dropped on it. Its "+", shown while its server is
// connected, makes a chat, a whiteboard or a group on that server, outside any group. Whether it is collapsed is kept in the app
// (store.ts setSectionCollapsed), and is sent nowhere. This computer's section alone says what the app does with its server.
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";

import { buildTree, holdsAny, treeCount, treeEmpty } from "@aiwb/core/logic/tree.ts";
import { localExtra } from "@aiwb/core/logic/localsection.ts";
import { sectionView } from "@aiwb/core/logic/sections.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { ungroupedOn } from "@aiwb/core/logic/keys.ts";
import { setSectionCollapsed } from "@aiwb/core/state/store.ts";
import { inDesktopApp, openServerLog, pageVersion, restartServer, startAgain } from "@aiwb/core/state/version.ts";
import { LOCAL_SERVER } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon, ChatIcon, GroupIcon } from "../../ui/icons.tsx";
import { MenuItem } from "../../ui/Menu.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { MONO } from "../../ui/fonts.ts";
import { newChat } from "../shell/nav.ts";
import { AddMenu, later } from "./menus.tsx";
import { Caret, Frame, Line, Text } from "./parts.tsx";
import { Count, TreeRows, type Edit, type Make } from "./rows.tsx";

export function SectionNode({ v, first, editing, setEditing, make }: Edit & { v: ServerView; first: boolean; make: Make }) {
  const t = useTokens();
  const local = v.id === LOCAL_SERVER;
  const groups = useStore((s) => (local ? s.groups : s.sections[v.id]?.groups));
  const held = useStore((s) => (local ? s.connected : !!s.sections[v.id])); // the app holds the server's tree
  const collapsed = useStore((s) => !!s.collapsed[v.id]);
  const boards = useStore((s) => s.boards);
  const chats = useStore((s) => s.chats);
  const gone = useStore((s) => s.gone);
  const showArchived = useStore((s) => s.showArchived);
  const loose = ungroupedOn(v.id);
  const tree = held && groups ? buildTree({ groups, boards, chats }, showArchived, { server: v.id, gone }) : null;
  const empty = !!tree && treeEmpty(tree);
  // (a server whose things are all archived has something on it: the section does not say that it has nothing)
  const archived = empty && !showArchived && holdsAny({ groups: groups!, boards, chats }, { server: v.id, gone });
  const view = sectionView(v, !!tree, empty, archived);
  const count = tree ? treeCount(tree) : 0;
  const tone = view.tone === "ok" ? t.ok : view.tone === "bad" ? t.danger : t.faint;
  const title = `${v.name} — ${view.state}`;
  const toggle = () => setSectionCollapsed(v.id, !collapsed);
  return (
    <View {...tid("side-section", { server: v.id, tone: view.tone, collapsed })} accessibilityLabel={v.name} style={[styles.section, first ? styles.first : { borderTopColor: t.line }]}>
      <Frame title={title} {...tid("side-section-head", { server: v.id })} style={(hovered) => [styles.head, hovered && { backgroundColor: t.hover }]}>
        {(hovered) => (
          <>
            <Pressable {...tid("side-section-toggle", { server: v.id })} accessibilityRole="button" aria-expanded={!collapsed} accessibilityState={{ expanded: !collapsed }}
              aria-label={title} style={styles.toggle} onPress={toggle}>
              <Caret open={!collapsed} />
              <Text {...tid("side-section-name")} numberOfLines={1} size={12.5} weight="600" style={styles.name}>{v.name}</Text>
              <View {...tid("side-section-state", { server: v.id, tone: view.tone })} style={styles.state}>
                <View style={[styles.stateDot, { backgroundColor: tone }]} />
                <Text numberOfLines={1} size={11} weight="500" tone={view.tone === "bad" ? "danger" : "muted"} style={styles.stateText}>{view.state}</Text>
              </View>
              {collapsed && count > 0 && <Count n={count} />}
            </Pressable>
            {view.add && (
              <AddMenu title={`New on ${v.name}`} head={`New on ${v.name}`} hovered={hovered}>
                {(close) => <>
                  <MenuItem icon={<ChatIcon color={t.muted} />} label="Chat" onPress={() => { close(); later(() => { setSectionCollapsed(v.id, false); void newChat({ group: loose }); }); }} />
                  <MenuItem icon={<BoardIcon color={t.accent} />} label="Whiteboard" onPress={() => { close(); later(() => { setSectionCollapsed(v.id, false); make.board(loose); }); }} />
                  <MenuItem icon={<GroupIcon color={t.muted} />} label="Group" onPress={() => { close(); later(() => make.group(v.id)); }} />
                </>}
              </AddMenu>
            )}
          </>
        )}
      </Frame>
      {/* (no row of a collapsed section is drawn) */}
      {!collapsed && (
        <View {...tid("side-section-body")} style={styles.body}>
          {local && <LocalExtras v={v} />}
          {view.rows && tree && <TreeRows tree={tree} loose={loose} editing={editing} setEditing={setEditing} make={make} />}
          {view.lines.map((line) => <Line key={line} {...tid("side-section-line")} style={styles.line}>{line}</Line>)}
        </View>
      )}
    </View>
  );
}

/** What this computer's section says and offers besides its rows (logic/localsection.ts): a start that failed with the reason the
 *  server gave, "Retry" and "Open server log"; a server older than the app, or of another build, with "Restart server"; a restart
 *  that runs or failed. The app does these with the server program it carries (version.ts). */
function LocalExtras({ v }: { v: ServerView }) {
  const t = useTokens();
  const restart = useStore((s) => s.restart);
  const x = localExtra(v, restart, pageVersion(), inDesktopApp());
  if (!x.line && !x.reason && !x.again && !x.restart && !x.log) return null;
  return (
    <View {...tid("side-section-extra")} role="status" style={styles.extra}>
      {x.line ? (
        <View style={styles.extraLineRow}>
          {restart.phase === "restarting" && <ActivityIndicator {...tid("side-section-spin")} size="small" color={t.accent} />}
          <Text {...tid("side-section-line")} size={12} style={styles.extraLine}>{x.line}</Text>
        </View>
      ) : null}
      {x.reason ? (
        <ScrollView {...tid("side-section-reason")} nestedScrollEnabled style={[styles.reason, { borderColor: t.line, backgroundColor: t.bg }]} contentContainerStyle={styles.reasonBody}>
          <Text selectable mono size={11} tone="muted" style={{ fontFamily: MONO }}>{x.reason}</Text>
        </ScrollView>
      ) : null}
      <View style={styles.actions}>
        {x.restart && <Button size="sm" tone="primary" label="Restart server" onPress={restartServer} />}
        {x.again && <Button size="sm" label="Retry" onPress={x.again === "start" ? startAgain : restartServer} />}
        {x.log && <Button size="sm" label="Open server log" onPress={openServerLog} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 14, paddingTop: 6, borderTopWidth: 1 },
  first: { marginTop: 0, paddingTop: 0, borderTopWidth: 0 },
  head: { flexDirection: "row", alignItems: "center", gap: 5, height: 28, paddingRight: 2, borderRadius: 6 },
  toggle: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5, alignSelf: "stretch", paddingLeft: 4 },
  name: { flexShrink: 1, minWidth: 0 },
  state: { flexDirection: "row", alignItems: "center", flexShrink: 1000, minWidth: 66 },
  stateDot: { width: 6, height: 6, borderRadius: 3, marginRight: 4, flexShrink: 0 },
  stateText: { flexShrink: 1 },
  body: { paddingLeft: 2 },
  line: { paddingLeft: 20 },
  extra: { gap: 6, paddingTop: 2, paddingRight: 4, paddingBottom: 6, paddingLeft: 20 },
  extraLineRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  extraLine: { lineHeight: 17, flexShrink: 1 },
  reason: { maxHeight: 190, flexGrow: 0, borderWidth: 1, borderRadius: 6 },
  reasonBody: { paddingVertical: 5, paddingHorizontal: 7 },
  actions: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
});
