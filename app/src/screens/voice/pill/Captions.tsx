// The board's captions (VC-28, goal 3.6): what the person said and the sentence the model is speaking, floating above the pill. They fade 4 s after the
// last change. What is said stays while the turn is on its way (the Thinking orb), until the reply starts; the sentence stays while it is spoken and for
// 4 s after the reply ends. The listening bar shows the words of the turn itself, so the caption leaves them to it (`captionTexts`).
// A third caption, `caption-notice`, carries the board's voice notice (a device that was missing or went away, VD-14): the same look, in the warn tone.
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Platform, StyleSheet, View } from "react-native";

import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { PILL_SAID, PILL_SPOKEN } from "../../../voice/words.ts";
import { CAPTION_FADE_MS, CAPTION_MS } from "./logic.ts";

/** The text a caption shows now. A text is kept (`linger`) or dropped when it goes empty; unless `hold`, it starts to fade CAPTION_MS after the last change. */
function useCaption(text: string, o: { linger: boolean; hold: boolean }): { shown: string; fading: boolean } {
  const [shown, setShown] = useState(text);
  const [fading, setFading] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clear = () => { for (const h of timers.current.splice(0)) clearTimeout(h); };
  useEffect(() => {
    clear();
    setFading(false);
    const now = text || (o.linger ? shown : "");
    setShown(now);
    if (!now || o.hold) return;
    timers.current.push(setTimeout(() => {
      setFading(true);
      timers.current.push(setTimeout(() => setShown(""), CAPTION_FADE_MS));
    }, CAPTION_MS));
  }, [text, o.hold, o.linger]);
  useEffect(() => clear, []);
  return { shown, fading };
}

function Caption({ id, label, text, fading, spoken, notice }: { id: string; label: string; text: string; fading: boolean; spoken?: boolean; notice?: boolean }) {
  const t = useTokens();
  const level = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const run = Animated.timing(level, { toValue: fading ? 0 : 1, duration: fading ? CAPTION_FADE_MS : 120, easing: Easing.out(Easing.quad), useNativeDriver: Platform.OS !== "web" });
    run.start();
    return () => run.stop();
  }, [fading, level]);
  return (
    <Animated.View {...tid(id, { fading })} pointerEvents="none" accessibilityLabel={label ? `${label}: ${text}` : text}
      style={[styles.caption, { opacity: level, backgroundColor: spoken ? t.accentSoft : t.bg, borderColor: spoken ? t.accent : t.line }]}>
      <Text size={13.5} tone={notice ? "warn" : spoken ? "text" : "muted"} numberOfLines={3} style={styles.words}>{spoken || notice ? text : `“${text}”`}</Text>
    </Animated.View>
  );
}

export function Captions({ said, spoken, holdSaid, holdSpoken, notice = "" }: { said: string; spoken: string; holdSaid: boolean; holdSpoken: boolean; notice?: string }) {
  const a = useCaption(said, { linger: false, hold: holdSaid });
  const b = useCaption(spoken, { linger: true, hold: holdSpoken });
  const n = useCaption(notice, { linger: false, hold: false });
  if (!a.shown && !b.shown && !n.shown) return null;
  return (
    <View pointerEvents="none" style={styles.stack} accessibilityLiveRegion="polite">
      {a.shown ? <Caption id="caption-said" label={PILL_SAID} text={a.shown} fading={a.fading} /> : null}
      {b.shown ? <Caption id="caption-spoken" label={PILL_SPOKEN} text={b.shown} fading={b.fading} spoken /> : null}
      {n.shown ? <Caption id="caption-notice" label="" text={n.shown} fading={n.fading} notice /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { alignItems: "center", gap: 6, maxWidth: "94%", marginBottom: 8 },
  caption: { borderWidth: 1, borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12, maxWidth: 520 },
  words: { textAlign: "center" },
});
