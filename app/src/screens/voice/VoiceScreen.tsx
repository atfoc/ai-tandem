// Settings > Voice on the phone (S3, goal 3.8.5): the pushed place screen `voice-settings`, whose bar the stack draws ("‹ Settings"). Without a
// key one card says what voice is and offers the one action; with a key: the key row, the chosen voice, how a spoken turn is sent, the advanced
// options (each a P2 sheet), and Remove key. It reads the keystore (local) and the settings; it asks the service for nothing and lists no device
// until the person uses it (goal 4.5). Every change is a voice setting, the same stored value the speech bar and the pill read.
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { openLink } from "../../platform/openlink";
import { DEFAULTS, PAUSE_MAX_MS, PAUSE_MIN_MS, PAUSE_STEP_MS } from "../../voice/logic/settings.ts";
import { closeVoiceSettings, openVoiceSettings, setVoiceSettings, useVoiceNotice, useVoiceProblem, useVoiceSettings, voice } from "../../voice/index.ts";
import {
  ADVANCED_PAUSE, ADVANCED_PAUSE_VALUE, CV_STOP_SAMPLE, KEY_REMOVE_BODY, KEY_REMOVE_DO, KEY_REMOVE_TITLE, KEY_STORED_NOTE, KEY_TITLE, PROBLEM_WORDS, VOICES_NO_KEY, VOICES_PLAY, VOICES_TITLE, VS_ADD_KEY,
  VS_ADVANCED_TITLE, VS_AUTOSEND, VS_AUTOSEND_FOOTER, VS_CHOOSE_VOICE, VS_GET_KEY, VS_GET_KEY_URL, VS_KEY_SAVED, VS_NO_KEY_FOOTER, VS_PROMO_BODY,
  VS_PROMO_TITLE, VS_REMOVE_KEY, VS_SENDING_TITLE, VS_SKIP_CODE,
} from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { Cell, CellGroup, ControlCell } from "../../ui/Cells.tsx";
import { ConfirmSheet } from "../../ui/ConfirmSheet.tsx";
import { MicIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { PickerSheet } from "../../ui/PickerSheet.tsx";
import { Slider } from "../../ui/Slider.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { pushScreen } from "../shell/screens.ts";
import { Tile } from "../settings/icons.tsx";
import { AddKeySheet } from "./AddKeySheet.tsx";
import { DeviceRows } from "./DeviceRows.tsx";
import { S3_TID } from "./ids.ts";
import { voiceScreenMounted } from "./open.ts";
import { useVoiceInfo } from "./voicecache.ts";
import { advancedRows, chosenVoiceRow, keyState, pickPatch, type AdvancedWhich } from "./voicerows.ts";

/** Whether a key is saved: null until the keystore has answered; `reread` asks again (after Add key saves). A local read, no request. */
function useHasKey() {
  const [has, setHas] = useState<boolean | null>(null);
  const [stamp, setStamp] = useState(0);
  useEffect(() => {
    let live = true;
    voice.hasKey().then((v) => { if (live) setHas(v); }, () => { if (live) setHas(false); });
    return () => { live = false; };
  }, [stamp]);
  return [has, () => setStamp((n) => n + 1), setHas] as const;
}

const KeyGlyph = ({ color }: { color: string }) => (
  <Svg width={17} height={17} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
    <Circle cx="5.5" cy="10.5" r="3" /><Path d="M7.7 8.3 13.5 2.5M11.5 4.5l1.8 1.8M9.8 6.2l1.4 1.4" />
  </Svg>
);
const StopGlyph = ({ color }: { color: string }) => (
  <Svg width={14} height={14} viewBox="0 0 12 12"><Rect x={2} y={2} width={8} height={8} rx={1} fill={color} /></Svg>
);
const PlayGlyph = ({ color }: { color: string }) => (
  <Svg width={16} height={16} viewBox="0 0 12 12"><Path d="M3 1.8v8.4a.5.5 0 0 0 .76.43l6.7-4.2a.5.5 0 0 0 0-.86l-6.7-4.2A.5.5 0 0 0 3 1.8z" fill={color} /></Svg>
);

export function VoiceScreen() {
  const t = useTokens(), bottom = useSafeAreaInsets().bottom;
  const [hasKey, reread, setHasKey] = useHasKey();
  const [adding, setAdding] = useState(false);
  const state = keyState(hasKey);
  // While the screen is mounted it is Settings > Voice for the engine: leaving it ends Settings' notice and a microphone test (open.ts).
  useEffect(() => {
    const unmount = voiceScreenMounted();
    openVoiceSettings();
    return () => { unmount(); closeVoiceSettings(); };
  }, []);
  return (
    <ScrollView {...tid(S3_TID.screen, { key: state })} style={[styles.fill, { backgroundColor: t.panel }]} contentContainerStyle={[styles.body, { paddingBottom: bottom + PHONE.margin }]}>
      {state === "none" ? <NoKey onAdd={() => setAdding(true)} /> : null}
      {state === "saved" ? <Saved onAdd={() => setAdding(true)} onRemoved={() => setHasKey(false)} /> : null}
      <AddKeySheet open={adding} onClose={() => setAdding(false)} onSaved={reread} />
    </ScrollView>
  );
}

/** No key (07b): the card, the privacy line, and the voice row that waits for a key. */
function NoKey({ onAdd }: { onAdd(): void }) {
  const t = useTokens();
  return (
    <>
      <View {...tid(S3_TID.nokeyCard)} style={[styles.card, { backgroundColor: t.bg, borderColor: t.line }]}>
        <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.promoTile, { backgroundColor: t.accentFill }]}><MicIcon size={30} color={t.onAccent} /></View>
        <Text size={TYPE.control} weight="600" accessibilityRole="header">{VS_PROMO_TITLE}</Text>
        <Text size={TYPE.secondary} tone="muted" style={styles.centred}>{VS_PROMO_BODY}</Text>
        <Button {...tid(S3_TID.addKey)} size="block" tone="primary" label={VS_ADD_KEY} onPress={onAdd} style={styles.block} />
        <Pressable {...tid(S3_TID.getKey)} accessibilityRole="link" accessibilityLabel={VS_GET_KEY} onPress={() => openLink(VS_GET_KEY_URL)} style={styles.link}>
          <Text size={TYPE.secondary + 2} tone="accent">{VS_GET_KEY}</Text>
        </Pressable>
      </View>
      <Text size={TYPE.secondary} tone="muted" style={styles.line}>{KEY_STORED_NOTE}</Text>
      <CellGroup title={VOICES_TITLE} footer={VS_NO_KEY_FOOTER}>
        <Cell testID={S3_TID.voiceNokey} label={VOICES_NO_KEY} disabled />
      </CellGroup>
    </>
  );
}

