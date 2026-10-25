// The phone board's voice card (package V1, plans/ux-improvements/v1-design.md §4; goals 3.4, 3.7.2, 4.9): the one card that stands
// in the pill's place, the captions and the chat chip while this board's pill session is not idle. App chrome above the bottom band;
// at rest (idle) nothing is drawn but the docked orb (DockedOrb.tsx). Phases (`cardPhase`):
//   listening / waiting / countdown   "To:" and the chat's chip (→ the board's Chats sheet), a live wave, the words heard, the selection
//                                     chip (this session only), and Cancel and Send; the countdown says "Sending in N s" with a thin line
//   thinking                          the agent's glyph and "<Agent> · thinking…", the chat; Open chat
//   speaking                          "<Agent> · speaking", the chat, the sentence spoken; Open chat and Interrupt
//   paused                            the VD-12 sentence and Continue
// No Auto-send switch (Settings › Voice has it), no captions, no "+ New chat", no collapse and no hold-Space here: the wide Pill keeps them.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { BAND_HEIGHT } from "@aiwb/board-bridge/messages.ts";

import { useStore } from "../../../state/useStore.ts";
import { Button } from "../../../ui/Button.tsx";
import { AgentGlyph, Chevron, SendUpIcon, StopIcon, agentName } from "../../../ui/icons.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { noticeText } from "../../../voice/logic/devices.ts";
import {
  CARD_AGENT_NONE, CARD_IN, CARD_INTERRUPT, CARD_NEW_CHAT, CARD_OPEN_CHAT, CARD_SENDING_IN, CARD_SPEAKING, CARD_THINKING, CARD_TO, CARD_TO_LABEL,
  CARD_WITH_SELECTED, PILL_CANCEL, PILL_LISTENING, PILL_SELECTION_REMOVE, PILL_SEND, PILL_STARTING, VOICE_CONTINUE,
} from "../../../voice/words.ts";
import { useVoiceNotice, useVoiceSession, voice } from "../../../voice/index.ts";
import { openChatsSheet } from "../../board/chatssheet.ts";
import { agentPaint, tint } from "../../board/Overlays.tsx";
import { select } from "../../shell/nav.ts";
import { useTitle } from "./ChatChip.tsx";
import { useCountdown } from "./Orb.tsx";
import { useSelectedCount } from "./SelectionChip.tsx";
import { CARD_TID } from "./ids.ts";
import { barHeights, cardFoot, cardPhase, countdownSeconds, ownSession } from "./logic.ts";
import { leaveSelectionOut } from "./selection.ts";
import { targetNow } from "./control.ts";

const WAVE_BARS = 6;
const WAVE_HEIGHT = 28;

export function VoiceCard({ board }: { board: string }) {
  const { tokens: t } = useTheme();
  const raw = useVoiceSession((s) => (ownSession(s, board) ? s.phase : "idle"));
  const paused = useVoiceSession((s) => (ownSession(s, board) ? s.paused : null));
  const phase = cardPhase(raw, !!paused);
  const notice = useVoiceNotice({ kind: "board", board });
  if (!phase) return null;
  return (
    <View pointerEvents="box-none" style={styles.stage}>
      <View {...tid(CARD_TID.card, { phase })} style={[styles.card, { backgroundColor: t.bg, borderColor: t.line, boxShadow: t.shadowMd } as object]}>
        {phase === "listening" || phase === "waiting" || phase === "countdown" ? <Hearing board={board} phase={phase} starting={raw === "starting"} />
          : phase === "paused" ? <Paused device={paused?.device ?? ""} />
          : <Answering board={board} phase={phase} />}
        {notice ? <Text {...tid(CARD_TID.notice)} size={TYPE.secondary} style={{ color: t.warnText }}>{notice}</Text> : null}
      </View>
    </View>
  );
}

/** The chat the turn goes to: the session's once it has one, else the chat the pill would talk to now. */
function useTargetChat(board: string) {
  const id = useVoiceSession((s) => (ownSession(s, board) ? s.target : null)) ?? targetNow(board);
  const chat = useStore((s) => (id ? s.chats[id] : undefined));
  return { id, chat, name: useTitle(chat) };
}

