// The phone's Home (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §2, §4): the bottom screen of the stack. A top row
// (the logo, "+ New", the gear), the large title, the server (one: a line under the title; two or more: chips), the search field's lookalike
// and the body of the state the selected server is in: the first run, placeholders while it connects, a card for its trouble above the last
// list faded, the empty Home, or the list of groups, boards and chats. Home never writes a state word or a sheet of its own: the kit does.
import { useEffect, useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { needsAttention } from "@aiwb/core/logic/statewords.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";

import { hasThisComputer } from "../../platform/thiscomputer.ts";
import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { LargeTitle } from "../../ui/Bars.tsx";
import { GearIcon, Logo } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { StateWord, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { chosenServer, homeEntries, placeLists, type RowItem } from "./model.ts";
import { setHomeServer, useHomePlace } from "../shell/homeplace.ts";
import { EmptyHome } from "./EmptyHome.tsx";
import { FirstRun } from "./FirstRun.tsx";
import { HomeList } from "./HomeList.tsx";
import { H1_TID } from "./ids.ts";
import { lastPlace, rememberPlace } from "./lastsync.ts";
import { openNewSheet } from "./newsheet.ts";
import { offlineToast } from "./offline.ts";
import { openItem } from "./open.ts";
import { Placeholders } from "./Placeholders.tsx";
import { ProblemCard } from "./ProblemCard.tsx";
import { watchOpened } from "./recent.ts";
import { Search } from "./Search.tsx";
import { openSearch, useSearch } from "./search.ts";
import { ServerChips } from "./ServerChips.tsx";
import { SettingsStopgap } from "./SettingsStopgap.tsx";
import { openSettings } from "./settings.ts";
import { StopgapServerSheet } from "./StopgapServerSheet.tsx";
import { usePlaceData } from "./useplace.ts";
import { useDragScreen } from "./dragscreen.tsx";
import { DragGhost } from "../sidebar/drag.tsx";

export type HomeState = "first-run" | "connecting" | "trouble" | "empty" | "list";

const LOGO = 28;

export function Home() {
  const t = useTokens();
  const servers = useStore((s) => s.servers);
  const entries = useMemo(() => homeEntries(servers, hasThisComputer()), [servers]);
  const savedServer = useHomePlace().server;
  const selected = chosenServer(entries, savedServer);
  // (only a first choice is written: a saved server that is not listed yet, as after a reload before the server list has come, keeps its place)
  useEffect(() => { if (selected && savedServer === null) setHomeServer(selected); }, [selected, savedServer]);

  const { view, held, input } = usePlaceData(selected);
  const live = !!view && view.state === "connected" && held;
  const lists = useMemo(() => (live && input && selected ? placeLists(input, selected, null) : null), [live, input, selected]);
  useEffect(() => { if (live && input && selected) rememberPlace(selected, input); }, [live, input, selected]);

  const state: HomeState = !view ? "first-run"
    : view.state === "connecting" || (view.state === "connected" && !held) ? "connecting"
    : needsAttention(view) ? "trouble"
    : lists && !lists.groups.length && !lists.boards.length && !lists.chats.length ? "empty" : "list";
  const faded = useMemo(() => {
    const last = state === "trouble" && selected ? lastPlace(selected) : undefined;
    return last && selected ? placeLists(last, selected, null) : null;
  }, [state, selected]);

  const searching = useSearch();
  useEffect(watchOpened, []); // (the search's "Recently opened": recorded from now on)
  const dragScreen = useDragScreen();
  const firstRun = state === "first-run", canNew = state === "list" || state === "empty";
  return (
    <View {...tid(H1_TID.home, { server: selected ?? "", state })} style={[styles.fill, { backgroundColor: t.bg }]}>
      {searching ? <Search server={selected} view={view} input={live ? input : selected ? lastPlace(selected) ?? null : null} stale={!live} /> : null}
      {searching ? null : <View style={styles.top}>
        <View style={styles.logo}><Logo size={LOGO} /></View>
        {firstRun ? <Text size={TYPE.control} weight="600" style={styles.brand}>AI Whiteboard</Text> : <View style={styles.fill} />}
        {firstRun ? null : <Button {...tid(H1_TID.new)} size="touch" tone="primary" label="+ New" accessibilityLabel="New" disabled={!canNew} style={styles.newBtn}
          onPress={() => selected && openNewSheet({ server: selected, groups: [] })} />}
        <IconButton {...tid(H1_TID.gear)} size="touch" title="Settings" accessibilityLabel="Settings" onPress={openSettings}>{(c) => <GearIcon size={22} color={c} />}</IconButton>
      </View>}
      {searching ? null : <View ref={dragScreen.box} collapsable={false} style={styles.fill}>
      <ScrollView {...dragScreen.scroll} style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {firstRun ? <FirstRun /> : (
          <>
            <LargeTitle title="Home" />
            {entries.length === 1 && view ? <OneServer view={view} /> : null}
            {state === "empty" ? null : <SearchLookalike />}
            {entries.length >= 2 ? <ServerChips entries={entries} selected={selected} /> : null}
            {state === "connecting" ? <Placeholders /> : null}
            {state === "trouble" && view ? <ProblemCard view={view} /> : null}
            {state === "trouble" && faded && view ? <HomeList lists={faded} stale onOpen={openItem} onStalePress={() => offlineToast(view.name)} /> : null}
            {state === "empty" && view ? <EmptyHome view={view} /> : null}
            {state === "list" && lists ? <HomeList lists={lists} onOpen={(item: RowItem) => openItem(item)} /> : null}
          </>
        )}
      </ScrollView>
      </View>}
      <StopgapServerSheet />
      <SettingsStopgap />
      <DragGhost />
    </View>
  );
}

/** The line under "Home" with one server: its name, then its state word with its dot. */
function OneServer({ view }: { view: ServerView }) {
  const word = useServerWord(view);
  return (
    <View {...tid(H1_TID.sub)} style={styles.sub}>
      <Text size={TYPE.secondary} tone="muted" numberOfLines={1} style={styles.subName}>{view.name} ·</Text>
      <StateWord word={word} />
    </View>
  );
}

/** The search field as it looks on Home: a 44 pt box that opens the search when pressed, as ui/SearchField is drawn. */
function SearchLookalike() {
  const t = useTokens();
  return (
    <Pressable {...tid(H1_TID.search)} accessibilityRole="search" accessibilityLabel="Search boards and chats" onPress={openSearch}
      style={[styles.search, { backgroundColor: t.panel }]}>
      <Text size={TYPE.control} style={{ color: t.muted }}>Search boards and chats</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  top: { minHeight: PHONE.target + 8, flexDirection: "row", alignItems: "center", paddingLeft: PHONE.margin, paddingRight: PHONE.margin / 2, gap: 4 },
  logo: { width: LOGO, height: LOGO },
  brand: { flex: 1, marginLeft: 8 },
  newBtn: { alignSelf: "center" },
  body: { paddingBottom: 24 },
  sub: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: PHONE.margin, paddingBottom: 8 },
  subName: { flexShrink: 1 },
  search: { minHeight: PHONE.target, marginHorizontal: PHONE.margin, marginBottom: 4, borderRadius: 10, paddingHorizontal: 12, justifyContent: "center" },
});
