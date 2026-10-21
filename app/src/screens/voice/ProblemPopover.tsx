// The popover of every voice problem (VC-30, goal 3.8): one sentence and one action, with "Not now". A control that can start voice
// (Dictate, Speech mode, Read aloud, the board's orb, a voice's play button) draws one of these next to itself:
//
//   const ref = useRef<View>(null);
//   <View ref={ref} collapsable={false}><Pressable … /></View>
//   <ProblemPopover anchor={`dictate:${chat}`} target={ref} />
//
// `anchor` is the id the control gave the engine when it started voice (`voice.startDictation({ anchor })`), and the popover shows only
// while the problem on show names that id; `target` is the element it hangs from (a sheet on the phone layout ignores it). It shows
// itself from the voice store: the control holds no state for it.
import type { RefObject } from "react";
import { StyleSheet, View } from "react-native";

import { openVoiceSettings, useVoiceProblem, voice } from "../../voice/index.ts";
import type { VoiceProblemKind } from "../../voice/index.ts";
import { voicePorts } from "../../voice/ports.ts";
import { PROBLEM_DISMISS, PROBLEM_WORDS } from "../../voice/words.ts";
import { Button } from "../../ui/Button.tsx";
import { Overlay } from "../../ui/Overlay.tsx";
import { Text } from "../../ui/Text.tsx";
import { tid } from "../../ui/tid.ts";

/** Where "Open ElevenLabs" goes: the account's page, where credits and the reason of a refusal are. */
export const ELEVENLABS_ACCOUNT_URL = "https://elevenlabs.io/app/subscription";

export type ProblemPopoverProps = {
  /** The id of the control, as given to the engine: the popover shows while the problem on show names it. */
  anchor: string;
  /** The element it hangs from. */
  target: RefObject<View | null>;
  align?: "left" | "right";
  /** Opens above the element (a control near the bottom: the composer's, the pill's). */
  up?: boolean;
};

/** What the action of a problem does, or null when there is none (the web build cannot open system settings; an offline problem with no retry). */
function actionOf(kind: VoiceProblemKind, retry: (() => void) | undefined): (() => void) | null {
  switch (kind) {
    case "no_key":
    case "key_rejected":
      return openVoiceSettings;
    case "no_credits":
    case "service":
      return () => voicePorts().openLink(ELEVENLABS_ACCOUNT_URL);
    case "mic_blocked":
      return voicePorts().audio.canOpenMicSettings ? () => { voicePorts().audio.openMicSettings().catch(() => { /* no settings to open: the popover goes */ }); } : null;
    case "offline":
      return retry ?? null;
  }
}

export function ProblemPopover({ anchor, target, align, up }: ProblemPopoverProps) {
  const problem = useVoiceProblem();
  if (!problem || problem.anchor !== anchor) return null;
  const words = PROBLEM_WORDS[problem.kind];
  const act = actionOf(problem.kind, problem.retry);
  return (
    <Overlay open kind="popover" label={words.sentence} anchor={target} align={align} up={up} onClose={voice.dismissProblem}>
      <View {...tid("voice-problem", { kind: problem.kind })} style={styles.body}>
        <Text size={13} {...tid("voice-problem-text")}>{words.sentence}</Text>
        <View style={styles.actions}>
          <Button size="sm" label={PROBLEM_DISMISS} testID="voice-problem-dismiss" onPress={voice.dismissProblem} />
          {act ? <Button size="sm" tone="primary" label={words.action} testID="voice-problem-act" autoFocus onPress={() => { voice.dismissProblem(); act(); }} /> : null}
        </View>
      </View>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  body: { width: 260, maxWidth: "100%", padding: 8, gap: 10 },
  actions: { flexDirection: "row", justifyContent: "flex-end", flexWrap: "wrap", gap: 8 },
});