function Hearing({ board, phase, starting }: { board: string; phase: "listening" | "waiting" | "countdown"; starting: boolean }) {
  const { tokens: t } = useTheme();
  const { chat, name } = useTargetChat(board);
  const committed = useVoiceSession((s) => (ownSession(s, board) ? s.committed : ""));
  const partial = useVoiceSession((s) => (ownSession(s, board) ? s.partial : ""));
  const level = useVoiceSession((s) => (ownSession(s, board) ? Math.round(s.level * 50) / 50 : 0));
  const countdown = useVoiceSession((s) => (ownSession(s, board) ? s.countdown : null));
  const run = useCountdown(phase === "countdown" ? countdown : null);
  const n = useSelectedCount(board);
  const heard = [committed, partial].filter(Boolean).join(" ");
  const scroll = useRef<ScrollView>(null);
  const label = chat ? name : CARD_NEW_CHAT;
  return (
    <>
      <View style={styles.head}>
        <Text size={TYPE.control} tone="muted">{CARD_TO}</Text>
        <Pressable {...tid(CARD_TID.to, { chat: chat?.id ?? "" })} accessibilityRole="button" accessibilityLabel={chat ? CARD_TO_LABEL(name) : CARD_NEW_CHAT}
          onPress={() => openChatsSheet(board)} style={[styles.chip, { borderColor: t.line2, backgroundColor: t.panel }]}>
          {chat ? <AgentGlyph agent={chat.agent} size={16} /> : null}
          <Text size={TYPE.control} weight="600" numberOfLines={1} style={styles.chipName}>{label}</Text>
          <View style={styles.down}><Chevron size={12} color={t.muted} /></View>
        </Pressable>
        {phase === "countdown" ? (
          <Text {...tid(CARD_TID.state, { left: run ? run.left.toFixed(1) : "" })} size={TYPE.secondary} weight="600" tone="accent">{CARD_SENDING_IN(countdownSeconds(run?.left ?? 0))}</Text>
        ) : <LiveWave level={level} />}
      </View>
      {phase === "countdown" ? (
        <View style={[styles.track, { backgroundColor: t.line2 }]}>
          <View {...tid("voice-card-countdown", { frac: Math.round((run?.frac ?? 0) * 100) })} style={[styles.fill, { backgroundColor: t.accent, width: `${Math.round((run?.frac ?? 0) * 100)}%` }]} />
        </View>
      ) : null}
      <ScrollView ref={scroll} style={styles.words} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
        {heard ? (
          <Text {...tid(CARD_TID.words)} size={TYPE.control}>{committed}{committed && partial ? " " : ""}<Text size={TYPE.control} tone="muted">{partial}</Text></Text>
        ) : (
          <Text {...tid(CARD_TID.words, { empty: true })} size={TYPE.control} tone="muted">{starting ? PILL_STARTING : PILL_LISTENING}</Text>
        )}
      </ScrollView>
      {n > 0 ? (
        <View {...tid(CARD_TID.selection, { count: n })} style={[styles.selection, { backgroundColor: t.accentSoft, borderColor: t.accent }]}>
          <Text size={TYPE.control} tone="accent">{CARD_WITH_SELECTED(n)}</Text>
          <Pressable {...tid(CARD_TID.selectionX)} accessibilityRole="button" accessibilityLabel={PILL_SELECTION_REMOVE} hitSlop={6} /* (32 + 2 × 6: a 44 pt target) */
            onPress={() => leaveSelectionOut(board)} style={styles.x}>
            <Text size={TYPE.control} tone="accent">×</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.foot}>
        {cardFoot(phase).map((k) => k === "cancel" ? (
          <Button key={k} {...tid(CARD_TID.cancel)} size="touch" label={PILL_CANCEL} onPress={phase === "countdown" ? voice.cancelCountdown : voice.end} />
        ) : (
          <Button key={k} {...tid(CARD_TID.send)} size="touch" tone="primary" label={PILL_SEND} icon={<SendUpIcon size={14} color={t.onAccent} />}
            disabled={!heard} onPress={voice.send} />
        ))}
      </View>
    </>
  );
}

/** The agent's glyph on its soft disc, its name and what it does, and the chat it does it in; the reply's sentence while it speaks. */
function Answering({ board, phase }: { board: string; phase: "thinking" | "speaking" }) {
  const { tokens: t } = useTheme();
  const { id, chat, name } = useTargetChat(board);
  const spoken = useVoiceSession((s) => (ownSession(s, board) ? s.spoken : ""));
  const agent = chat ? agentName(chat.agent) : CARD_AGENT_NONE;
  const paint = agentPaint(t, chat?.agent ?? "");
  const head = phase === "speaking" ? CARD_SPEAKING(agent) : CARD_THINKING(agent);
  return (
    <>
      <View style={styles.who}>
        <View style={[styles.glyph, { backgroundColor: tint(paint.main, 0.14) }]}>{chat ? <AgentGlyph agent={chat.agent} size={18} /> : null}</View>
        <View style={styles.whoText}>
          <Text {...tid(CARD_TID.state, { word: phase })} size={TYPE.control} weight="600" numberOfLines={1} style={{ color: paint.main }}>{head}</Text>
          {chat ? <Text {...tid(CARD_TID.where)} size={TYPE.secondary} tone="muted" numberOfLines={1}>{CARD_IN(name)}</Text> : null}
        </View>
      </View>
      {phase === "speaking" && spoken ? (
        <ScrollView style={styles.words}><Text {...tid(CARD_TID.words)} size={TYPE.control}>{spoken}</Text></ScrollView>
      ) : null}
      <View style={styles.foot}>
        {id ? <Button {...tid(CARD_TID.open)} size="touch" tone="ghost" on label={CARD_OPEN_CHAT} style={styles.half} onPress={() => select({ board, chat: id })} /> : null}
        {phase === "speaking" ? (
          <Button {...tid(CARD_TID.interrupt)} size="touch" label={CARD_INTERRUPT} icon={<StopIcon size={12} color={t.text} />} style={styles.half} onPress={voice.interrupt} />
        ) : null}
      </View>
    </>
  );
}

function Paused({ device }: { device: string }) {
  const { tokens: t } = useTheme();
  return (
    <>
      <Text {...tid(CARD_TID.words, { paused: true })} size={TYPE.control} style={{ color: t.warnText }}>{noticeText("paused", { device })}</Text>
      <View style={styles.foot}>
        <Button {...tid(CARD_TID.continue)} size="touch" tone="primary" label={VOICE_CONTINUE} onPress={voice.resume} />
      </View>
    </>
  );
}

/** A small live wave: the last moments of the level as bars, the newest on the right. */
function LiveWave({ level }: { level: number }) {
  const { tokens: t } = useTheme();
  const [seen, setSeen] = useState<number[]>([]);
  useEffect(() => { setSeen((l) => [...l, level].slice(-WAVE_BARS)); }, [level]);
  const bars = barHeights(seen, WAVE_BARS);
  return (
    <View {...tid(CARD_TID.wave, { peak: Math.round(Math.max(0, ...seen) * 100) })} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.wave}>
      {bars.map((h, i) => <View key={i} style={[styles.bar, { height: Math.max(4, Math.round(h * WAVE_HEIGHT)), backgroundColor: t.accent }]} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { position: "absolute", left: 0, right: 0, bottom: BAND_HEIGHT + 8, alignItems: "center", paddingHorizontal: 12, zIndex: 5 },
  card: { width: "100%", maxWidth: 480, borderRadius: 18, borderWidth: 1, padding: 14, gap: 10 },
  head: { flexDirection: "row", alignItems: "center", gap: 10 },
  chip: { flexShrink: 1, minWidth: 0, minHeight: PHONE.target, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1 },
  chipName: { flexShrink: 1, minWidth: 0 },
  down: { transform: [{ rotate: "90deg" }] },
  wave: { marginLeft: "auto", flexDirection: "row", alignItems: "center", gap: 3, height: WAVE_HEIGHT },
  bar: { width: 4, borderRadius: 2 },
  track: { height: 4, borderRadius: 2, overflow: "hidden" },
  fill: { height: 4, borderRadius: 2 },
  words: { maxHeight: 120, flexGrow: 0 },
  selection: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", maxWidth: "100%", minHeight: PHONE.chip, gap: 6, paddingLeft: 12, paddingRight: 4, borderRadius: PHONE.chip / 2, borderWidth: 1 },
  x: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  foot: { flexDirection: "row", justifyContent: "flex-end", gap: 10 },
  half: { flex: 1, justifyContent: "center", alignSelf: "stretch" },
  who: { flexDirection: "row", alignItems: "center", gap: 10 },
  glyph: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  whoText: { flex: 1, minWidth: 0 },
});
