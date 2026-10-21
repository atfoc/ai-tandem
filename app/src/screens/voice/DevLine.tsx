// A line on the screen that says what the voice engine and the audio module are doing, for the device flow `voice-mic` (package P17, goal 6.6): a
// Maestro flow cannot ask the player whether it drained, so the app writes it. Only a development build made with EXPO_PUBLIC_AIWB_VOICE_BASE has
// it (devline.ts registers it under that condition; app/e2e/run.mjs gives the variable to flows whose header says `needs=voice`).
//
//   voice-dev: phase=<idle|starting|listening|…> reading=<the key of the message read aloud, or none> drained=<n> marks=<n>
//   (testID voice-dev-devices) mic=<none|default|builtIn|external> tested=<n>
//
// (The devices are a line of their own, just under the first and short enough to stay left of the Dynamic Island: Maestro matches a text as a whole,
// and `voice-mic` ends its patterns at `marks=<n>`.)
// `drained` and `marks` count the player's events that came while a message was being read aloud (a drained one is also the module's own, when the
// microphone starts over what plays), so a count above zero with `reading=none` after a `reading=read:…` is a reading that was played to its end.
// `mic` is what the last start of the microphone (Dictate, speech, Test microphone) opened (voice-devices, architecture §12.4), the device's kind and never its
// name: `none` before any start, `default` when the port opened the system's default without knowing what it is, `builtIn` or `external`.
// `tested` counts the queues that played out with nothing being read: Test speaker's chime (and nothing else on a quiet screen).
import { useEffect, useRef, useState } from "react";
import { Platform, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { voicePorts, type AudioDevice } from "../../voice/ports.ts";
import { useReading, useVoiceSession } from "../../voice/index.ts";

/** The kind of what the microphone opened: never a name. */
function micKind(device: AudioDevice | null): string {
  return device === null ? "default" : device.builtIn ? "builtIn" : "external";
}

export function VoiceDevLine() {
  const phase = useVoiceSession((s) => s.phase);
  const reading = useReading().key;
  const live = useRef<string | null>(null);
  live.current = reading;
  const [counts, setCounts] = useState({ drained: 0, marks: 0 });
  const [tested, setTested] = useState(0);
  useEffect(() => voicePorts().audio.player.on((e) => {
    if (e.kind === "level") return;
    if (live.current === null) { // nothing is being read: a queue that played out is Test speaker's chime
      if (e.kind === "drained") setTested((n) => n + 1);
      return;
    }
    setCounts((c) => (e.kind === "drained" ? { ...c, drained: c.drained + 1 } : { ...c, marks: c.marks + 1 }));
  }), []);
  const [mic, setMic] = useState("none");
  // Every start of the microphone goes through the port: what it opened is what the line shows.
  useEffect(() => {
    const audio = voicePorts().audio;
    const start = audio.startMic;
    audio.startMic = async (o) => {
      const handle = await start.call(audio, o);
      setMic(micKind(handle.opened.device));
      return handle;
    };
    return () => { audio.startMic = start; };
  }, []);
  // (Android's accessibility tree leaves out what stands under the status bar, which is where the line goes on iOS: there it goes just below it)
  const top = useSafeAreaInsets().top;
  const text = `voice-dev: phase=${phase} reading=${reading ?? "none"} drained=${counts.drained} marks=${counts.marks}`;
  const devices = `mic=${mic} tested=${tested}`;
  const at = Platform.OS === "android" ? top : 1;
  return (
    <>
      <Text testID="voice-dev" pointerEvents="none" style={[styles.line, { top: at }]}>{text}</Text>
      <Text testID="voice-dev-devices" pointerEvents="none" style={[styles.line, { top: at + 11 }]}>{devices}</Text>
    </>
  );
}

const styles = StyleSheet.create({
  line: { position: "absolute", left: 4, fontSize: 8, color: "#000", backgroundColor: "rgba(255,255,255,0.8)", zIndex: 99999, elevation: 99999 },
});