/** A key is saved (07). */
function Saved({ onAdd, onRemoved }: { onAdd(): void; onRemoved(): void }) {
  const t = useTokens();
  const s = useVoiceSettings((x) => x);
  const notice = useVoiceNotice({ kind: "settings" });
  const [which, setWhich] = useState<AdvancedWhich>("tts");
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const rows = advancedRows(s);
  const row = rows.find((r) => r.which === which)!;
  const ids: Record<AdvancedWhich, string> = { tts: S3_TID.advTts, stt: S3_TID.advStt, language: S3_TID.advLanguage, speed: S3_TID.advSpeed };
  const pauseCell = (
    <ControlCell key="pause" label={ADVANCED_PAUSE}>
      <Slider size="touch" testID={S3_TID.advPause} label={ADVANCED_PAUSE} value={s.pauseMs} min={PAUSE_MIN_MS} max={PAUSE_MAX_MS} step={PAUSE_STEP_MS}
        format={ADVANCED_PAUSE_VALUE} mark={DEFAULTS.pauseMs} onCommit={(v) => setVoiceSettings({ pauseMs: v })} />
    </ControlCell>
  );
  return (
    <>
      <CellGroup footer={KEY_STORED_NOTE}>
        <Cell testID={S3_TID.keyRow} label={KEY_TITLE} sub={VS_KEY_SAVED} subTone="ok" onPress={onAdd}
          leading={<Tile colour="accentFill">{(c) => <KeyGlyph color={c} />}</Tile>} />
      </CellGroup>
      <CellGroup title={VOICES_TITLE}>
        <ChosenVoice />
        <Cell testID={S3_TID.chooseVoice} label={VS_CHOOSE_VOICE} tone="accent" onPress={() => { pushScreen("choose-voice", {}); }} />
      </CellGroup>
      <CellGroup title={VS_SENDING_TITLE} footer={VS_AUTOSEND_FOOTER}>
        <Cell label={VS_AUTOSEND} trailing={<Switch size="touch" on={s.autoSend} onChange={(v) => setVoiceSettings({ autoSend: v })} label={VS_AUTOSEND} testID={S3_TID.autosend} />} />
      </CellGroup>
      {notice ? <Text {...tid("vs-devices-notice")} size={TYPE.secondary} tone="warn" accessibilityLiveRegion="polite" style={styles.line}>{notice}</Text> : null}
      <CellGroup title={VS_ADVANCED_TITLE}>
        {rows.flatMap((r) => [
          <Cell key={r.which} testID={ids[r.which]} data={{ value: r.current }} label={r.label} value={r.value} onPress={() => { setWhich(r.which); setPicking(true); }} />,
          ...(r.which === "language" ? [pauseCell] : []),
        ])}
        <DeviceRows />
        <Cell label={VS_SKIP_CODE} trailing={<Switch size="touch" on={s.skipCode} onChange={(v) => setVoiceSettings({ skipCode: v })} label={VS_SKIP_CODE} testID={S3_TID.advSkipCode} />} />
      </CellGroup>
      <CellGroup>
        <Pressable {...tid(S3_TID.keyRemove)} accessibilityRole="button" accessibilityLabel={VS_REMOVE_KEY} onPress={() => setRemoving(true)}
          style={({ pressed }: { pressed: boolean }) => [styles.remove, pressed && { backgroundColor: t.hover2 }]}>
          <Text size={TYPE.control} tone="danger">{VS_REMOVE_KEY}</Text>
        </Pressable>
      </CellGroup>
      <PickerSheet open={picking} onClose={() => setPicking(false)} testID={S3_TID.picker} title={row.label} sub={row.value} value={row.current}
        options={row.options} onPick={(v) => setVoiceSettings(pickPatch(row.which, v))} />
      <ConfirmSheet open={removing} onClose={() => setRemoving(false)} testID={S3_TID.removeConfirm} title={KEY_REMOVE_TITLE} body={KEY_REMOVE_BODY}
        confirmLabel={KEY_REMOVE_DO} onConfirm={async () => { await voice.removeKey(); onRemoved(); }} />
    </>
  );
}

