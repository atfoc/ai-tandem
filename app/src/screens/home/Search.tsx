// Home's search (ux-improvements goal 3.3, package H2; plans/ux-improvements/h2-design.md §6; mockup 09): a mode of Home. The field moves to the top
// with Cancel, the scope chips All · Boards · Chats sit under it, and the body is the recent searches and the recently opened before a word is typed,
// the boards, chats and groups that hold it after, or the sentence that none do with a button to start a chat with those words. It searches the
// server Home shows (its live tree, or the last one Home saw while it is away, faded). What it finds and says is searchmodel.ts's.
import { useEffect, useMemo, useState } from "react";
import { BackHandler, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";

import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { ungroupedOn } from "@aiwb/core/logic/keys.ts";
import { getState, shownBranch } from "@aiwb/core/state/store.ts";
import { putDraft } from "@aiwb/core/state/chatdraft.ts";

import { Button } from "../../ui/Button.tsx";
import { agentClass, AgentGlyph, BoardIcon, DisclosureChevron, GroupIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { SearchField } from "../../ui/SearchField.tsx";
import { useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { newChat, openChat } from "../shell/nav.ts";
import { setHomePlace } from "../shell/homeplace.ts";
import { H2_TID } from "./h2ids.ts";
import type { PlaceInput } from "./model.ts";
import { offlineToast } from "./offline.ts";
import { openItem } from "./open.ts";
import { clearSearches, noteSearch, removeSearch, useOpened, useRecent } from "./recent.ts";
import { closeSearch } from "./search.ts";
import { recentlyOpened, resultCount, SCOPES, searchPlace, type Hit, type Results, type Scope, type Where } from "./searchmodel.ts";

const TILE = 36, ICON = 20, GLYPH = 14;
const SLOP = (PHONE.target - PHONE.chip) / 2;
/** "Clear" is a 13 pt word (about 32 × 19): its slop makes the 44 pt target of goal 3.1.1. */
const CLEAR_SLOP = { top: 13, bottom: 13, left: 8, right: 8 };

export type SearchProps = {
  /** The server Home shows (null on a first run: nothing to search). */
  server: string | null;
  view: ServerView | undefined;
  /** Its tree: the live one, or the last Home kept while the server is away (`stale`); null when there is none. */
  input: PlaceInput | null;
  stale: boolean;
};

export function Search({ server, view, input, stale }: SearchProps) {
  const word = useServerWord({ state: view?.state ?? "unreachable" });
  const [query, setQuery] = useState(""), [scope, setScope] = useState<Scope>("all"), [busy, setBusy] = useState(false);
  const recent = useRecent(), opened = useOpened();
  const serverName = view?.name ?? "";
  const where: Where | null = server ? { server, serverName, ...(stale ? { staleWord: word.text } : {}) } : null;
  const q = query.trim();

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { closeSearch(); return true; });
    return () => sub.remove();
  }, []);

  const results = useMemo((): Results => (input && where ? searchPlace(input, where, q, scope) : { boards: [], chats: [], groups: [] }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, server, serverName, stale, word.text, q, scope]);
  const recents = useMemo(() => (input && where ? recentlyOpened(input, where, opened.filter((o) => o.key)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [input, server, serverName, stale, word.text, opened]);
  const state = q === "" ? "recent" : resultCount(results) > 0 ? "results" : "none";

  const open = (hit: Hit) => {
    if (hit.stale) { offlineToast(serverName); return; }
    if (q) noteSearch(q);
    closeSearch();
    if (hit.kind === "group") setHomePlace({ server: hit.server, groups: hit.groups });
    else openItem(hit);
  };

  const startChat = async () => {
    if (!server || busy) return;
    setBusy(true);
    try {
      const c = await newChat({ group: ungroupedOn(server) }, { open: false });
      if (!c) return;
      await putDraft(c.id, shownBranch(getState(), c.id), { text: q }).catch(() => {});
      noteSearch(q);
      closeSearch();
      openChat(c);
    } finally { setBusy(false); }
  };

  return (
    <View {...tid(H2_TID.search, { scope, state })} style={styles.fill}>
      <View style={styles.field}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search boards and chats" autoFocus onCancel={closeSearch} testID={H2_TID.searchField} />
      </View>
      <View style={styles.scopes}>
        {SCOPES.map((s) => <ScopeChip key={s.scope} scope={s.scope} label={s.label} selected={scope === s.scope} onPress={() => setScope(s.scope)} />)}
      </View>
      <ScrollView style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        {state === "recent" ? (
          <>
            {recent.length ? (
              <>
                <Head label="RECENT SEARCHES" right={
                  <Pressable {...tid(H2_TID.searchClear)} accessibilityRole="button" accessibilityLabel="Clear recent searches" hitSlop={CLEAR_SLOP} onPress={clearSearches}>
                    <Text size={TYPE.secondary} tone="accent">Clear</Text>
                  </Pressable>} />
                {recent.map((w, i) => <RecentWord key={w} word={w} last={i === recent.length - 1} onPress={() => setQuery(w)} />)}
              </>
            ) : null}
            {recents.length ? (
              <>
                <Head label="RECENTLY OPENED" />
                {recents.map((h, i) => <HitRow key={h.key} hit={h} last={i === recents.length - 1} onPress={() => open(h)} />)}
              </>
            ) : null}
          </>
        ) : null}
        {state === "results" ? (
          <>
            {([["boards", "BOARDS"], ["chats", "CHATS"], ["groups", "GROUPS"]] as const).map(([section, label]) => results[section].length === 0 ? null : (
              <View key={section}>
                <Head label={label} count={results[section].length} section={section} />
                {results[section].map((h, i) => <HitRow key={h.key} hit={h} last={i === results[section].length - 1} onPress={() => open(h)} />)}
              </View>
            ))}
          </>
        ) : null}
        {state === "none" ? (
          <View {...tid(H2_TID.searchNone)} style={styles.none}>
            <Text size={TYPE.control}>{`No boards or chats match “${q}”`}</Text>
            <Text size={TYPE.secondary} tone="muted">{serverName ? `Searched ${serverName}.` : "No server to search."}</Text>
            {server && !stale ? (
              <Button {...tid(H2_TID.searchNewChat)} size="touch" label={`New chat “${q}”`} disabled={busy} onPress={startChat} style={styles.newChat} />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ScopeChip({ scope, label, selected, onPress }: { scope: Scope; label: string; selected: boolean; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(H2_TID.searchScope, { scope, selected: String(selected) })} accessibilityRole="button" accessibilityLabel={label}
      accessibilityState={{ selected }} hitSlop={SLOP} onPress={onPress}
      style={[styles.chip, { borderColor: t.line, backgroundColor: selected ? t.text : t.bg }]}>
      <Text size={TYPE.busy} style={{ color: selected ? t.bg : t.text }}>{label}</Text>
    </Pressable>
  );
}

function Head({ label, count, section, right }: { label: string; count?: number; section?: string; right?: React.ReactNode }) {
  return (
    <View {...(section ? tid(H2_TID.searchSection, { section, count: count ?? 0 }) : {})} accessibilityRole="header" style={styles.head}>
      <Text size={TYPE.secondary} tone="muted" style={styles.label}>{label}</Text>
      {right ?? (count !== undefined ? <Text size={TYPE.secondary} tone="muted">{count}</Text> : null)}
    </View>
  );
}

function RecentWord({ word, last, onPress }: { word: string; last: boolean; onPress(): void }) {
  const t = useTokens();
  return (
    <View style={styles.recent}>
      <Pressable {...tid(H2_TID.searchRecent, { words: word })} accessibilityRole="button" accessibilityLabel={`Search for ${word}`} onPress={onPress}
        style={({ pressed }: { pressed: boolean }) => [styles.recentMain, { backgroundColor: pressed ? t.hover2 : t.bg }]}>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.glyph, { borderColor: t.faint }]} />
        <Text size={TYPE.control} numberOfLines={1} style={styles.recentText}>{word}</Text>
      </Pressable>
      <Pressable {...tid(H2_TID.searchRecentRemove, { words: word })} accessibilityRole="button" accessibilityLabel={`Remove ${word}`} onPress={() => removeSearch(word)}
        style={styles.remove}>
        <Text size={TYPE.control} tone="faint">✕</Text>
      </Pressable>
      {last ? null : <View pointerEvents="none" style={[styles.separator, { left: PHONE.margin + GLYPH + 12, backgroundColor: t.line }]} />}
    </View>
  );
}

/** A result or a recently opened row: Home's row look with the matched part of the name in bold; a faded one says the server is away. */
function HitRow({ hit, last, onPress }: { hit: Hit; last: boolean; onPress(): void }) {
  const t = useTokens(), p = hit.parts;
  const soft = (t as Record<string, string>)[agentClass(hit.agent ?? "") + "Soft"] ?? t.panel;
  return (
    <Pressable {...tid(H2_TID.searchRow, { kind: hit.kind, key: hit.key, server: hit.server, stale: String(hit.stale) })}
      accessibilityRole="button" accessibilityLabel={`${hit.name}, ${hit.sub}`} onPress={onPress}
      style={({ pressed }: { pressed: boolean }) => [styles.row, { backgroundColor: pressed ? t.hover2 : t.bg }, hit.stale && styles.stale]}>
      <View style={[styles.tile, hit.kind === "board" && { backgroundColor: t.accentSoft }, hit.kind === "chat" && { backgroundColor: soft }]}>
        {hit.kind === "group" ? <GroupIcon size={ICON} color={t.muted} />
          : hit.kind === "board" ? <BoardIcon size={ICON} color={t.accent} />
          : <AgentGlyph agent={hit.agent ?? ""} size={ICON} />}
      </View>
      <View style={styles.words}>
        <Text size={TYPE.control} numberOfLines={2}>
          {p.before}{p.match ? <Text size={TYPE.control} weight="600">{p.match}</Text> : null}{p.after}
        </Text>
        <Text size={TYPE.secondary} tone="muted" numberOfLines={1}>{hit.sub}</Text>
      </View>
      {hit.kind === "group" ? <DisclosureChevron color={t.faint} /> : null}
      {last ? null : <View pointerEvents="none" style={[styles.separator, { left: PHONE.margin + TILE + 12, backgroundColor: t.line }]} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  field: { paddingTop: 8, paddingBottom: 4 },
  scopes: { flexDirection: "row", gap: 8, paddingHorizontal: PHONE.margin, paddingVertical: SLOP + 4 },
  chip: { height: PHONE.chip, justifyContent: "center", paddingHorizontal: 14, borderRadius: 8, borderWidth: 1 },
  body: { paddingBottom: 24 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: PHONE.margin, paddingTop: 14, paddingBottom: 6 },
  label: { letterSpacing: 0.4 },
  recent: { minHeight: PHONE.target, flexDirection: "row", alignItems: "center" },
  recentMain: { flex: 1, minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: PHONE.margin },
  recentText: { flex: 1 },
  glyph: { width: GLYPH, height: GLYPH, borderRadius: GLYPH / 2, borderWidth: 1.5 },
  remove: { width: PHONE.target, height: PHONE.target, alignItems: "center", justifyContent: "center", marginRight: PHONE.margin / 2 },
  row: { minHeight: PHONE.listRow, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: PHONE.margin, paddingVertical: 8 },
  stale: { opacity: 0.45 },
  tile: { width: TILE, height: TILE, borderRadius: 8, alignItems: "center", justifyContent: "center" },
  words: { flex: 1, minWidth: 0 },
  separator: { position: "absolute", right: 0, bottom: 0, height: StyleSheet.hairlineWidth },
  none: { paddingHorizontal: PHONE.margin, paddingTop: 24, gap: 6, alignItems: "flex-start" },
  newChat: { marginTop: 12 },
});
