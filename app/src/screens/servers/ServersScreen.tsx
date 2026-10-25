// The Servers list on the phone (goal 3.8.2, mockup "03 Servers — list", dl-03a): pushed under Settings, one A–Z list of 64 pt rows
// (tile, name, state word, then the host or, for a problem, its reason; no buttons), "+ Add server" at the end and a "+" in the bar. Package S2.
//
// The row is composed here, not a `Cell`: its second line is a state word with its dot followed by the host or the reason, which a Cell's string `sub`
// cannot draw. It takes the cell's metrics, tokens and separator.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { listed } from "@aiwb/core/state/serversdialog.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import type { StateWord as Word } from "@aiwb/core/logic/statewords.ts";

import { useStore } from "../../state/useStore.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { DisclosureChevron } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { StateWord, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { WORDS, rowLine, sortedServers, tileOf } from "./facts.ts";
import { S2_TID } from "./ids.ts";
import { ownerThings, rowsOf } from "./model.ts";
import { openAddServer, openServer } from "./open.ts";
import { said } from "./parts.tsx";
import { ServerTile } from "./Tile.tsx";

/** A row of the list (goal 3.8.2: 64 pt). */
const ROW = 64;
const TILE = { w: 30, h: 37, gap: 12 } as const;

function ServerListRow({ v, last }: { v: ServerView; last: boolean }) {
  const t = useTokens();
  const word: Word = useServerWord(v);
  const line = rowLine(v, word);
  const spoken = [v.name, word.text, line.text].filter(Boolean).join(", ");
  return (
    <Pressable {...tid(S2_TID.row, { server: v.id, word: word.key })} onPress={() => openServer(v.id)} accessibilityRole="button" accessibilityLabel={spoken}
      style={({ pressed }: { pressed: boolean }) => [styles.row, pressed && { backgroundColor: t.hover2 }]}>
      <ServerTile kind={tileOf(word)} size={TILE.w} height={TILE.h} />
      <View style={styles.words}>
        <Text size={TYPE.control} numberOfLines={1}>{v.name}</Text>
        <View style={styles.second}>
          <View style={styles.word}><StateWord word={word} /></View>
          {line.text ? <Text size={TYPE.secondary} tone="muted" style={styles.dot}>·</Text> : null}
          {line.text ? <Text size={TYPE.secondary} tone="muted" mono={line.mono} numberOfLines={1} style={styles.host}>{line.text}</Text> : null}
        </View>
      </View>
      <DisclosureChevron color={t.faint} />
      {last ? null : <View pointerEvents="none" style={[styles.separator, { left: PHONE.margin + TILE.w + TILE.gap, backgroundColor: t.line }]} />}
    </Pressable>
  );
}

export function ServersScreen(_: { params: Record<string, never> }) {
  const t = useTokens();
  const servers = useStore((s) => s.servers);
  const notice = useStore((s) => s.serversNotice);
  const [err, setErr] = useState("");
  const list = sortedServers(rowsOf(servers, ownerThings()));
  // The notice, which no snapshot carries (as the wide dialog reads it). The entries are the stream's.
  useEffect(() => { serversApi.list().then(listed, (e) => setErr(said(e))); }, []);
  return (
    <ScrollView {...tid(S2_TID.list)} style={{ backgroundColor: t.panel }} contentContainerStyle={styles.page}>
      {notice ? <View {...tid("servers-notice")} style={[styles.notice, { backgroundColor: t.warnSoft, borderColor: t.warn }]}><Text selectable size={TYPE.secondary}>{notice}</Text></View> : null}
      {err ? <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: t.dangerSoft, borderColor: t.danger }]}><Text selectable size={TYPE.secondary} tone="danger">{err}</Text></View> : null}
      {list.length ? (
        <CellGroup title="Servers">
          {list.map((v, i) => <ServerListRow key={v.id} v={v} last={i === list.length - 1} />)}
        </CellGroup>
      ) : null}
      <CellGroup footer={WORDS.listFoot}>
        <Cell label="Add server" tone="accent" leading={<Text size={TYPE.control} tone="accent">+</Text>} onPress={() => openAddServer()} chevron={false} testID={S2_TID.add} />
      </CellGroup>
    </ScrollView>
  );
}

/** The bar's "+": opens the add flow. */
export function ServersPlus(_: { params: Record<string, never> }) {
  return (
    <IconButton size="touch" title="Add server" accessibilityLabel="Add server" testID={S2_TID.plus} onPress={() => openAddServer()}>
      {() => <Text size={TYPE.h2} tone="accent">+</Text>}
    </IconButton>
  );
}

const styles = StyleSheet.create({
  page: { paddingTop: 12, paddingBottom: 24 },
  notice: { marginHorizontal: PHONE.margin, marginBottom: 12, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, borderWidth: 1 },
  row: { minHeight: ROW, flexDirection: "row", alignItems: "center", gap: TILE.gap, paddingHorizontal: PHONE.margin, paddingVertical: 6 },
  words: { flex: 1, minWidth: 0, gap: 2 },
  second: { flexDirection: "row", alignItems: "center" },
  word: { flexShrink: 0 },
  dot: { marginHorizontal: 6 },
  host: { flexShrink: 1 },
  separator: { position: "absolute", right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
});
