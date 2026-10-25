// Settings › Archived (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §5): what was archived, server by server and
// group by group, as Home draws its rows at full contrast. A right swipe unarchives (a full one too, with a toast and Undo), a left swipe
// deletes (after a question), a tap opens the thing: a chat read-only, a board. An archived group has no screen of its own to open: a tap
// says it has to be unarchived first. The list of a server comes from archivedmodel.ts; a server whose tree the page does not hold shows
// its heading with its state word and a line, and nothing under it.
import { useMemo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { serverConnected } from "@aiwb/core/logic/serverlists.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { chatTitle, threadOf } from "@aiwb/core/state/store.ts";

import { hasThisComputer } from "../../platform/thiscomputer.ts";
import { useStore } from "../../state/useStore.ts";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { StateWord, useServerWord } from "../../ui/StateWord.tsx";
import type { SwipeAction } from "../../ui/SwipeRow.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/toaststore.ts";
import { registerScreen } from "../shell/screens.ts";
import { ARCHIVED_AWAY, ARCHIVED_FOOT, ARCHIVED_NONE, archivedCount, archivedSections, type ArchivedSection } from "./archivedmodel.ts";
import { H2_TID } from "./h2ids.ts";
import { HomeRow } from "./HomeRow.tsx";
import { homeEntries, placeInput, type RowItem } from "./model.ts";
import { openItem } from "./open.ts";
import { itemName, unarchiveItem } from "./archive.ts";
import { askDelete } from "./deletes.ts";

const open = (item: RowItem): void => {
  if (item.kind === "group") showToast({ text: `Unarchive “${itemName(item) || item.name}” to open it`, kind: "archived-group" });
  else openItem(item);
};

type Block = { view: ServerView; live: boolean; sections: ArchivedSection[] };

/** Each server's block, from one read of the store (a hook cannot run per server): archived things of a server whose tree is held and which
 *  is connected, nothing of one that is away. */
function useBlocks(entries: ServerView[]): Block[] {
  const groups = useStore((s) => s.groups), sections = useStore((s) => s.sections), boards = useStore((s) => s.boards), chats = useStore((s) => s.chats);
  const gone = useStore((s) => s.gone), connected = useStore((s) => s.connected), usable = useStore((s) => s.usable), catalogs = useStore((s) => s.catalogs);
  const home = useStore((s) => s.home), defaultCwd = useStore((s) => s.defaultCwd), lists = useStore((s) => s.lists);
  // (the names of archived chats that have none of their own, as one string, so a streaming reply elsewhere makes no new lists)
  const titles = useStore((s) => JSON.stringify(Object.values(s.chats).filter((c) => c.archived && !c.name).map((c) => [c.id, chatTitle(c, threadOf(s, c.id)?.items)])));
  return useMemo(() => {
    const names = new Map<string, string>(JSON.parse(titles) as [string, string][]);
    return entries.map((view): Block => {
      const live = view.state === "connected" && serverConnected({ sections, connected }, view.id);
      if (!live) return { view, live, sections: [] };
      const base = placeInput({ groups, sections, boards, chats, gone, usable, catalogs, home, defaultCwd, lists }, view.id);
      return { view, live, sections: archivedSections({ ...base, titleOf: (c) => names.get(c.id) ?? chatTitle(c) }, view.id) };
    });
  }, [entries, groups, sections, boards, chats, gone, connected, usable, catalogs, home, defaultCwd, lists, titles]);
}

export function Archived() {
  const t = useTokens();
  const servers = useStore((s) => s.servers);
  const entries = useMemo(() => homeEntries(servers, hasThisComputer()), [servers]);
  // (a server that is connected with nothing archived adds no heading; when no server has anything and none is away: "Nothing is archived.")
  const shown = useBlocks(entries).filter((b) => !b.live || archivedCount(b.sections) > 0);
  return (
    <View {...tid(H2_TID.archivedScreen)} style={[styles.fill, { backgroundColor: t.bg }]}>
      <ScrollView style={styles.fill} contentContainerStyle={styles.body}>
        {shown.map((b) => <ServerBlock key={b.view.id} block={b} />)}
        {shown.length ? null : <Text {...tid(H2_TID.archivedEmpty)} size={TYPE.control} tone="muted" style={styles.none}>{ARCHIVED_NONE}</Text>}
        <Text {...tid(H2_TID.archivedFoot)} size={TYPE.secondary} tone="muted" style={styles.foot}>{ARCHIVED_FOOT}</Text>
      </ScrollView>
    </View>
  );
}

/** One server: its heading with its state word, and what it has archived (or the line that says it shows when it is connected). */
function ServerBlock({ block: { view, live, sections } }: { block: Block }) {
  const word = useServerWord(view);
  return (
    <View>
      <View {...tid(H2_TID.archivedServer, { server: view.id })} accessibilityRole="header" style={styles.server}>
        <Text size={TYPE.h2} weight="600" numberOfLines={1} style={styles.serverName}>{view.name}</Text>
        <StateWord word={word} />
      </View>
      {live ? sections.map((s) => <Section key={s.group} server={view.id} section={s} />)
        : <Text size={TYPE.secondary} tone="muted" style={styles.away}>{ARCHIVED_AWAY}</Text>}
    </View>
  );
}

function Section({ server, section }: { server: string; section: ArchivedSection }) {
  const { heading, group, items } = section;
  return (
    <View>
      {heading ? (
        <View {...tid(H2_TID.archivedSection, { server, group, count: items.length })} accessibilityRole="header" style={styles.head}>
          <Text size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.label}>{heading}</Text>
          <Text size={TYPE.secondary} tone="muted">{items.length}</Text>
        </View>
      ) : <View {...tid(H2_TID.archivedSection, { server, group: "", count: items.length })} style={styles.headless} />}
      {items.map((item, i) => {
        const left: SwipeAction[] = [{ id: "unarchive", label: "Unarchive", tone: "accent", full: true, onPress: () => unarchiveItem(item) }];
        const right: SwipeAction[] = [{ id: "delete", label: "Delete", tone: "danger", onPress: () => askDelete(item) }];
        return <HomeRow key={item.key} item={item} archived last={i === items.length - 1} left={left} swipe={right} onPress={() => open(item)} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  body: { paddingBottom: 24 },
  server: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin, paddingTop: 20, paddingBottom: 4 },
  serverName: { flexShrink: 1 },
  away: { paddingHorizontal: PHONE.margin, paddingTop: 6, paddingBottom: 8 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingHorizontal: PHONE.margin, paddingTop: 14, paddingBottom: 6 },
  headless: { height: 6 },
  label: { flexShrink: 1, letterSpacing: 0.4 },
  none: { textAlign: "center", paddingTop: 48, paddingHorizontal: PHONE.margin },
  foot: { paddingHorizontal: PHONE.margin, paddingTop: 20 },
});

registerScreen("archived", { kind: "place", title: () => "Archived", component: Archived });
