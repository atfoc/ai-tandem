// The speech bar on the phone (ux-improvements goal 3.7.3, mockups co-06d and co-06s), drawn by SpeechBar.tsx where `usePhone()`: an accent-bordered
// card in the box's shape. Top row: a dot and the state word (Listening, Sending in N s, Thinking…, Speaking, Muted) and the one action of the moment
// at the right (Send, Cancel in the countdown with a thin progress line under the row, Interrupt while speaking, Continue while paused; none while it
// thinks). Then a 48 pt waveform, the heard words at 17 pt with the live guess muted (the sentence spoken while the model speaks), and two halves:
// Mute and End. There is no Auto-send switch on the phone (it stays in Settings). End puts the words not yet sent into the box as the draft, then ends.
// What the bar says and offers is speechbar.ts's. The wide layouts keep SpeechBar.tsx's own bar.
import { useContext, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { SendUpIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme, useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { DictationBoxContext } from "../composer/dictation.ts";
import { useVoiceSession, voice } from "../../voice/index.ts";
import type { Phase } from "../../voice/index.ts";
import { noticeText } from "../../voice/logic/devices.ts";
import { SPEECH_BAR, SPEECH_END, SPEECH_LISTENING, SPEECH_MUTE, SPEECH_MUTED, SPEECH_THINKING, SPEECH_UNMUTE, SPEECH_WAVE_TIP } from "../../voice/words.ts";
import { dictated } from "./ComposerVoice.tsx";
import { useCountdown } from "./pill/Orb.tsx";
import { barHeights } from "./pill/logic.ts";
import { ACTION_LABEL, barAction, stateWord, unsentWords, waveFlat, type BarAction } from "./speechbar.ts";

const BARS = 58;
const WAVE = 48; // the waveform's height
const HALF = 46; // Mute and End

export function PhoneSpeechBar({ chatId, branch }: { chatId: string; branch: string }) {
  const { tokens: t } = useTheme();
  const box = useContext(DictationBoxContext);
  const own = (s: { owner: { kind: string; chat?: string; branch?: string } | null }) => s.owner?.kind === "speech" && s.owner.chat === chatId && s.owner.branch === branch;
  const phase = useVoiceSession((s) => (own(s) ? s.phase : "idle"));
  const paused = useVoiceSession((s) => (own(s) ? s.paused : null));
  const level = useVoiceSession((s) => (own(s) && !s.paused ? Math.round(s.level * 50) / 50 : 0));
  const muted = useVoiceSession((s) => own(s) && s.muted);
  const countdown = useVoiceSession((s) => (own(s) ? s.countdown : null));
  const committed = useVoiceSession((s) => (own(s) ? s.committed : ""));
  const partial = useVoiceSession((s) => (own(s) ? s.partial : ""));
  const spoken = useVoiceSession((s) => (own(s) ? s.spoken : ""));
  const run = useCountdown(phase === "countdown" ? countdown : null);
  const heard = [committed, partial].filter(Boolean).join(" ");
  const speaking = phase === "speaking";
  const input = { phase, muted, paused: !!paused, left: run ? run.left : null };
  const word = stateWord(input), action = barAction(input), flat = waveFlat(input);
  const status = muted ? SPEECH_MUTED : phase === "sending" || phase === "thinking" ? SPEECH_THINKING : SPEECH_LISTENING;
  const dot = muted ? t.faint : paused ? t.warn : t.accent;
  const onAction: Record<BarAction, () => void> = { send: voice.send, cancel: voice.cancelCountdown, interrupt: voice.interrupt, continue: voice.resume };
  // End: the words not yet sent are the draft (after what the box holds); then the session ends.
  const end = () => {
    const words = unsentWords(phase, committed, partial);
    if (words && box) box.put(dictated(box.text(), words));
    voice.end();
  };
  return (
    <View {...tid("speech-bar", { phase, muted, paused: !!paused || undefined })} accessibilityLabel={SPEECH_BAR}
      style={[styles.bar, { backgroundColor: t.bg, borderColor: t.accent, boxShadow: `0 0 0 3px ${t.accentSoft}` } as object]}>
      <View style={styles.top}>
        <View style={[styles.dot, { backgroundColor: dot }]} />
        <Text {...tid("speech-state", { word })} size={TYPE.control} weight="600" tone={muted ? "muted" : "accent"} numberOfLines={1} style={styles.word}>{word}</Text>
        {action ? (
          action === "send" ? (
            <Button {...tid("speech-send")} size="touch" tone="primary" label={ACTION_LABEL.send} icon={<SendUpIcon size={12} color="#ffffff" />} disabled={!heard} onPress={onAction.send} />
          ) : (
            <Button {...tid(action === "cancel" ? "speech-cancel" : action === "interrupt" ? "speech-interrupt" : "speech-continue")} size="touch" tone={action === "continue" ? "primary" : "default"}
              label={ACTION_LABEL[action]} onPress={onAction[action]} />
          )
        ) : null}
      </View>
      {phase === "countdown" ? (
        <View {...tid("speech-countdown", { left: run ? run.left.toFixed(1) : "" })} style={[styles.track, { backgroundColor: t.line2 }]}>
          <View {...tid("speech-countdown-bar")} style={[styles.fill, { backgroundColor: t.accent, width: `${Math.round((run?.frac ?? 0) * 100)}%` }]} />
        </View>
      ) : null}
      <Wave level={level} phase={phase} flat={flat} />
      <View style={styles.said}>
        {paused ? <Text {...tid("speech-paused")} size={TYPE.secondary} tone="warn" style={{ color: t.warnText }}>{noticeText("paused", { device: paused.device })}</Text> : null}
        {speaking ? (
          <Text {...tid("speech-spoken")} size={TYPE.control} numberOfLines={4}>{spoken}</Text>
        ) : heard ? (
          <Text {...tid("speech-words")} size={TYPE.control} numberOfLines={4}>{committed}{committed && partial ? " " : ""}<Text size={TYPE.control} tone="muted">{partial}</Text></Text>
        ) : paused ? null : (
          <Text {...tid("speech-status")} size={TYPE.secondary} tone="muted">{status}</Text>
        )}
      </View>
      <View style={styles.foot}>
        <Button {...tid("speech-mute", { on: muted })} size="touch" on={muted} label={muted ? SPEECH_UNMUTE : SPEECH_MUTE} style={styles.half} onPress={() => voice.mute(!muted)} />
        <Button {...tid("speech-end")} size="touch" label={SPEECH_END} accessibilityLabel={SPEECH_END} style={[styles.half, { backgroundColor: t.dangerSoft, borderColor: t.dangerSoft }]} onPress={end}>
          <Text size={TYPE.control} tone="danger" weight="600">{`✕ ${SPEECH_END}`}</Text>
        </Button>
      </View>
    </View>
  );
}

/** The waveform: the last moments of the level as bars, the newest on the right; flat dots while it thinks or is muted. A tap on it while the model speaks interrupts. */
function Wave({ level, phase, flat }: { level: number; phase: Phase; flat: boolean }) {
  const tokens = useTokens();
  const [seen, setSeen] = useState<number[]>([]);
  useEffect(() => { setSeen((l) => [...l, level].slice(-BARS)); }, [level]);
  const speaking = phase === "speaking";
  const tip = useControlRef(speaking ? SPEECH_WAVE_TIP : "");
  const bars = barHeights(seen, BARS);
  const peak = Math.round(Math.max(0, ...seen) * 100);
  return (
    <Pressable ref={tip} {...tid("speech-wave", { phase, peak, flat })} role={speaking ? "button" : undefined} accessibilityLabel={speaking ? SPEECH_WAVE_TIP : undefined}
      disabled={!speaking} onPress={voice.interrupt} style={[styles.wave, webStyle({ cursor: speaking ? "pointer" : "default" })]}>
      {bars.map((h, i) => (
        <View key={i} style={[styles.stroke, flat ? styles.dotted : { height: Math.max(3, Math.round(h * WAVE)) }, { backgroundColor: tokens.accent, opacity: flat ? 0.4 : 0.35 + 0.65 * (i / BARS) }]} />
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderWidth: 1, borderRadius: 18, padding: 12, gap: 10 },
  top: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: PHONE.target },
  dot: { width: 8, height: 8, borderRadius: 4 },
  word: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  track: { height: 3, borderRadius: 2, overflow: "hidden", marginTop: -6 },
  fill: { height: 3, borderRadius: 2 },
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 2, height: WAVE },
  stroke: { width: 3, borderRadius: 2 },
  dotted: { height: 3 },
  said: { minHeight: 28, justifyContent: "center", gap: 4 },
  foot: { flexDirection: "row", gap: 8 },
  half: { flexGrow: 1, flexBasis: 0, minHeight: HALF, alignSelf: "stretch", justifyContent: "center", alignItems: "center" },
});
