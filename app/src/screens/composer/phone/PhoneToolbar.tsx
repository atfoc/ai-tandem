// The phone's toolbar under the box (ux-improvements goal 3.6, mockup "01 The box and its toolbar", co-01a and co-01s): "+" (Add to message), the
// context ring with no text, Dictate (the mic) and one primary button that changes with the moment: Talk while the box is empty, Send when it
// holds something, Stop while the agent works (with Send back beside it once something is typed). Every control has a 44-point target and no
// hover title. The wide layouts keep Toolbar.tsx.
import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { IconButton } from "../../../ui/IconButton.tsx";
import { MicIcon, WaveIcon } from "../../../ui/icons.tsx";
import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { ContextMeter } from "../../usage/ContextMeter.tsx";
import { useVoiceSession } from "../../../voice/index.ts";
import { useComposerParts } from "../parts.tsx";
import { PrimaryDisc } from "../Send.tsx";
import { PlusIcon } from "./icons.tsx";
import { PHONE_IDS } from "./ids.ts";

export type PhoneToolbarProps = {
  chatId: string;
  branch: string;
  /** The box holds nothing to send (no text, quote or image): the primary is Talk. */
  empty: boolean;
  /** Why the composer cannot send now ("" while it can): neither voice control starts anything. */
  voiceOff: string;
  /** The Stop button while the agent works (null: none). */
  stop: ReactNode;
  /** The Send button in its state (Composer.tsx draws it, `size="touch"`). */
  send: ReactNode;
  /** "+" opens the Add to message sheet; `plusOff` says why it cannot now ("" while it can). */
  onPlus(): void;
  plusOff: string;
};

export function PhoneToolbar({ chatId, branch, empty, voiceOff, stop, send, onPlus, plusOff }: PhoneToolbarProps) {
  const { tokens: t } = useTheme();
  const parts = useComposerParts();
  const Voice = parts.VoiceControl;
  // (while Dictate listens the primary stays Send, even with an empty box: Talk would start speech mode over the dictation)
  const dictating = useVoiceSession((s) => s.owner !== null && s.owner.kind === "dictation" && s.owner.chat === chatId && s.owner.branch === branch);
  // The primary: Stop while the agent works (and Send beside it once something is typed); else Talk when the box is empty, Send when it is not.
  // With no voice here (the part is not registered) an empty box shows Send, off.
  const primary = stop
    ? <>{empty ? null : send}{stop}</>
    : empty && Voice && !dictating
      ? (
        <Voice chatId={chatId} branch={branch} which="talk" disabled={voiceOff}>
          {(s) => (
            <IconButton {...tid(PHONE_IDS.talk, { on: s.on })} size="touch" title={s.label} disabled={s.disabled} aria-pressed={s.on} keepFocus onPress={s.onPress}>
              <PrimaryDisc on={s.on} disabled={s.disabled}><WaveIcon size={18} color={s.disabled ? t.faint : s.on ? t.bg : t.onAccent} /></PrimaryDisc>
            </IconButton>
          )}
        </Voice>
      )
      : send;
  return (
    <View {...tid(PHONE_IDS.toolbar)} style={styles.row}>
      <IconButton {...tid(PHONE_IDS.plus)} size="touch" title="Add to message" disabled={!!plusOff} keepFocus aria-haspopup="dialog" onPress={onPlus}>
        {(colour) => <View style={[styles.plus, { borderColor: plusOff ? t.line : t.line2 }]}><PlusIcon color={colour === t.accent ? t.accent : t.text} /></View>}
      </IconButton>
      <View style={styles.grow} />
      <View style={styles.ring}><ContextMeter chat={chatId} compact size="touch" /></View>
      {Voice ? (
        <Voice chatId={chatId} branch={branch} which="dictate" disabled={voiceOff}>
          {(s) => (
            <IconButton {...tid(PHONE_IDS.dictate, { on: s.on })} size="touch" title={s.label} disabled={s.disabled} on={s.on} aria-pressed={s.on} keepFocus onPress={s.onPress}>
              {(colour) => s.on
                // (while it listens the mic fills with the accent: co-06c note 1)
                ? <View style={[styles.micOn, { backgroundColor: t.accentFill }]}><MicIcon size={20} color={t.onAccent} /></View>
                : <MicIcon size={20} color={colour === t.accent ? t.accent : t.text} />}
            </IconButton>
          )}
        </Voice>
      ) : null}
      {primary}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 2, marginTop: 2 },
  grow: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  plus: { width: 32, height: 32, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  micOn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  ring: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
});
