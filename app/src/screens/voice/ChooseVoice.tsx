// Choose voice (P5 `choose-voice`, S3 goal 3.7.3): the voices of the service as one card of rows under an always-visible search. A tap on a row
// chooses the voice and stays, so voices can be compared; the 44 pt circle plays the voice's own sample (no credits, goal 4.9) and, while it
// plays, stops it. The short list first with the chosen voice at its top; "Show all voices" and "More voices" page the full list; a search
// reads the full list. Nothing is asked of the service until this screen opens (goal 4.5). A sample that cannot play says why on its row.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { setVoiceSettings, useVoiceProblem, useVoiceSettings, voice } from "../../voice/index.ts";
import type { VoiceInfo, VoiceProblemKind } from "../../voice/index.ts";
import {
  CV_CHOSEN, CV_STOP_SAMPLE, PROBLEM_WORDS, VOICES_COUNT, VOICES_FAILED, VOICES_LOADING, VOICES_MORE, VOICES_NONE, VOICES_PLAY, VOICES_RETRY,
  VOICES_SEARCH, VOICES_SHOW_ALL, VS_PLAYING,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { SearchField } from "../../ui/SearchField.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { S3_TID } from "./ids.ts";
import { rememberVoices } from "./voicecache.ts";
import { canShowAll, markedVoice, voiceList } from "./voicerows.ts";

type Page = { voices: VoiceInfo[]; total: number; cursor: string | null };
type Loaded = { status: "loading" } | { status: "failed"; problem: VoiceProblemKind | null } | ({ status: "ready" } & Page);

/** The voices for the list asked for: `all` the full list (a page at a time), `search` filtering it. A later ask makes an earlier answer stale: it
 *  never overwrites the newer one. Every page is remembered for the Voice screen's description of the chosen voice. */
function useVoices(all: boolean, search: string) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const load = (cursor?: string) => {
    const mine = ++seq.current;
    if (cursor) setMore(true); else setLoaded({ status: "loading" });
    voice.voices({ all, search: all ? search : undefined, cursor }).then(
      (page) => {
        if (mine !== seq.current) return;
        rememberVoices(page.voices);
        setMore(false);
        setLoaded((was) => (cursor && was.status === "ready" ? { status: "ready", voices: [...was.voices, ...page.voices], total: page.total, cursor: page.cursor } : { status: "ready", ...page }));
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setMore(false);
        setLoaded({ status: "failed", problem: (e as { kind?: VoiceProblemKind } | null)?.kind ?? null });
      },
    );
  };
  useEffect(() => {
    load();
    return () => { seq.current++; };
  }, [all, search]);
  return { loaded, more, loadMore: (cursor: string) => load(cursor), reload: () => load() };
}

const PlayGlyph = ({ color }: { color: string }) => (
  <Svg width={16} height={16} viewBox="0 0 12 12"><Path d="M3 1.8v8.4a.5.5 0 0 0 .76.43l6.7-4.2a.5.5 0 0 0 0-.86l-6.7-4.2A.5.5 0 0 0 3 1.8z" fill={color} /></Svg>
);
const StopGlyph = ({ color }: { color: string }) => (
  <Svg width={14} height={14} viewBox="0 0 12 12"><Rect x={2} y={2} width={8} height={8} rx={1} fill={color} /></Svg>
);

export function ChooseVoice() {
  const t = useTokens();
  const chosen = useVoiceSettings((s) => s.voiceId);
  const chosenName = useVoiceSettings((s) => s.voiceName);
  const problem = useVoiceProblem();
  // The order is the one the screen opened with: a tap moves the ✓, not the rows, so voices can be compared where they are.
  const opened = useRef({ id: chosen, name: chosenName });
  const [all, setAll] = useState(false);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => { const id = setTimeout(() => setSearch(typed.trim()), 300); return () => clearTimeout(id); }, [typed]);
  const listAll = all || search !== "";
  const { loaded, more, loadMore, reload } = useVoices(listAll, search);

  // Leaving the screen: a sample in play stops, and a sample's problem (said on its row) is not left for a popover elsewhere.
  const problemAnchor = useRef<string | undefined>(undefined);
  problemAnchor.current = problem?.anchor;
  useEffect(() => () => {
    voice.stopPreview();
    if (problemAnchor.current?.startsWith("preview:")) voice.dismissProblem();
  }, []);

  const play = (id: string) => {
    setPlaying(id);
    void voice.playPreview(id).finally(() => setPlaying((p) => (p === id ? null : p)));
  };
  const stop = () => voice.stopPreview();

  let body: React.ReactNode;
  if (loaded.status === "loading") {
    body = <CellGroup><Cell testID={S3_TID.cvLoading} label={VOICES_LOADING} /></CellGroup>;
  } else if (loaded.status === "failed") {
    body = (
      <View {...tid(S3_TID.cvFailed)} style={styles.failed}>
        <Text size={TYPE.secondary} tone="danger">{loaded.problem ? PROBLEM_WORDS[loaded.problem].sentence : VOICES_FAILED}</Text>
        <Button {...tid(S3_TID.cvRetry)} size="touch" label={VOICES_RETRY} onPress={reload} />
      </View>
    );
  } else {
    const rows = voiceList(loaded.voices, opened.current.id, opened.current.name, listAll);
    const marked = markedVoice(rows, chosen);
    body = (
      <>
        {rows.length === 0 ? (
          <CellGroup><Cell testID={S3_TID.cvNone} label={VOICES_NONE} /></CellGroup>
        ) : (
          <View style={styles.group}>
            <View style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
              {rows.map((v, i) => (
                <VoiceRow key={v.id} v={v} last={i === rows.length - 1} selected={v.id === marked} playing={playing === v.id}
                  problem={problem?.anchor === `preview:${v.id}` ? problem : null}
                  onPick={() => setVoiceSettings({ voiceId: v.id, voiceName: v.name })} onPlay={() => play(v.id)} onStop={stop} />
              ))}
            </View>
          </View>
        )}
        {rows.length > 0 ? <Text {...tid(S3_TID.cvCount)} size={TYPE.secondary} tone="muted" style={styles.count}>{VOICES_COUNT(loaded.voices.length, loaded.total)}</Text> : null}
        {listAll && loaded.cursor ? (
          <CellGroup>
            <Pressable {...tid(S3_TID.cvMore)} accessibilityRole="button" accessibilityLabel={VOICES_MORE} disabled={more} onPress={() => loadMore(loaded.cursor!)}
              style={({ pressed }: { pressed: boolean }) => [styles.link, pressed && { backgroundColor: t.hover2 }, more && styles.off]}>
              <Text size={TYPE.control} tone="accent">{more ? VOICES_LOADING : VOICES_MORE}</Text>
            </Pressable>
          </CellGroup>
        ) : null}
        {canShowAll(listAll, rows.length, loaded.total, loaded.cursor) ? (
          <CellGroup>
            <Pressable {...tid(S3_TID.cvAll)} accessibilityRole="button" accessibilityLabel={VOICES_SHOW_ALL} onPress={() => setAll(true)}
              style={({ pressed }: { pressed: boolean }) => [styles.link, pressed && { backgroundColor: t.hover2 }]}>
              <Text size={TYPE.control} tone="accent">{VOICES_SHOW_ALL}</Text>
            </Pressable>
          </CellGroup>
        ) : null}
      </>
    );
  }

  return (
    <View {...tid(S3_TID.cvScreen)} style={[styles.fill, { backgroundColor: t.panel }]}>
      <View style={[styles.search, { backgroundColor: t.bg, borderBottomColor: t.line }]}>
        <SearchField testID={S3_TID.cvSearch} value={typed} onChangeText={setTyped} placeholder={VOICES_SEARCH} />
      </View>
      <ScrollView style={styles.fill} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">{body}</ScrollView>
    </View>
  );
}

