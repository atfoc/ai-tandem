// The look of a switch (the sidebar foot's "Show archived", Settings > Voice's "Skip code blocks"): a 26 × 15 track and a knob that slides
// to the right when it is on. It draws the track only; the control that holds it (a Pressable with role "switch") is the caller's.
import { StyleSheet, View } from "react-native";

import { useTokens } from "./theme.tsx";
import { tid } from "./tid.ts";

export function SwitchLook({ on, testID, knobTestID }: { on: boolean; testID: string; knobTestID: string }) {
  const t = useTokens();
  return (
    <View {...tid(testID, { on })} style={[styles.track, { backgroundColor: on ? t.accentFill : t.line2 }]}>
      <View {...tid(knobTestID)} style={[styles.knob, { backgroundColor: on ? t.knobOn : t.knob }, on && { transform: [{ translateX: 11 }] }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: 26, height: 15, borderRadius: 8, flexShrink: 0 },
  knob: { position: "absolute", top: 2, left: 2, width: 11, height: 11, borderRadius: 6 },
});
