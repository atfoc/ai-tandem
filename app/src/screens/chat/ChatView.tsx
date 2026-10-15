// One chat: its header, its thread and, under them, the composer (K3 fills that place: parts.tsx). The shell mounts it in the
// `ChatView` slot (screens/shell/slots.tsx) for a plain chat's page, for the panel beside a board and for the phone's chat screen.
import { StyleSheet, View } from "react-native";

import { shownView } from "@aiwb/core/state/store.ts";

import { useStore } from "../../state/useStore.ts";
import { tid } from "../../ui/tid.ts";
import { MarkdownEnvProvider } from "../markdown/index.ts";
import { ChatHeader } from "./Header.tsx";
import { Thread } from "./Thread.tsx";
import { chatMarkdownEnv } from "./env.ts";
import { useChatParts } from "./parts.tsx";

export function ChatView({ chat }: { chat: string }) {
  const parts = useChatParts();
  const c = useStore((s) => shownView(s, chat));
  if (!c) return null;
  return (
    <MarkdownEnvProvider env={chatMarkdownEnv}>
      {/* a plain chat's page is a column of at most 780 px; the panel beside a board takes its pane */}
      <View {...tid("chat", { chat })} style={[styles.root, !c.board && styles.col]}>
        <ChatHeader chatId={chat} />
        <Thread chatId={chat} />
        <parts.Banner chat={chat} />
        <parts.Composer chat={chat} />
      </View>
    </MarkdownEnvProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0, minWidth: 0 },
  col: { width: "100%", maxWidth: 780, alignSelf: "center" },
});