/** One voice: the 44 pt play/stop circle, the name, "Playing sample…" or the description, and the ✓ of the chosen. A tap on the words chooses. */
function VoiceRow({ v, last, selected, playing, problem, onPick, onPlay, onStop }: {
  v: VoiceInfo; last: boolean; selected: boolean; playing: boolean; problem: { kind: VoiceProblemKind; retry?: () => void } | null;
  onPick(): void; onPlay(): void; onStop(): void;
}) {
  const t = useTokens();
  return (
    <View {...tid(S3_TID.cvRow, { voice: v.id, selected })} style={[styles.row, !last && { borderBottomColor: t.line, borderBottomWidth: StyleSheet.hairlineWidth }]}>
      <Pressable {...tid(S3_TID.cvPlay, { voice: v.id, playing })} accessibilityRole="button" accessibilityLabel={playing ? CV_STOP_SAMPLE : VOICES_PLAY(v.name)}
        onPress={playing ? onStop : onPlay} style={[styles.play, { backgroundColor: playing ? t.accentFill : t.accentSoft }]}>
        {playing ? <StopGlyph color={t.onAccent} /> : <PlayGlyph color={t.accent} />}
      </Pressable>
      <Pressable accessibilityRole="radio" accessibilityState={{ checked: selected }} accessibilityLabel={selected ? `${v.name}, ${CV_CHOSEN}` : v.name} onPress={onPick}
        style={({ pressed }: { pressed: boolean }) => [styles.words, pressed && { backgroundColor: t.hover2 }]}>
        <View style={styles.text}>
          <Text size={TYPE.control} numberOfLines={1}>{v.name}</Text>
          {playing ? <Text size={TYPE.secondary} tone="accent">{VS_PLAYING}</Text> : null}
          {v.about ? <Text size={TYPE.secondary} tone="muted" numberOfLines={2}>{v.about}</Text> : null}
          {problem ? (
            <View {...tid(S3_TID.cvProblem, { kind: problem.kind })} style={styles.problem}>
              <Text size={TYPE.secondary} tone="danger" accessibilityLiveRegion="polite" style={styles.fill}>{PROBLEM_WORDS[problem.kind].sentence}</Text>
              {problem.retry ? (
                <Pressable accessibilityRole="button" accessibilityLabel={VOICES_RETRY} onPress={() => { voice.dismissProblem(); problem.retry!(); }} hitSlop={8}>
                  <Text size={TYPE.secondary} tone="accent" weight="600">{VOICES_RETRY}</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
        {selected ? <Text size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  search: { paddingHorizontal: PHONE.margin, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  body: { paddingTop: 8, paddingBottom: 32 },
  group: { marginHorizontal: PHONE.margin, marginBottom: 6 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingLeft: PHONE.margin, minHeight: PHONE.listRow },
  play: { width: PHONE.target, height: PHONE.target, borderRadius: PHONE.target / 2, alignItems: "center", justifyContent: "center" },
  words: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingRight: PHONE.margin },
  text: { flex: 1, minWidth: 0, gap: 1 },
  problem: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 2 },
  count: { marginHorizontal: PHONE.margin, marginBottom: 16 },
  link: { minHeight: PHONE.cell, alignItems: "center", justifyContent: "center", paddingHorizontal: PHONE.margin },
  off: { opacity: 0.5 },
  failed: { marginHorizontal: PHONE.margin, gap: 10, alignItems: "flex-start" },
});
