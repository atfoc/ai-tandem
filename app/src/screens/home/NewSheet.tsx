// The "New" sheet of "+ New" (ux-improvements goal 3.4, package H2; plans/ux-improvements/h2-design.md §4, mockups 11a, 11b): where first (a card
// with the server and the group, pre-chosen to the place the person is in), a bigger gap, then what to make (Chat and Whiteboard as tiles, Group
// as a row). The card's Change pushes the Where page inside the same sheet: one level of the selected server's tree at a time.
import { useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import { ungroupedOn } from "@aiwb/core/logic/keys.ts";

import { haptic } from "../../platform/haptics";
import { AgentGlyph, BoardIcon, DisclosureChevron, Folder, GroupIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Sheet } from "../../ui/Sheet.tsx";
import { SheetHead } from "../../ui/SheetHead.tsx";
import { toneOf, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { attempt, addBoard, newChat } from "../shell/nav.ts";
import { newGroup } from "../sidebar/actions.ts";
import { H2_TID } from "./h2ids.ts";
import { H1_TID } from "./ids.ts";
import { cardWords, chosenKey, crumbs, groupsHeading, putText, whereView } from "./newmodel.ts";
import { closeNewSheet, useNewSheet, type NewPlace } from "./newsheet.ts";
import { openRename } from "./RenameSheet.tsx";
import { usePlaceData } from "./useplace.ts";

const TILE_HEIGHT = 100; // Chat and Whiteboard
const GAP = 24; // between the Where card and "What to make"
const DISMISS_MS = 400; // how long iOS takes to dismiss a sheet (FormSheet waits the same)

export function NewSheetHost() {
  const place = useNewSheet();
  return place ? <NewSheet place={place} /> : null;
}

/** Open at a place: mounted while the sheet is open, so its page and its choice start over each time. */
function NewSheet({ place }: { place: NewPlace }) {
  const { server } = place;
  const { view, input } = usePlaceData(server);
  const word = useServerWord(view ?? { state: "unreachable" });
  const dot = toneOf(useTokens(), word.tone);
  const serverName = view?.name ?? "this server";
  const here = place.groups[place.groups.length - 1] ?? "";
  const [page, setPage] = useState<"what" | "where">("what");
  const [picked, setPicked] = useState(here); // the group things are made in ("" = the top)
  const [level, setLevel] = useState(here); // the level the Where page shows
  const chosen = input ? chosenKey(input, server, picked) : picked;
  const where = useMemo(() => (input ? whereView(input, server, page === "where" ? level : chosen) : { path: [], children: [] }), [input, server, page, level, chosen]);
  const goWhere = () => { setLevel(chosen); setPage("where"); };
  const goWhat = () => setPage("what");

  const group = chosen || ungroupedOn(server);
  const make = (run: () => void) => () => { haptic("impact"); closeNewSheet(); run(); };
  const makeChat = make(() => { void newChat({ group }); });
  const makeBoard = make(() => addBoard(group));
  // (the Rename sheet rises once this one is gone: iOS shows no second modal while the first is still going, about 0.3 s)
  const makeGroup = make(() => attempt("Couldn't create the group", async () => {
    const gone = new Promise((done) => setTimeout(done, Platform.OS === "web" ? 0 : DISMISS_MS));
    const key = await newGroup(server, chosen);
    await gone;
    openRename({ kind: "group", key });
  }));

  const head = page === "what"
    ? <SheetHead title="New" />
    : <SheetHead title="Where" left={{ label: "‹ New", onPress: goWhat }} right={{ label: "Done", onPress: goWhat, strong: true }} />;
  return (
    <Sheet open onClose={closeNewSheet} label={page === "what" ? "New" : "Where"} testID={H1_TID.newSheet} dataSet={{ page, group: chosen }} head={head}>
      {page === "what"
        ? <What serverName={serverName} path={where.path} here={chosen === here} tone={dot} wordText={word.text}
            onChange={goWhere} onChat={makeChat} onBoard={makeBoard} onGroup={makeGroup} />
        : <Where serverName={serverName} path={where.path} children={where.children} chosen={chosen} tone={dot} wordText={word.text}
            onLevel={setLevel} onPut={(key) => { haptic("select"); setPicked(key); goWhat(); }} />}
    </Sheet>
  );
}

// ---------------------------------------------------------------- page 1

type WhatProps = {
  serverName: string; path: { key: string; name: string }[]; here: boolean; tone: string; wordText: string;
  onChange(): void; onChat(): void; onBoard(): void; onGroup(): void;
};

function What({ serverName, path, here, tone, wordText, onChange, onChat, onBoard, onGroup }: WhatProps) {
  const t = useTokens();
  const card = cardWords(serverName, path, here);
  return (
    <View style={styles.page}>
      <Text size={TYPE.secondary} tone="muted" style={styles.caps} accessibilityRole="header">Where</Text>
      <Pressable {...tid(H2_TID.newWhere, { group: path.at(-1)?.key ?? "" })} accessibilityRole="button" onPress={onChange}
        accessibilityLabel={`Where: ${card.title}, ${serverName}, ${card.note}. Change`}
        style={({ pressed }: { pressed: boolean }) => [styles.card, { borderColor: t.line, backgroundColor: pressed ? t.hover2 : t.bg }]}>
        <FolderTile />
        <View style={styles.words}>
          <Text size={TYPE.control} numberOfLines={1}>{card.title}</Text>
          <View style={styles.sub}>
            <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: tone }]} />
            <Text size={TYPE.secondary} tone="muted" numberOfLines={2} style={styles.subText} accessibilityHint={wordText}>{serverName} · {card.note}</Text>
          </View>
        </View>
        <View {...tid(H2_TID.newChange)} style={styles.change}>
          <Text size={TYPE.control} tone="accent">Change</Text>
          <DisclosureChevron color={t.accent} />
        </View>
      </Pressable>

      <Text size={TYPE.secondary} tone="muted" style={[styles.caps, { marginTop: GAP }]} accessibilityRole="header">What to make</Text>
      <View style={styles.tiles}>
        <MakeTile id={H2_TID.newChat} title="Chat" note="Talk to an agent" onPress={onChat}
          glyph={<View style={[styles.glyph, { backgroundColor: t.claudeSoft, borderColor: t.claude }]}><AgentGlyph agent="claude" size={18} /></View>} />
        <MakeTile id={H2_TID.newBoard} title="Whiteboard" note="A board agents can draw on" onPress={onBoard}
          glyph={<View style={[styles.glyph, { backgroundColor: t.accentSoft, borderColor: t.accent }]}><BoardIcon size={18} color={t.accent} /></View>} />
      </View>
      <Pressable {...tid(H2_TID.newGroup)} accessibilityRole="button" accessibilityLabel="Group, name it next" onPress={onGroup}
        style={({ pressed }: { pressed: boolean }) => [styles.groupRow, { borderColor: t.line, backgroundColor: pressed ? t.hover2 : t.bg }]}>
        <GroupIcon size={20} color={t.muted} />
        <Text size={TYPE.control} style={styles.rowName}>Group</Text>
        <Text size={TYPE.secondary} tone="muted">Name it next</Text>
        <DisclosureChevron color={t.faint} />
      </Pressable>
      <Text size={TYPE.secondary} tone="muted" style={styles.foot}>A chat on a board starts from the board</Text>
    </View>
  );
}

