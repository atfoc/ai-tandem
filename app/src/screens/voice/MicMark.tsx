// The mic mark (VC-23, goal 3.1): a small microphone at the corner of a user message that this device sent by voice, so that a spoken turn can be
// told from a typed one. It is the chat part `MessageMark`, which ItemView draws inside a user message; it draws nothing for any other message. The
// mark is kept on this device only (voice/engine/marks.ts), for the branch the thread shows.
import { StyleSheet, View } from "react-native";

import { shownBranch } from "@aiwb/core/state/store.ts";
import type { ChatView, Item } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { MicIcon } from "../../ui/icons.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { useSpokenMark } from "../../voice/index.ts";
import { MIC_MARK } from "../../voice/words.ts";

export function MicMark({ chat, index, item }: { chat: ChatView; index: number; item: Item }) {
  const { tokens: t } = useTheme();
  const branch = useStore((s) => shownBranch(s, chat.id));
  const spoken = useSpokenMark(chat.id, branch, index);
  if (item.kind !== "user" || !spoken) return null;
  return (
    <View {...tid("msg-mic")} accessibilityLabel={MIC_MARK} pointerEvents="none" style={[styles.mark, { backgroundColor: t.bg, borderColor: t.line2 }]}>
      <MicIcon size={10} color={t.accent} />
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { position: "absolute", left: -7, bottom: -5, width: 18, height: 18, borderRadius: 9, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
