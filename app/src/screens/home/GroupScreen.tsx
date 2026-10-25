// A group as a screen of the phone's stack (ux-improvements goal 3.2, package H1; plans/ux-improvements/h1-design.md §7): the place bar with
// the back and "+ New", the large title with the full place under it, and the group's groups, boards and chats. It keeps the group while the
// screen slides out, when its stack entry is already gone. A server that is away shows the last copy of the group faded.
import { useEffect, useMemo, useRef } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";

import { PlaceBar, LargeTitle } from "../../ui/Bars.tsx";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { MoreIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { NavBack } from "../shell/BackButton.tsx";
import { useHomePlace } from "../shell/homeplace.ts";
import { useEntryKey } from "../shell/phone/entry.ts";
import { useStack } from "../shell/useShellView.ts";
import { HomeList } from "./HomeList.tsx";
import { H1_TID } from "./ids.ts";
import { lastPlace, rememberPlace } from "./lastsync.ts";
import { countsOf, groupNode, placeLine, placeLists, type PlaceInput } from "./model.ts";
import { openNewSheet } from "./newsheet.ts";
import { offlineToast } from "./offline.ts";
import { openItem } from "./open.ts";
import { Placeholders } from "./Placeholders.tsx";
import { useRowActions } from "./rowactions.ts";
import { usePlaceData } from "./useplace.ts";
import { useDragScreen } from "./dragscreen.tsx";
import { DragGhost } from "../sidebar/drag.tsx";

export function GroupScreen() {
  const t = useTokens();
  const key = useEntryKey();
  const stack = useStack();
  const kept = useRef<string | null>(null);
  const entry = stack.find((e) => e.key === key);
  if (entry?.id) kept.current = entry.id; // (kept while the screen slides out, when its entry is already gone)
  const id = kept.current;
  const server = id ? serverOfKey(id) : null;
  const { view, held, input } = usePlaceData(server);
  const live = !!view && view.state === "connected" && held;
  useEffect(() => { if (live && input && server) rememberPlace(server, input); }, [live, input, server]);
  const source: PlaceInput | null = live ? input : server ? lastPlace(server) ?? null : null;
  const found = useMemo(() => (source && server && id ? groupNode(source, server, id) : undefined), [source, server, id]);
  const lists = useMemo(() => (source && server && id && found ? placeLists(source, server, id) : null), [source, server, id, found]);
  const placeGroups = useHomePlace().groups;
  const actions = useRowActions({ kind: "group", key: id ?? "" });
  const dragScreen = useDragScreen();
  const serverName = view?.name ?? "this server";
  const empty = !!lists && !lists.groups.length && !lists.boards.length && !lists.chats.length;
  const newHere = () => {
    if (!server || !id) return;
    const at = placeGroups.indexOf(id);
    openNewSheet({ server, groups: at >= 0 ? placeGroups.slice(0, at + 1) : [id] });
  };
  const right = (
    <>
      {actions.openSheet ? <IconButton {...tid(H1_TID.groupMore)} size="touch" title="More" accessibilityLabel="More" onPress={actions.openSheet}>{(c) => <MoreIcon size={18} color={c} />}</IconButton> : null}
      <Button {...tid(H1_TID.groupNew)} size="touch" tone="primary" label="+ New" accessibilityLabel="New" disabled={!live} onPress={newHere} style={styles.newBtn} />
    </>
  );
  return (
    <View {...tid(H1_TID.groupScreen, { key: id ?? "" })} style={[styles.fill, { backgroundColor: t.bg }]}>
      <PlaceBar back={<NavBack />} title="" right={found ? right : undefined} />
      <View ref={dragScreen.box} collapsable={false} style={styles.fill}>
      <ScrollView {...dragScreen.scroll} style={styles.fill} contentContainerStyle={styles.body}>
        {found && lists ? (
          <>
            <LargeTitle title={found.node.group.name} sub={placeLine(serverName, found.ancestors, countsOf(found.node))} />
            {empty ? (
              <View {...tid(H1_TID.groupEmpty)} style={styles.empty}>
                <Text size={TYPE.control} tone="muted">Nothing here yet</Text>
                {live ? <Button {...tid(H1_TID.emptyNew)} size="touch" tone="primary" label="+ New" accessibilityLabel="New" onPress={newHere} /> : null}
              </View>
            ) : (
              <HomeList lists={lists} stale={!live} onOpen={openItem} onStalePress={() => offlineToast(serverName)} />
            )}
          </>
        ) : !live && view?.state === "connecting" ? <Placeholders />
        : !live && view ? <Message>{`${serverName} is offline. Its boards and chats come back when it does.`}</Message>
        : <Message>{`This group is no longer on ${serverName}.`}</Message>}
      </ScrollView>
      </View>
      <DragGhost />
    </View>
  );
}

function Message({ children }: { children: string }) {
  return <View style={styles.message}><Text size={TYPE.control} tone="muted" style={styles.centred}>{children}</Text></View>;
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  body: { paddingBottom: 24 },
  // (a filled button keeps the screen's margin from the edge; the bar's slot is drawn for 44 pt icon buttons)
  newBtn: { alignSelf: "center", marginRight: PHONE.margin / 2 },
  empty: { alignItems: "center", gap: 16, paddingHorizontal: PHONE.margin, paddingTop: 48 },
  message: { paddingHorizontal: PHONE.margin, paddingTop: 48 },
  centred: { textAlign: "center" },
});
