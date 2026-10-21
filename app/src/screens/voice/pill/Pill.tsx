// The board's voice pill (VC-28, goal 3.6): a floating control over the board's canvas, bottom centre, registered as the shell slot
// `BoardVoice`. It has three sizes:
//   compact    the chat chip, + New chat, the orb and the collapse control
//   listening  grows from the compact pill while the person listens or words wait: the live waveform, the words so far, the Auto-send
//              toggle and the countdown with Cancel, or Send
//   orb        collapsed to the orb alone; the orb still shows its ring (listening, countdown) or its ↑ badge (waiting)
// Everything the pill says about the turn is the session's (`useVoiceSession`); the pill holds only whether it is collapsed. Over the card hang the
// selection chip (what goes with the turn) and the captions (what was said, what is being spoken); hold Space (useHoldSpace) is the orb on the
// keyboard: a tap of Space is a tap on the orb, holding it is push-to-talk and the release sends the turn.
import { useRef } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "../../../ui/Button.tsx";
import { Chevron, CollapseIcon, SendUpIcon } from "../../../ui/icons.tsx";
import { IconButton } from "../../../ui/IconButton.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useLayout } from "../../../ui/useLayout.ts";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { noticeText } from "../../../voice/logic/devices.ts";
import {
  VOICE_CONTINUE, PILL_AUTOSEND, PILL_CANCEL, PILL_COLLAPSE, PILL_COUNTDOWN, PILL_EXPAND, PILL_LISTENING, PILL_NEW_CHAT, PILL_SEND, PILL_STARTING, PILL_TO, PILL_TO_NONE,
} from "../../../voice/words.ts";
import { setVoiceSettings, useVoiceNotice, useVoiceSession, useVoiceSettings, voice } from "../../../voice/index.ts";
import type { SessionState } from "../../../voice/index.ts";
import { useStore } from "../../../state/useStore.ts";
import { ProblemPopover } from "../ProblemPopover.tsx";
import { Captions } from "./Captions.tsx";
import { ChatChip, useTitle } from "./ChatChip.tsx";
import { Orb, useCountdown } from "./Orb.tsx";
import { SelectionChip } from "./SelectionChip.tsx";
import { Switch } from "./Switch.tsx";
import { Waveform } from "./Waveform.tsx";
import { usePillCollapsed, setPillCollapsed } from "./collapse.ts";
import { newPillChat, pillAnchor, startPill, targetNow } from "./control.ts";
import { captionTexts, orbStateFor, pillSize } from "./logic.ts";
import { useHoldSpace } from "./useHoldSpace.ts";

/** The session, when it is this board's pill session; otherwise it is as good as idle. */
const own = (s: SessionState, board: string): boolean => s.owner?.kind === "pill" && s.owner.board === board;

