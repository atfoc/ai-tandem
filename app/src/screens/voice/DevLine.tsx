// A line on the screen that says what the voice engine and the audio module are doing, for the device flow `voice-mic` (package P17, goal 6.6): a
// Maestro flow cannot ask the player whether it drained, so the app writes it. Only a development build made with EXPO_PUBLIC_AIWB_VOICE_BASE has
// it (devline.ts registers it under that condition; app/e2e/run.mjs gives the variable to flows whose header says `needs=voice`).
//
//   voice-dev: phase=<idle|starting|listening|…> reading=<the key of the message read aloud, or none> drained=<n> marks=<n>
//
// `drained` and `marks` count the player's events that came while a message was being read aloud (a drained one is also the module's own, when the
// microphone starts over what plays), so a count above zero with `reading=none` after a `reading=read:…` is a reading that was played to its end.
import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { voicePorts } from "../../voice/ports.ts";
import { useReading, useVoiceSession } from "../../voice/index.ts";

export function VoiceDevLine() {
  const phase = useVoiceSession((s) => s.phase);
  const reading = useReading().key;
  const live = useRef<string | null>(null);
  live.current = reading;
  const [counts, setCounts] = useState({ drained: 0, marks: 0 });
  useEffect(() => voicePorts().audio.player.on((e) => {
    if (live.current === null || e.kind === "level") return;
    setCounts((c) => (e.kind === "drained" ? { ...c, drained: c.drained + 1 } : { ...c, marks: c.marks + 1 }));
  }), []);
  // (Android's accessibility tree leaves out what stands under the status bar, which is where the line goes on iOS: there it goes just below it)
  const top = useSafeAreaInsets().top;
  const text = `voice-dev: phase=${phase} reading=${reading ?? "none"} drained=${counts.drained} marks=${counts.marks}`;
  return <Text testID="voice-dev" pointerEvents="none" style={[styles.line, Platform.OS === "android" && { top }]}>{text}</Text>;
}

const styles = StyleSheet.create({
  line: { position: "absolute", top: 1, left: 4, fontSize: 8, color: "#000", backgroundColor: "rgba(255,255,255,0.8)", zIndex: 99999, elevation: 99999 },
});
