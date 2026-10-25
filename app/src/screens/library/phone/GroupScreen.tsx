// A group's screen on the phone (package S4, goal 3.8.6, mockups 06b-c and 06b-d), pushed over the Library screen or over the group it
// is in: a caps header with what it holds, one card of its groups (60 pt rows that push one more screen) and its prompts (tap, swipe, long
// press), then a separate "New prompt here" row that makes a prompt in this group, and the foot line saying where the group is. The bar's
// "⋯" opens the group's P1 sheet (New prompt here, New group here, Rename group…, Move group…, Delete group…). A group that is deleted
// (from its sheet, or on another window) takes its screen, and the ones above it, off the stack.
import { useEffect } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { offText } from "@aiwb/core/logic/libraryview.ts";
import { getState } from "@aiwb/core/state/store.ts";

import { Cell, CellGroup } from "../../../ui/Cells.tsx";
import { IconButton } from "../../../ui/IconButton.tsx";
import { MoreIcon } from "../../../ui/icons.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { popScreen, pushedScreens } from "../../shell/screens.ts";
import { useLibraries } from "../useLibraries.ts";
import { PlusGlyph } from "./icons.tsx";
import { S4_TID } from "./ids.ts";
import { EmptyRow, GroupItemRow, NoticeRow, PromptItemRow, RowGroup, useRowSheets } from "./ListRows.tsx";
import { countLine, groupFoot, heldBy, offReason } from "./listlogic.ts";
import { openEditor } from "./sheets.ts";

export type GroupParams = { server: string; group: string };

/** The bar's title: the group's name as the store has it now. */
export const groupTitle = (p: GroupParams): string =>
  getState().libraries.find((l) => l.server === p.server)?.groups.find((g) => g.id === p.group)?.name ?? "Group";

export function GroupScreen({ params }: { params: GroupParams }) {
  const t = useTokens(), bottom = useSafeAreaInsets().bottom;
  const libs = useLibraries(), sheets = useRowSheets();
  const v = libs.find((l) => l.server === params.server), group = v?.groups.find((g) => g.id === params.group);
  const gone = !group;

  // the group is deleted, or its library is: this screen goes, and every screen above it
  useEffect(() => {
    if (!gone) return;
    const own = pushedScreens().find((p) => p.params === params);
    if (own) popScreen(own.key, { quiet: true });
  }, [gone, params]);

  if (!v || !group) return <View testID={S4_TID.groupScreen} style={{ flex: 1, backgroundColor: t.panel }} />;
  const held = heldBy(v, group.id), at = { server: params.server, group: group.id }, reason = offReason(v);
  const rows = [
    ...held.groups.map((g) => <GroupItemRow key={`g:${g.id}`} server={params.server} g={g} sheets={sheets} />),
    ...held.prompts.map((p) => <PromptItemRow key={`p:${p.id}`} server={params.server} p={p} sheets={sheets} />),
  ];
  return (
    <ScrollView testID={S4_TID.groupScreen} {...{ dataSet: { server: params.server, group: params.group } }} style={{ backgroundColor: t.panel }}
      contentContainerStyle={[styles.content, { paddingBottom: bottom + PHONE.margin }]}>
      {v.connected ? null : <View style={styles.notice}><NoticeRow testID={S4_TID.offNotice} data={{ server: v.server }} text={offText(v.name)} /></View>}
      <RowGroup testID={S4_TID.section} data={{ server: v.server }} title={countLine(held)}>
        {rows.length ? rows : [<EmptyRow key="none" testID={S4_TID.emptyRow} text="No prompts here yet" />]}
      </RowGroup>
      <CellGroup>
        <Cell testID={S4_TID.newHere} data={{ server: v.server, group: group.id }} label="New prompt here" sub={reason || undefined} tone="accent" disabled={!!reason}
          leading={<PlusGlyph size={18} color={t.accent} />} onPress={() => openEditor({ mode: "new", at })} chevron={false} />
      </CellGroup>
      <Text testID={S4_TID.foot} size={TYPE.secondary} tone="muted" style={styles.foot}>{groupFoot(libs, v.server, group.id)}</Text>
      {sheets.node}
    </ScrollView>
  );
}

/** The bar's "⋯": the group's P1 sheet. */
export function GroupMore({ params }: { params: GroupParams }) {
  const sheets = useRowSheets();
  const name = groupTitle(params);
  return (
    <>
      <IconButton testID={S4_TID.more} size="touch" title={`More for “${name}”`} onPress={() => sheets.openSheet({ kind: "group", server: params.server, id: params.group })}>
        {(color) => <MoreIcon size={20} color={color} />}
      </IconButton>
      {sheets.node}
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  notice: { marginHorizontal: PHONE.margin, marginBottom: 12 },
  foot: { marginHorizontal: PHONE.margin, marginTop: -8 },
});