export function Pill({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const phase = useVoiceSession((s) => (own(s, board) ? s.phase : "idle"));
  const level = useVoiceSession((s) => (own(s, board) ? Math.round(s.level * 50) / 50 : 0));
  const muted = useVoiceSession((s) => own(s, board) && s.muted);
  const countdown = useVoiceSession((s) => (own(s, board) ? s.countdown : null));
  const committed = useVoiceSession((s) => (own(s, board) ? s.committed : ""));
  const partial = useVoiceSession((s) => (own(s, board) ? s.partial : ""));
  const spoken = useVoiceSession((s) => (own(s, board) ? s.spoken : ""));
  const paused = useVoiceSession((s) => (own(s, board) ? s.paused : null));
  const notice = useVoiceNotice({ kind: "board", board });
  const collapsed = usePillCollapsed();
  const orbRef = useRef<View>(null);
  const layout = useLayout(); // (on the phone the board has its own bar along the bottom: the pill rides above it)

  const state = orbStateFor(phase, !!paused);
  const size = pillSize(phase, collapsed, !!paused);
  const press = () => {
    if (state === "idle") void startPill(board);
    else if (state === "paused") voice.resume();
    else if (state === "speaking") voice.interrupt();
    else voice.end();
  };
  const held = useHoldSpace(board, { phase, words: !!(committed + partial).trim() }, {
    start: () => void startPill(board), interrupt: voice.interrupt, end: voice.end, send: voice.send, cancel: voice.cancelCountdown,
  });
  const captions = captionTexts({ phase, size, committed, partial, spoken });
  const orb = (
    <Orb state={state} level={level} countdown={countdown} muted={muted} onPress={press} onSend={voice.send} anchor={orbRef} />
  );
  const collapse = (
    <IconButton testID="pill-collapse" dataSet={{ collapsed }} size="sm" title={collapsed ? PILL_EXPAND : PILL_COLLAPSE} onPress={() => setPillCollapsed(!collapsed)}>
      {(c) => (collapsed ? <View style={styles.up}><Chevron size={10} color={c} /></View> : <CollapseIcon size={12} color={c} />)}
    </IconButton>
  );
  const card = { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowMd } as object;

  return (
    <View pointerEvents="box-none" style={[styles.row, { bottom: layout === "phone" ? 78 : 62 }]}>
      <Captions {...captions} notice={notice ?? ""} />
      <SelectionChip board={board} />
      <View {...tid("pill", { size, state, collapsed, held: held || undefined })} pointerEvents="box-none" style={size === "orb" ? styles.alone : [styles.card, size === "listening" ? styles.bar : styles.compact, card]}>
        {size === "orb" ? (
          <>
            {orb}
            <View style={[styles.corner, card]}>{collapse}</View>
          </>
        ) : size === "listening" ? (
          <ListeningBar board={board} phase={phase} orb={orb} collapse={collapse} level={level} countdown={countdown} words={{ committed, partial }} paused={paused} />
        ) : (
          <View style={styles.line}>
            <ChatChip board={board} />
            <View style={styles.news}><Button {...tid("pill-new")} size="sm" label={PILL_NEW_CHAT} onPress={() => void newPillChat(board)} /></View>
            {orb}
            {collapse}
          </View>
        )}
      </View>
      <ProblemPopover anchor={pillAnchor(board)} target={orbRef} align="right" up />
    </View>
  );
}

/** The listening bar: the target, the waveform and the words, and under them the Auto-send toggle with the countdown or Send. */
function ListeningBar({ board, phase, orb, collapse, level, countdown, words, paused }: {
  board: string; phase: SessionState["phase"]; orb: React.ReactNode; collapse: React.ReactNode; level: number;
  countdown: SessionState["countdown"]; words: { committed: string; partial: string }; paused: SessionState["paused"];
}) {
  const { tokens: t } = useTheme();
  const autoSend = useVoiceSettings((s) => s.autoSend);
  const targetId = targetNow(board);
  const target = useStore((s) => (targetId ? s.chats[targetId] : undefined));
  const name = useTitle(target);
  const heard = [words.committed, words.partial].filter(Boolean).join(" ");
  const run = useCountdown(phase === "countdown" ? countdown : null);
  return (
    <View style={styles.barBody}>
      <View style={styles.barHead}>
        <Text {...tid("pill-target")} size={11.5} tone="muted" numberOfLines={1} style={styles.grow}>{target ? PILL_TO(name) : PILL_TO_NONE}</Text>
        {collapse}
      </View>
      <View style={styles.barTalk}>
        <Waveform level={paused ? 0 : level} />
        {paused ? (
          <Text {...tid("pill-words", { paused: true })} size={13} numberOfLines={3} tone="warn" style={styles.grow}>{noticeText("paused", { device: paused.device })}</Text>
        ) : (
          <Text {...tid("pill-words")} size={13} numberOfLines={3} tone={heard ? "text" : "muted"} style={styles.grow}>
            {words.committed}{words.committed && words.partial ? " " : ""}<Text size={13} tone="muted">{words.partial}</Text>{heard ? "" : phase === "starting" ? PILL_STARTING : PILL_LISTENING}
          </Text>
        )}
        {orb}
      </View>
      <View style={styles.barFoot}>
        <Switch testID="pill-autosend" label={PILL_AUTOSEND} on={autoSend} onChange={(on) => setVoiceSettings({ autoSend: on })} />
        {paused ? (
          <Button {...tid("pill-continue")} size="sm" tone="primary" label={VOICE_CONTINUE} onPress={voice.resume} />
        ) : phase === "countdown" ? (
          <View {...tid("pill-countdown", { left: run ? run.left.toFixed(1) : "" })} style={styles.count}>
            <View style={[styles.track, { backgroundColor: t.line2 }]}><View {...tid("pill-countdown-bar")} style={[styles.fill, { backgroundColor: t.accent, width: `${Math.round((run?.frac ?? 0) * 100)}%` }]} /></View>
            <Text size={12} tone="muted" style={styles.secs}>{PILL_COUNTDOWN(run?.left ?? 0)}</Text>
            <Button {...tid("pill-cancel")} size="sm" label={PILL_CANCEL} onPress={voice.cancelCountdown} />
          </View>
        ) : (
          <Button {...tid("pill-send")} size="sm" tone="primary" label={PILL_SEND} icon={<SendUpIcon size={11} color="#ffffff" />} disabled={!heard} onPress={voice.send} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { position: "absolute", left: 0, right: 0, alignItems: "center", zIndex: 5 },
  alone: { alignItems: "center", justifyContent: "center" },
  card: { borderWidth: 1, maxWidth: "94%" },
  compact: { borderRadius: 34, paddingVertical: 4, paddingLeft: 12, paddingRight: 8 },
  bar: { borderRadius: 24, paddingVertical: 8, paddingHorizontal: 12, width: 380 },
  news: { justifyContent: "center", flexShrink: 0 },
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  corner: { position: "absolute", top: -4, left: -8, width: 22, height: 22, borderRadius: 11, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  up: { transform: [{ rotate: "-90deg" }] },
  barBody: { gap: 4 },
  barHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  barTalk: { flexDirection: "row", alignItems: "center", gap: 10 },
  barFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  count: { flexDirection: "row", alignItems: "center", gap: 8 },
  track: { width: 64, height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  secs: { minWidth: 34, textAlign: "right" },
});
