// The pill's orb (VC-28, goal 3.6): the round microphone button and what the pill collapses to. Its state is drawn as it is on every size:
//   idle        a microphone: tap it to talk
//   listening   a ring that follows the voice (scaled by the microphone's level)
//   countdown   Auto-send is waiting: a ring that fills over the pause, then the turn is sent
//   waiting     Tap to send is waiting: a small ↑ badge on the orb sends the turn
//   thinking    the turn is sent and the agent works: a spinner (the board shows the edits as they happen)
//   speaking    the reply is spoken: the wave; a tap interrupts
//   paused      (voice devices VD-12) the headphones went away and the next sound would be out loud: a pause glyph, no ring; a tap continues
// `onPress` is what a tap on the orb does in that state (the pill decides); `onSend` is the badge's.
import { useEffect, useState, type RefObject } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, Rect } from "react-native-svg";

import { MicIcon, SendUpIcon, WaveIcon } from "../../../ui/icons.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { useControlRef } from "../../../ui/useControlRef";
import { webStyle } from "../../../ui/webstyle.ts";
import { PILL_ORB, PILL_SEND_BADGE } from "../../../voice/words.ts";
import { countdownAt, type OrbState } from "./logic.ts";

export const ORB = 44;
const BOX = 58; // (the ring has room to grow around the orb)
const RING = 52;
const STROKE = 3;

/** The countdown's clock: `now` moves while one runs, so that the ring fills smoothly. */
export function useCountdown(c: { startedAt: number; ms: number } | null): { frac: number; left: number } | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!c) return;
    setNow(Date.now());
    const h = setInterval(() => setNow(Date.now()), 50);
    return () => clearInterval(h);
  }, [c?.startedAt, c?.ms]);
  return c ? countdownAt(c, now) : null;
}

export function Orb({ state, level, countdown, onPress, onSend, anchor, muted }: {
  state: OrbState; level: number; countdown: { startedAt: number; ms: number } | null; muted?: boolean;
  onPress(): void; onSend(): void; anchor: RefObject<View | null>;
}) {
  const t = useTokens();
  const run = useCountdown(state === "countdown" ? countdown : null);
  const ringed = state === "listening" || state === "speaking";
  const grow = ringed ? 1 + Math.min(1, level * 5) * 0.3 : 1;
  const r = (RING - STROKE) / 2, c = 2 * Math.PI * r;
  const title = PILL_ORB[state];
  const tip = useControlRef(title);
  return (
    <View ref={anchor} collapsable={false} style={styles.box}>
      {ringed && (
        <View pointerEvents="none" {...tid("pill-ring", { level: Math.round(level * 100) })}
          style={[styles.ring, { borderColor: t.accent, opacity: 0.35 + Math.min(1, level * 5) * 0.4, transform: [{ scale: grow }] }]} />
      )}
      {state === "countdown" && (
        <View pointerEvents="none" style={styles.svg}><Svg width={RING} height={RING}>
          <Circle cx={RING / 2} cy={RING / 2} r={r} stroke={t.line2} strokeWidth={STROKE} fill="none" />
          <Circle {...tid("pill-countdown-ring", { frac: Math.round((run?.frac ?? 0) * 100) })} cx={RING / 2} cy={RING / 2} r={r} stroke={t.accent} strokeWidth={STROKE} fill="none"
            strokeLinecap="round" strokeDasharray={`${c} ${c}`} strokeDashoffset={c * (1 - (run?.frac ?? 0))} transform={`rotate(-90 ${RING / 2} ${RING / 2})`} />
        </Svg></View>
      )}
      <Pressable {...tid("pill-orb", { state, muted: muted || undefined })} ref={tip} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ busy: state === "thinking" }}
        onPress={onPress}
        style={({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
          styles.orb, { backgroundColor: t.accentFill, boxShadow: t.shadowSm } as object,
          (hovered || pressed) && { filter: "brightness(1.08)" } as object, webStyle({ cursor: "pointer" }),
        ]}>
        {state === "thinking" ? <ActivityIndicator size="small" color={t.onAccent} />
          : state === "speaking" ? <WaveIcon size={18} color={t.onAccent} />
          : state === "paused" ? <PauseGlyph color={t.onAccent} />
          : <MicIcon size={18} color={t.onAccent} />}
      </Pressable>
      {state === "waiting" && <Badge onPress={onSend} />}
    </View>
  );
}

/** Two bars: the orb's pause glyph (the app's icons have none). */
function PauseGlyph({ color }: { color: string }) {
  return (
    <Svg width={18} height={18} viewBox="0 0 16 16">
      <Rect x="3.5" y="2.5" width="3" height="11" rx="1" fill={color} />
      <Rect x="9.5" y="2.5" width="3" height="11" rx="1" fill={color} />
    </Svg>
  );
}

/** The ↑ badge on the orb while words wait for Tap to send. */
function Badge({ onPress }: { onPress(): void }) {
  const t = useTokens();
  const tip = useControlRef(PILL_SEND_BADGE);
  return (
    <Pressable {...tid("pill-badge")} ref={tip} accessibilityRole="button" accessibilityLabel={PILL_SEND_BADGE} onPress={onPress} hitSlop={8}
      style={[styles.badge, { backgroundColor: t.bg, borderColor: t.accent }, webStyle({ cursor: "pointer" })]}>
      <SendUpIcon size={12} color={t.accent} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  box: { width: BOX, height: BOX, alignItems: "center", justifyContent: "center", flexShrink: 0 },
  orb: { width: ORB, height: ORB, borderRadius: ORB / 2, alignItems: "center", justifyContent: "center" },
  ring: { position: "absolute", width: ORB, height: ORB, borderRadius: ORB / 2, borderWidth: 2 },
  svg: { position: "absolute" },
  badge: { position: "absolute", top: 1, right: 1, width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
});