function MakeTile({ id, title, note, glyph, onPress }: { id: string; title: string; note: string; glyph: ReactNode; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(id)} accessibilityRole="button" accessibilityLabel={`${title}, ${note}`} onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.tile, { borderColor: t.line, backgroundColor: pressed ? t.hover2 : t.bg }]}>
      {glyph}
      <View>
        <Text size={TYPE.control}>{title}</Text>
        <Text size={TYPE.secondary} tone="muted">{note}</Text>
      </View>
    </Pressable>
  );
}

function FolderTile() {
  const t = useTokens();
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.folder, { borderColor: t.line2, backgroundColor: t.panel }]}>
      <Folder size={20} color={t.muted} />
    </View>
  );
}

// ---------------------------------------------------------------- page 2

type WhereProps = {
  serverName: string; path: { key: string; name: string }[]; children: { key: string; name: string }[]; chosen: string; tone: string; wordText: string;
  onLevel(key: string): void; onPut(key: string): void;
};

function Where({ serverName, path, children, chosen, tone, wordText, onLevel, onPut }: WhereProps) {
  const t = useTokens();
  const levelKey = path.at(-1)?.key ?? "";
  const picked = levelKey === chosen;
  return (
    <View style={styles.page}>
      <View style={styles.sub} accessible accessibilityLabel={`${serverName}, ${wordText}. Things are made on the server Home shows`}>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: tone }]} />
        <Text size={TYPE.secondary} tone="muted">{serverName}</Text>
      </View>
      <Text size={TYPE.secondary} tone="muted" style={styles.note}>Things are made on the server Home shows</Text>

      <View style={styles.crumbs}>
        {crumbs(serverName, path).map((c, i) => (
          <View key={c.key || "top"} style={styles.crumb}>
            {i > 0 ? <Text size={TYPE.secondary} tone="faint">›</Text> : null}
            {c.current
              ? <Text {...tid(H2_TID.newCrumb, { group: c.key })} size={TYPE.control} numberOfLines={1} style={styles.crumbText}>{c.name}</Text>
              : <Pressable {...tid(H2_TID.newCrumb, { group: c.key })} accessibilityRole="button" accessibilityLabel={`Go up to ${c.name}`} onPress={() => onLevel(c.key)} style={styles.crumbPress}>
                  <Text size={TYPE.control} tone="accent" numberOfLines={1}>{c.name}</Text>
                </Pressable>}
          </View>
        ))}
      </View>

      <Pressable {...tid(H2_TID.newPut, { group: levelKey })} accessibilityRole="button" accessibilityState={{ selected: picked }} onPress={() => onPut(levelKey)}
        style={[styles.put, { backgroundColor: t.accentSoft }]}>
        <FolderTile />
        <Text size={TYPE.control} numberOfLines={2} style={styles.rowName}>{putText(serverName, path)}</Text>
        {picked ? <Text size={TYPE.control} tone="accent" accessibilityLabel="Chosen">✓</Text> : null}
      </Pressable>

      {children.length ? <Text size={TYPE.secondary} tone="muted" style={[styles.caps, styles.heading]} accessibilityRole="header">{groupsHeading(serverName, path)}</Text> : null}
      {children.map((g, i) => (
        <Pressable key={g.key} {...tid(H2_TID.newLevel, { group: g.key })} accessibilityRole="button" accessibilityLabel={`${g.name}, open`} onPress={() => onLevel(g.key)}
          style={({ pressed }: { pressed: boolean }) => [styles.level, pressed && { backgroundColor: t.hover2 }]}>
          <FolderTile />
          <View style={[styles.levelBody, i < children.length - 1 && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
            <Text size={TYPE.control} numberOfLines={1} style={styles.rowName}>{g.name}</Text>
            <DisclosureChevron color={t.faint} />
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: PHONE.margin - 8, paddingTop: 12, paddingBottom: 8 },
  caps: { textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 },
  card: { minHeight: 60, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1, borderRadius: 10 },
  folder: { width: 40, height: 32, borderWidth: 1, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  words: { flex: 1, minWidth: 0 },
  sub: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  subText: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  change: { minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 4 },
  tiles: { flexDirection: "row", gap: 12 },
  tile: { flex: 1, minHeight: TILE_HEIGHT, borderWidth: 1, borderRadius: 10, padding: 12, justifyContent: "space-between", gap: 8 },
  glyph: { width: 32, height: 32, borderWidth: 1.5, borderRadius: 4, alignItems: "center", justifyContent: "center" },
  groupRow: { minHeight: PHONE.sheetRow, marginTop: 12, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10 },
  rowName: { flex: 1, minWidth: 0 },
  foot: { marginTop: 12 },
  note: { marginTop: 2 },
  crumbs: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 8, marginTop: 8 },
  crumb: { flexDirection: "row", alignItems: "center", gap: 8 },
  crumbPress: { minHeight: PHONE.target, justifyContent: "center" },
  crumbText: { minHeight: PHONE.target, textAlignVertical: "center", lineHeight: PHONE.target },
  put: { minHeight: PHONE.cell + 4, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 4 },
  heading: { marginTop: 16, marginBottom: 2 },
  level: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: 12 },
  levelBody: { flex: 1, minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 10, paddingRight: 12 },
});
