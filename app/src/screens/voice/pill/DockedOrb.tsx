// The phone board's docked orb (package V1, plans/ux-improvements/v1-design.md §4; goals 3.4, 4.9): a 52 pt accent disc with Talk's wave
// icon in B1's 64 pt `board-orb-slot` (the band's right end, and the landscape corner). It is the pill's orb as the phone draws it: the same
// states (a ring that follows the level while listening or speaking, the countdown ring, a spinner while the agent thinks, a pause glyph),
// the same tap per state (`orbTap`), and a badge with the number of selected shapes while this board's session carries them. Everything the
// session says besides the orb is the voice card's (VoiceCard.tsx). The voice problem is drawn by ProblemPopover, hung from the disc.
import { useRef } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";

import { WaveIcon } from "../../../ui/icons.tsx";
import { TYPE } from "../../../ui/metrics.ts";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { BOARD_ORB, BOARD_ORB_BADGE } from "../../../voice/words.ts";
import { useVoiceSession, voice } from "../../../voice/index.ts";
import { useStore } from "../../../state/useStore.ts";
import { ProblemPopover } from "../ProblemPopover.tsx";
import { useCountdown } from "./Orb.tsx";
import { useSelectedCount } from "./SelectionChip.tsx";
import { CARD_TID } from "./ids.ts";
import { badgeText, orbStateFor, orbTap, ownSession } from "./logic.ts";
import { pillAnchor, startPill } from "./control.ts";

/** The disc, and the box it sits in (the slot's: the ring has room to grow around the disc). */
export const DISC = 52;
const BOX = 64;
const RING = 60;
const STROKE = 3;

export function DockedOrb({ board }: { board: string }) {
  const t = useTokens();
  const phase = useVoiceSession((s) => (ownSession(s, board) ? s.phase : "idle"));
  const level = useVoiceSession((s) => (ownSession(s, board) ? Math.round(s.level * 50) / 50 : 0));
  const countdown = useVoiceSession((s) => (ownSession(s, board) ? s.countdown : null));
  const paused = useVoiceSession((s) => ownSession(s, board) && !!s.paused);
  const state = orbStateFor(phase, paused);
  const n = useSelectedCount(board);
  const badge = state === "idle" ? 0 : n; // (the selection goes with a spoken turn only in this session)
  const anchor = useRef<View>(null);
  const run = useCountdown(state === "countdown" ? countdown : null);
  const ringed = state === "listening" || state === "speaking";
  const grow = ringed ? 1 + Math.min(1, level * 5) * 0.12 : 1;
  const r = (RING - STROKE) / 2, c = 2 * Math.PI * r;
  // (an archived board takes no turn: no orb, as the wide layouts draw no pill there)
  const archived = useStore((st) => !!st.boards[board]?.archived);
  if (archived) return null;
  const press = () => {
    switch (orbTap(state)) {
      case "start": void startPill(board); break;
      case "resume": voice.resume(); break;
      case "interrupt": voice.interrupt(); break;
      case "end": voice.end(); break;
    }
  };
  const label = BOARD_ORB[state];
  return (
    <View ref={anchor} collapsable={false} pointerEvents="box-none" style={styles.box}>
      {ringed && (
        <View pointerEvents="none" {...tid("voice-orb-ring", { level: Math.round(level * 100) })}
          style={[styles.ring, { borderColor: t.accent, opacity: 0.35 + Math.min(1, level * 5) * 0.4, transform: [{ scale: grow }] }]} />
      )}
      {state === "countdown" && (
        <View pointerEvents="none" style={styles.svg}><Svg width={RING} height={RING}>
          <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={t.line2} strokeWidth={STROKE} fill="none" />
          <Circle {...tid("voice-orb-countdown", { frac: Math.round((run?.frac ?? 0) * 100) })} cx={RING / 2} cy={RING / 2} r={r} stroke={t.accent} strokeWidth={STROKE} fill="none"
            strokeLinecap="round" strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - (run?.frac ?? 0))} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} />
        </Svg></View>
      )}
      <Pressable {...tid(CARD_TID.orb, { state, badge: badge || undefined })} accessibilityRole="button" accessibilityLabel={label}
        accessibilityHint={badge ? BOARD_ORB_BADGE(badge) : undefined} accessibilityState={{ busy: state === "thinking" }} onPress={press}
        style={[styles.disc, { backgroundColor: t.accentFill, boxShadow: t.shadowSm } as object]}>
        {state === "thinking" ? <ActivityIndicator size="small" color={t.onAccent} />
          : state === "paused" ? <PauseGlyph color={t.onAccent} />
          : <WaveIcon size={26} color={t.onAccent} />}
      </Pressable>
      {badge > 0 && (
        <View pointerEvents="none" {...tid("voice-orb-badge", { count: badge })} style={[styles.badge, { backgroundColor: t.bg, borderColor: t.accent }]}>
          <Text size={TYPE.secondary} weight="600" tone="accent">{badgeText(badge)}</Text>
        </View>
      )}
      <ProblemPopover anchor={pillAnchor(board)} target={anchor} align="right" up />
    </View>
  );
}

/** Two bars: the pause glyph (the app's icons have none). */
function PauseGlyph({ color }: { color: string }) {
  return (
    <Svg width={26} height={26} viewBox="0 0 16 16">
      <Rect x="3.5" y="2.5" width="3" height="11" rx="1" fill={color} />
      <Rect x="9.5" y="2.5" width="3" height="11" rx="1" fill={color} />
    </Svg>
  );
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX, alignItems: "center", justifyContent: "center" },
  disc: { width: DISC, height: DISC, borderRadius: DISC / 2, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: DISC, height: DISC, borderRadius: DISC / 2, borderWidth: 2 },
  svg: { position: "absolute" },
  badge: { position: "absolute", top: 0, right: 0, minWidth: 24, height: 24, paddingHorizontal: 5, borderRadius: 12, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});
