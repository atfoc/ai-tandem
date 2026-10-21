// The composer's two voice controls (VC-17, goal 3.2, 3.4): Dictate and Speech mode. The toolbar draws them as one pair after its spacer, before
// the attach button (`place` "row": two icon buttons), or as two entries of its "more" popup when even the narrowest row has no room (`place` "more"). Each is a
// toggle: Dictate starts listening into the composer's box and stops when pressed again; Speech mode starts speech mode for the chat (its bar,
// when there is one, is the composer part SpeechBar) and ends it when pressed again. With no key, or on any other failure, the engine shows the
// problem popover on the anchor given here and the control hangs one from itself (ProblemPopover.tsx).
// Dictation (architecture §8.1): the box's text at the start is the base; the box shows base, then the finished words, then the live guess, and
// when dictation ends it keeps what it showed. A person who types in the box ends dictation, and the box is left as typed.
import { useContext, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { DictationBoxContext, type DictationBox } from "../composer/dictation.ts";
import { useMeasuring } from "../composer/measure.tsx";
import { sendMessage } from "../composer/send.ts";
import { voice, useVoiceSession } from "../../voice/index.ts";
import { DICTATE_STOP_TITLE, DICTATE_TITLE, SPEECH_END_TITLE, SPEECH_TITLE } from "../../voice/words.ts";
import { IconButton } from "../../ui/IconButton.tsx";
import { MicIcon, WaveIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useControlRef } from "../../ui/useControlRef";
import { webStyle } from "../../ui/webstyle.ts";
import { ProblemPopover } from "./ProblemPopover.tsx";

export type ComposerVoiceProps = { chatId: string; branch: string; place: "row" | "more"; disabled: string };

/** The box's text with the words of dictation after `base`: one space between them, none where either is empty or white space is there already. */
export function dictated(base: string, words: string): string {
  if (!words) return base;
  return !base || /\s$/.test(base) ? base + words : `${base} ${words}`;
}

/** Whether the voice session running is `kind` of this composer's chat and branch. */
function useOwns(kind: "dictation" | "speech", chat: string, branch: string): boolean {
  return useVoiceSession((s) => s.owner !== null && s.owner.kind === kind && s.owner.chat === chat && s.owner.branch === branch);
}

/** Starts dictation into `box`: it ends when the session does, or when the person types in the box. */
function dictate(box: DictationBox, chat: string, branch: string): void {
  const base = box.text();
  let typed = false;
  const off = box.watch(() => { typed = true; off(); voice.end(); });
  const put = (text: string) => { if (!typed && text !== box.text()) box.put(text); };
  void voice.startDictation({
    chat, branch, anchor: `dictate:${chat}`,
    sink: {
      show: ({ committed, partial }) => put(dictated(base, [committed, partial].filter(Boolean).join(" "))),
      done: (text) => { off(); put(dictated(base, text.trim())); },
    },
  });
}

export function ComposerVoice({ chatId, branch, place, disabled }: ComposerVoiceProps) {
  const measuring = useMeasuring();
  const box = useContext(DictationBoxContext);
  const dictating = useOwns("dictation", chatId, branch);
  const speaking = useOwns("speech", chatId, branch);
  const dictateRef = useRef<View>(null), speechRef = useRef<View>(null);
  const onDictate = () => {
    if (dictating) voice.end();
    else if (box) dictate(box, chatId, branch);
  };
  const onSpeech = () => {
    if (speaking) { voice.end(); return; }
    void voice.startSpeech({ chat: chatId, branch, anchor: `speech:${chatId}`, send: (text) => (box ? box.keeping(() => sendMessage(chatId, text)) : sendMessage(chatId, text)) });
  };
  const dictateLabel = dictating ? DICTATE_STOP_TITLE : DICTATE_TITLE, speechLabel = speaking ? SPEECH_END_TITLE : SPEECH_TITLE;
  const dictateTitle = disabled || dictateLabel, speechTitle = disabled || speechLabel; // (the tooltip says why a control is off)
  const ids = (id: string, on: boolean) => (measuring ? {} : tid(id, { on }));
  // (what is drawn in the measuring layer takes no press and carries no id; it hangs no popover either)
  const popover = (anchor: string, target: typeof dictateRef) => (measuring ? null : <ProblemPopover anchor={`${anchor}:${chatId}`} target={target} align="right" up />);

  if (place === "more") {
    return (
      <>
        <View {...tid("more-row", { control: "dictate" })} style={styles.moreRow}>
          <View ref={dictateRef} collapsable={false}>
            <MoreEntry id="more-dictate" label={dictateLabel} title={dictateTitle} disabled={!!disabled} on={dictating} onPress={onDictate} icon={(c) => <MicIcon color={c} />} />
          </View>
          {popover("dictate", dictateRef)}
        </View>
        <View {...tid("more-row", { control: "speech" })} style={styles.moreRow}>
          <View ref={speechRef} collapsable={false}>
            <MoreEntry id="more-speech" label={speechLabel} title={speechTitle} disabled={!!disabled} on={speaking} onPress={onSpeech} icon={(c) => <WaveIcon color={c} />} />
          </View>
          {popover("speech", speechRef)}
        </View>
      </>
    );
  }
  return (
    <View style={styles.pair}>
      <View ref={dictateRef} collapsable={false}>
        <IconButton {...ids("voice-dictate", dictating)} title={dictateTitle} disabled={!!disabled} on={dictating} keepFocus aria-pressed={dictating} onPress={onDictate}>
          {(c) => <MicIcon color={c} />}
        </IconButton>
      </View>
      {popover("dictate", dictateRef)}
      <View ref={speechRef} collapsable={false}>
        <IconButton {...ids("voice-speech", speaking)} title={speechTitle} disabled={!!disabled} on={speaking} keepFocus aria-pressed={speaking} onPress={onSpeech}>
          {(c) => <WaveIcon color={c} />}
        </IconButton>
      </View>
      {popover("speech", speechRef)}
    </View>
  );
}

/** An entry of the "more" popup: the control's icon and its name, as tall as a chip (the insert entry's look). */
function MoreEntry({ id, label, title, disabled, on, onPress, icon }: {
  id: string; label: string; title: string; disabled: boolean; on: boolean; onPress(): void; icon(colour: string): ReactNode;
}) {
  const { tokens: t } = useTheme();
  const measuring = useMeasuring();
  const ref = useControlRef(title);
  const colour = on ? t.accent : t.muted;
  return (
    <Pressable ref={ref} {...(measuring ? {} : tid(id, { on }))} role="button" aria-pressed={on} disabled={disabled} accessibilityLabel={title} onPress={onPress}
      style={({ hovered }: { hovered?: boolean; pressed: boolean }) => [styles.entry, { backgroundColor: t.panel, borderColor: hovered ? t.line2 : "transparent" }, disabled && styles.dim, webStyle({ cursor: "pointer" })]}>
      {icon(colour)}
      <Text size={12}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pair: { flexDirection: "row", alignItems: "center", gap: 4 },
  moreRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  entry: { flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 8, borderWidth: 1, borderRadius: 6 },
  dim: { opacity: 0.35 },
});