/** The chosen voice: a 44 pt play of its sample, its name and what the session knows of it, a ✓. With none chosen: the line for the first voice. */
function ChosenVoice() {
  const t = useTokens();
  const voiceId = useVoiceSettings((x) => x.voiceId), voiceName = useVoiceSettings((x) => x.voiceName);
  const info = useVoiceInfo(voiceId);
  const problem = useVoiceProblem();
  const [playing, setPlaying] = useState(false);
  const row = chosenVoiceRow({ voiceId, voiceName }, info?.about, playing);
  const failed = voiceId !== null && problem?.anchor === `preview:${voiceId}` ? PROBLEM_WORDS[problem.kind].sentence : undefined;
  const play = () => {
    if (voiceId === null) return;
    if (playing) { voice.stopPreview(); return; }
    setPlaying(true);
    void voice.playPreview(voiceId).finally(() => setPlaying(false));
  };
  const lead = row.chosen ? (
    <Pressable {...tid(S3_TID.voicePlay, { voice: voiceId, playing })} accessibilityRole="button" accessibilityLabel={playing ? CV_STOP_SAMPLE : VOICES_PLAY(row.label)} onPress={play}
      style={[styles.play, { backgroundColor: playing ? t.accentFill : t.accentSoft }]}>
      {playing ? <StopGlyph color={t.onAccent} /> : <PlayGlyph color={t.accent} />}
    </Pressable>
  ) : undefined;
  return (
    <Cell testID={S3_TID.chosenVoice} data={{ voice: voiceId ?? "" }} label={row.label} sub={failed ?? row.sub} subTone={failed ? "bad" : undefined} leading={lead}
      trailing={row.chosen ? <Text size={TYPE.control} tone="accent" weight="600" accessibilityElementsHidden>✓</Text> : undefined} />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0 },
  body: { paddingTop: 16 },
  card: { marginHorizontal: PHONE.margin, marginBottom: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: PHONE.margin, alignItems: "center", gap: 10 },
  promoTile: { width: 60, height: 60, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  centred: { textAlign: "center" },
  block: { alignSelf: "stretch", marginTop: 4 },
  link: { minHeight: PHONE.target, alignItems: "center", justifyContent: "center", paddingHorizontal: 8 },
  line: { marginHorizontal: PHONE.margin, marginBottom: 20 },
  play: { width: PHONE.target, height: PHONE.target, borderRadius: PHONE.target / 2, alignItems: "center", justifyContent: "center" },
  remove: { minHeight: PHONE.cell, alignItems: "center", justifyContent: "center", paddingHorizontal: PHONE.margin },
});
