// The "Voice" section of Settings (VC-13, goal 3.7): the first four voices of the service with the chosen one first, a play button on each
// that plays the voice's own preview clip (no credits, goal 4.9), and "Show all voices" for the full list with a search and more pages.
// The choice is `voiceId`/`voiceName` of the voice settings, the one value the speech and the pill speak with.
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import Svg, { Path } from "react-native-svg";

import { setVoiceSettings, useVoiceSettings, voice } from "../../voice/index.ts";
import type { VoiceInfo, VoiceProblemKind } from "../../voice/index.ts";
import {
  PROBLEM_WORDS, VOICES_COUNT, VOICES_FAILED, VOICES_LOADING, VOICES_MORE, VOICES_NONE, VOICES_NO_KEY, VOICES_PLAY, VOICES_RETRY, VOICES_SEARCH,
  VOICES_SHOW_ALL, VOICES_SHOW_FEWER,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { ProblemPopover } from "./ProblemPopover.tsx";

type Page = { voices: VoiceInfo[]; total: number; cursor: string | null };
type Loaded = { status: "loading" } | { status: "failed"; problem: VoiceProblemKind | null } | ({ status: "ready" } & Page);

const PlayGlyph = ({ color }: { color: string }) => (
  <Svg width={12} height={12} viewBox="0 0 12 12"><Path d="M3 1.8v8.4a.5.5 0 0 0 .76.43l6.7-4.2a.5.5 0 0 0 0-.86l-6.7-4.2A.5.5 0 0 0 3 1.8z" fill={color} /></Svg>
);

/** The voices of the service for a key: `all` the full list (30 a page), else the short one. `search` filters the full list; `stamp` reloads (a key was saved or removed). */
function useVoices(enabled: boolean, all: boolean, search: string, stamp: number) {
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const load = (cursor?: string) => {
    const mine = ++seq.current;
    if (cursor) setMore(true); else setLoaded({ status: "loading" });
    voice.voices({ all, search: all ? search : undefined, cursor }).then(
      (page) => {
        if (mine !== seq.current) return;
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
    if (!enabled) { seq.current++; return; }
    load();
    return () => { seq.current++; };
  }, [enabled, all, search, stamp]);
  return { loaded, more, loadMore: (cursor: string) => load(cursor), reload: () => load() };
}

/** The list put as the dialog shows it: the chosen voice first (the short list only; the full list stays in the service's order). With none chosen the
 *  first of the list is the one that will speak, so it is the one marked. */
function ordered(voices: VoiceInfo[], chosen: string | null, all: boolean): VoiceInfo[] {
  const at = chosen ? voices.findIndex((v) => v.id === chosen) : -1;
  return !all && at > 0 ? [voices[at], ...voices.slice(0, at), ...voices.slice(at + 1)] : voices;
}

export function VoiceChoice({ hasKey, stamp }: { hasKey: boolean | null; stamp: number }) {
  const { tokens: t } = useTheme();
  const chosen = useVoiceSettings((s) => s.voiceId);
  const chosenName = useVoiceSettings((s) => s.voiceName);
  const [all, setAll] = useState(false);
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);
  const [focus, setFocus] = useState(false);
  useEffect(() => { const id = setTimeout(() => setSearch(typed.trim()), 300); return () => clearTimeout(id); }, [typed]);
  const { loaded, more, loadMore, reload } = useVoices(hasKey === true, all, search, stamp);

  if (hasKey === false) return <Text {...tid("vs-voices-nokey")} size={12} tone="muted">{VOICES_NO_KEY}</Text>;

  // The search box stays where it is while a page loads, or typing would lose its focus at every pause.
  const search_ = all ? (
    <TextInput {...tid("vs-voices-search")} value={typed} onChangeText={setTyped} placeholder={VOICES_SEARCH} accessibilityLabel={VOICES_SEARCH} aria-label={VOICES_SEARCH}
      placeholderTextColor={t.faint} autoCapitalize="none" autoCorrect={false} spellCheck={false} autoComplete="off"
      onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      style={[styles.search, { color: t.text, backgroundColor: t.bg, borderColor: focus ? t.accent : t.line2 }, webStyle({ outlineStyle: "none" }) as object]} />
  ) : null;
  let body: React.ReactNode;
  if (hasKey === null || loaded.status === "loading") {
    body = <Text {...tid("vs-voices-loading")} size={12} tone="muted">{VOICES_LOADING}</Text>;
  } else if (loaded.status === "failed") {
    body = (
      <View {...tid("vs-voices-failed")} style={styles.stack}>
        <Text size={12} tone="danger">{loaded.problem ? PROBLEM_WORDS[loaded.problem].sentence : VOICES_FAILED}</Text>
        <Button size="sm" label={VOICES_RETRY} testID="vs-voices-retry" onPress={reload} />
      </View>
    );
  } else {
    const shown = ordered(loaded.voices, chosen, all);
    const effective = chosen ?? (shown[0]?.id ?? null);
    // A chosen voice that the page does not list is still shown, first, by the name kept with it.
    const missing = !all && chosen && chosenName && !shown.some((v) => v.id === chosen) ? { id: chosen, name: chosenName, about: "", previewUrl: null } : null;
    const rows = missing ? [missing, ...shown] : shown;
    const play = (id: string) => { setPlaying(id); void voice.playPreview(id).finally(() => setPlaying((p) => (p === id ? null : p))); };
    body = (
      <>
        {rows.length === 0 ? <Text {...tid("vs-voices-none")} size={12} tone="muted">{VOICES_NONE}</Text> : null}
        {rows.map((v) => <VoiceRow key={v.id} v={v} selected={v.id === effective} playing={playing === v.id} onPick={() => setVoiceSettings({ voiceId: v.id, voiceName: v.name })} onPlay={() => play(v.id)} />)}
        {all && loaded.cursor ? <Button size="sm" label={more ? VOICES_LOADING : VOICES_MORE} testID="vs-voices-more" disabled={more} onPress={() => loadMore(loaded.cursor!)} /> : null}
        {all ? <Text {...tid("vs-voices-count")} size={11} tone="faint">{VOICES_COUNT(loaded.voices.length, loaded.total)}</Text> : null}
        {all || loaded.total > rows.length || loaded.cursor ? (
          <Button size="sm" tone="ghost" label={all ? VOICES_SHOW_FEWER : VOICES_SHOW_ALL} testID="vs-voices-all" aria-expanded={all}
            onPress={() => { setAll(!all); setTyped(""); setSearch(""); }} />
        ) : null}
      </>
    );
  }
  return <View {...tid("vs-voices", { all })} style={styles.stack}>{search_}{body}</View>;
}

/** One voice: the radio (name, a few words) and its play button (a voice the service gave no clip for plays nothing). */
function VoiceRow({ v, selected, playing, onPick, onPlay }: { v: VoiceInfo; selected: boolean; playing: boolean; onPick(): void; onPlay(): void }) {
  const { tokens: t } = useTheme();
  const ref = useRef<View>(null);
  return (
    <View {...tid("vs-voice-row", { voice: v.id, selected })} style={[styles.voice, { borderColor: selected ? t.accent : t.line, backgroundColor: selected ? t.accentSoft : t.bg }]}>
      <Pressable {...tid("vs-voice", { voice: v.id })} role="radio" aria-checked={selected} accessibilityState={{ checked: selected }} accessibilityLabel={v.name}
        onPress={onPick} style={[styles.pick, webStyle({ cursor: "pointer" })]}>
        <View style={[styles.radio, { borderColor: selected ? t.accentFill : t.line2 }]}>{selected ? <View style={[styles.dot, { backgroundColor: t.accentFill }]} /> : null}</View>
        <View style={styles.names}>
          <Text weight="600" numberOfLines={1}>{v.name}</Text>
          {v.about ? <Text size={12} tone="muted" numberOfLines={2}>{v.about}</Text> : null}
        </View>
      </Pressable>
      <View ref={ref} collapsable={false}>
        <IconButton {...tid("vs-voice-play", { voice: v.id, playing, playable: !!v.previewUrl })} title={VOICES_PLAY(v.name)} on={playing} onPress={onPlay}
          style={[styles.play, { borderColor: t.line2 }]}>
          {(c) => <PlayGlyph color={c} />}
        </IconButton>
      </View>
      <ProblemPopover anchor={`preview:${v.id}`} target={ref} align="right" />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  search: { fontSize: 13, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
  voice: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 8, paddingRight: 8 },
  pick: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingLeft: 10 },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  names: { flex: 1, minWidth: 0 },
  play: { width: 30, height: 30, borderWidth: 1, borderRadius: 15 },
});
