// The phone's Library screen (package S4, goal 3.8.6, mockup 06a), pushed from Settings' Prompt library row: a 44 pt search, a card per
// library (titled with the server's name only when there are several) of its groups (60 pt rows that push a group's screen) and its
// prompts (a tap opens the editor), a left swipe on a row for Move and Delete, a long press for its sheet, and the foot line. A search
// shows the prompts it finds as one flat list with their paths. The bar's "+" makes a new prompt or group (a P1 sheet).
// A server that is not connected has one notice at the top of its section; its rows open (read-only), nothing changes.
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { hasServerLevel, libraryTrees, offText, promptList } from "@aiwb/core/logic/libraryview.ts";
import { hasSearch } from "@aiwb/core/logic/promptsearch.ts";

import { ActionSheet } from "../../../ui/ActionSheet.tsx";
import { Button } from "../../../ui/Button.tsx";
import { IconButton } from "../../../ui/IconButton.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { SearchField } from "../../../ui/SearchField.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { useLibraries } from "../useLibraries.ts";
import { DocGlyph, FolderGlyph, PlusGlyph, PromptTile } from "./icons.tsx";
import { S4_TID } from "./ids.ts";
import { EmptyRow, GroupItemRow, ListRow, NoticeRow, PromptItemRow, RowGroup, useRowSheets } from "./ListRows.tsx";
import { LIBRARY_FOOT, allEmpty, fileNotices, hitPath, plusPlace, plusReason, plusSub } from "./listlogic.ts";
import { openEditor, openGroupForm } from "./sheets.ts";

export function LibraryScreen(_p: { params: Record<string, never> }) {
  const t = useTokens(), bottom = useSafeAreaInsets().bottom;
  const libs = useLibraries(), sheets = useRowSheets();
  const [query, setQuery] = useState("");
  const trees = useMemo(() => libraryTrees(libs), [libs]);
  const level = hasServerLevel(libs), searching = hasSearch(query);
  const hits = useMemo(() => (searching ? promptList(trees, query) : []), [trees, query, searching]);
  const at = plusPlace(libs);

  const body = () => {
    if (!libs.length) return <RowGroup testID={S4_TID.emptyLib}><EmptyRow text="No server is connected" /></RowGroup>;
    if (searching) {
      if (!hits.length) return <Text testID={S4_TID.noHits} size={TYPE.control} tone="muted" style={styles.none}>No prompts match “{query.trim()}”</Text>;
      return (
        <RowGroup testID={S4_TID.hits}>
          {hits.map((h) => (
            <ListRow key={h.key} tile={<PromptTile />} name={h.prompt.name} sub={hitPath(libs, h)} subTestID={S4_TID.hitPath} testID={S4_TID.hitRow} data={{ server: h.server, id: h.prompt.id }}
              onPress={() => openEditor({ mode: "edit", server: h.server, id: h.prompt.id })} />
          ))}
        </RowGroup>
      );
    }
    if (allEmpty(libs)) {
      return (
        <>
          {libs.filter((l) => !l.connected).map((l) => <View key={l.server} style={styles.notice}><NoticeRow testID={S4_TID.offNotice} data={{ server: l.server }} text={offText(l.name)} /></View>)}
          <RowGroup testID={S4_TID.emptyLib}>
            <View style={styles.emptyCard}>
              <Text size={TYPE.control} tone="muted">No prompts yet</Text>
              {at ? <Button testID={S4_TID.emptyNew} size="touch" tone="primary" label="New prompt" onPress={() => openEditor({ mode: "new", at })} /> : null}
            </View>
          </RowGroup>
        </>
      );
    }
    return trees.map((tr) => (
      <RowGroup key={tr.server} testID={S4_TID.section} data={{ server: tr.server }} title={level ? tr.name : undefined}
        notice={tr.connected ? undefined : <NoticeRow testID={S4_TID.offNotice} data={{ server: tr.server }} text={offText(tr.name)} />}>
        {[
          ...tr.groups.map((g) => <GroupItemRow key={`g:${g.id}`} server={tr.server} g={g} sheets={sheets} />),
          ...tr.prompts.map((p) => <PromptItemRow key={`p:${p.id}`} server={tr.server} p={p} sheets={sheets} />),
          ...(tr.groups.length || tr.prompts.length ? [] : [<EmptyRow key="empty" testID={S4_TID.emptyRow} text="Empty" />]),
        ]}
      </RowGroup>
    ));
  };

  return (
    <ScrollView testID={S4_TID.libScreen} keyboardShouldPersistTaps="handled" style={{ backgroundColor: t.panel }} contentContainerStyle={[styles.content, { paddingBottom: bottom + PHONE.margin }]}>
      <View style={[styles.searchBand, { backgroundColor: t.bg, borderColor: t.line }]}>
        <SearchField testID={S4_TID.search} value={query} onChangeText={setQuery} placeholder="Search prompts" />
      </View>
      {fileNotices(libs).map((n) => <View key={n.server} style={styles.notice}><NoticeRow testID={S4_TID.fileNotice} data={{ server: n.server }} text={n.text} /></View>)}
      {body()}
      {libs.length ? <Text testID={S4_TID.foot} size={TYPE.secondary} tone="muted" style={styles.foot}>{LIBRARY_FOOT}</Text> : null}
      {sheets.node}
    </ScrollView>
  );
}

/** The bar's "+": a P1 sheet "New in Prompt library" with New prompt and New group, which go to the top of the first connected library. */
export function LibraryPlus(_p: { params: Record<string, never> }) {
  const libs = useLibraries();
  const [open, setOpen] = useState(false);
  const at = plusPlace(libs), reason = plusReason(libs) || undefined;
  return (
    <>
      <IconButton testID={S4_TID.plus} size="touch" title="New in Prompt library" onPress={() => setOpen(true)}>
        {(color) => <PlusGlyph size={22} color={color} />}
      </IconButton>
      <ActionSheet open={open} onClose={() => setOpen(false)} head={{ title: "New in Prompt library", sub: plusSub(libs) }}
        items={[
          { id: "new-prompt", label: "New prompt", icon: <DocGlyph />, waitReason: reason, onPress: () => { if (at) openEditor({ mode: "new", at }); } },
          { id: "new-group", label: "New group", icon: <FolderGlyph />, waitReason: reason, onPress: () => { if (at) openGroupForm({ mode: "new", at }); } },
        ]} />
    </>
  );
}

const styles = StyleSheet.create({
  content: {},
  searchBand: { paddingVertical: 8, marginBottom: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  none: { marginHorizontal: PHONE.margin, paddingVertical: 12 },
  foot: { marginHorizontal: PHONE.margin, marginTop: -8 },
  notice: { marginHorizontal: PHONE.margin, marginBottom: 12 },
  emptyCard: { padding: PHONE.margin, gap: 12 },
});
