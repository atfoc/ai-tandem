// The speech bar (VC-17, goal 3.1): what the composer draws in place of its box and toolbar while speech mode is on (the composer part
// `SpeechBar`; Composer.tsx hides the box and the toolbar, it does not unmount them, and gives them back when speech mode ends). Everything it
// shows is the session's (`useVoiceSession`); it holds nothing of its own but the history of the waveform:
//   the wave      the microphone's level while the person talks, the player's while the model speaks; a tap on it while the model speaks interrupts it
//   the words     what the person has said so far (the finished words, then the live guess in the muted colour); the sentence being spoken when the
//                 model speaks; a line saying what happens when there is neither
//   Auto-send     the one setting that Settings and the board's pill read and write too (goal 4.6)
//   the countdown the bar with the seconds left and Cancel, which keeps the words; otherwise Send
//   Mute, End     Mute sends no audio and keeps the session; End stops listening and speaking and closes the socket
// The bar says nothing of problems: a problem ends the session, and the composer's toolbar (which hangs the popover) is back by then.
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { SendUpIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme, useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { setVoiceSettings, useVoiceSession, useVoiceSettings, voice } from "../../voice/index.ts";
import type { Phase } from "../../voice/index.ts";
import {
  PILL_AUTOSEND, PILL_CANCEL, PILL_COUNTDOWN, PILL_SEND, SPEECH_BAR, SPEECH_END, SPEECH_END_TIP, SPEECH_LISTENING, SPEECH_MUTE, SPEECH_MUTE_TIP, SPEECH_MUTED,
  SPEECH_SENDING, SPEECH_THINKING, SPEECH_UNMUTE, SPEECH_UNMUTE_TIP, SPEECH_WAVE_TIP,
} from "../../voice/words.ts";
import { useCountdown } from "./pill/Orb.tsx";
import { barHeights } from "./pill/logic.ts";
import { Switch } from "./pill/Switch.tsx";

const BARS = 28;
const HEIGHT = 30;

export function SpeechBar({ chatId, branch }: { chatId: string; branch: string }) {
  const { tokens: t } = useTheme();
  const own = (s: { owner: { kind: string; chat?: string; branch?: string } | null }) => s.owner?.kind === "speech" && s.owner.chat === chatId && s.owner.branch === branch;
  const phase = useVoiceSession((s) => (own(s) ? s.phase : "idle"));
  const level = useVoiceSession((s) => (own(s) ? Math.round(s.level * 50) / 50 : 0));
  const muted = useVoiceSession((s) => own(s) && s.muted);
  const countdown = useVoiceSession((s) => (own(s) ? s.countdown : null));
  const committed = useVoiceSession((s) => (own(s) ? s.committed : ""));
  const partial = useVoiceSession((s) => (own(s) ? s.partial : ""));
  const spoken = useVoiceSession((s) => (own(s) ? s.spoken : ""));
  const autoSend = useVoiceSettings((s) => s.autoSend);
  const run = useCountdown(phase === "countdown" ? countdown : null);
  const heard = [committed, partial].filter(Boolean).join(" ");
  const speaking = phase === "speaking";
  const turnOpen = phase === "listening" || phase === "waiting" || phase === "countdown"; // the turn is still the person's: Send and the countdown mean something
  const status = muted ? SPEECH_MUTED : phase === "sending" ? SPEECH_SENDING : phase === "thinking" ? SPEECH_THINKING : SPEECH_LISTENING;
  return (
    <View {...tid("speech-bar", { phase, muted })} accessibilityLabel={SPEECH_BAR} style={[styles.bar, { backgroundColor: t.bg, borderColor: t.accent, boxShadow: `0 0 0 3px ${t.accentSoft}` } as object]}>
      <View style={styles.talk}>
        <Wave level={level} phase={phase} />
        <View style={styles.said}>
          {speaking ? (
            <Text {...tid("speech-spoken")} size={13} numberOfLines={4}>{spoken}</Text>
          ) : heard ? (
            <Text {...tid("speech-words")} size={13} numberOfLines={4}>{committed}{committed && partial ? " " : ""}<Text size={13} tone="muted">{partial}</Text></Text>
          ) : (
            <Text {...tid("speech-status")} size={13} tone="muted">{status}</Text>
          )}
        </View>
      </View>
      <View style={styles.foot}>
        <Switch testID="speech-autosend" label={PILL_AUTOSEND} on={autoSend} onChange={(on) => setVoiceSettings({ autoSend: on })} />
        {phase === "countdown" ? (
          <View {...tid("speech-countdown", { left: run ? run.left.toFixed(1) : "" })} style={styles.count}>
            <View style={[styles.track, { backgroundColor: t.line2 }]}><View {...tid("speech-countdown-bar")} style={[styles.fill, { backgroundColor: t.accent, width: `${Math.round((run?.frac ?? 0) * 100)}%` }]} /></View>
            <Text size={12} tone="muted" style={styles.secs}>{PILL_COUNTDOWN(run?.left ?? 0)}</Text>
            <Button {...tid("speech-cancel")} size="sm" label={PILL_CANCEL} onPress={voice.cancelCountdown} />
          </View>
        ) : turnOpen ? (
          <Button {...tid("speech-send")} size="sm" tone="primary" label={PILL_SEND} icon={<SendUpIcon size={11} color="#ffffff" />} disabled={!heard} onPress={voice.send} />
        ) : null}
        <View style={styles.grow} />
        <Button {...tid("speech-mute", { on: muted })} size="sm" on={muted} label={muted ? SPEECH_UNMUTE : SPEECH_MUTE} title={muted ? SPEECH_UNMUTE_TIP : SPEECH_MUTE_TIP} onPress={() => voice.mute(!muted)} />
        <Button {...tid("speech-end")} size="sm" label={SPEECH_END} title={SPEECH_END_TIP} onPress={voice.end} />
      </View>
    </View>
  );
}

/** The live waveform: the last moments of the level as bars, the newest on the right. A tap on it while the model speaks interrupts it. */
function Wave({ level, phase }: { level: number; phase: Phase }) {
  const tokens = useTokens();
  const [seen, setSeen] = useState<number[]>([]);
  useEffect(() => { setSeen((l) => [...l, level].slice(-BARS)); }, [level]);
  const speaking = phase === "speaking";
  const tip = useControlRef(speaking ? SPEECH_WAVE_TIP : "");
  const bars = barHeights(seen, BARS);
  const peak = Math.round(Math.max(0, ...seen) * 100);
  return (
    <Pressable ref={tip} {...tid("speech-wave", { phase, peak })} role={speaking ? "button" : undefined} accessibilityLabel={speaking ? SPEECH_WAVE_TIP : undefined}
      disabled={!speaking} onPress={voice.interrupt} hitSlop={4} style={[styles.wave, webStyle({ cursor: speaking ? "pointer" : "default" })]}>
      {bars.map((h, i) => <View key={i} style={[styles.stroke, { height: Math.max(3, Math.round(h * HEIGHT)), backgroundColor: tokens.accent, opacity: 0.35 + 0.65 * (i / BARS) }]} />)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { borderWidth: 1, borderRadius: 10, paddingVertical: 8, paddingHorizontal: 10, gap: 8 },
  talk: { flexDirection: "row", alignItems: "center", gap: 10 },
  said: { flex: 1, minWidth: 0, justifyContent: "center", minHeight: 32 },
  wave: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 2, height: HEIGHT, width: BARS * 5 - 2, flexShrink: 0 },
  stroke: { width: 3, borderRadius: 2 },
  foot: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8 },
  grow: { flexGrow: 1, flexBasis: 0 },
  count: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { width: 64, height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  secs: { minWidth: 34, textAlign: "right" },
});
