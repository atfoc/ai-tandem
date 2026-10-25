// The chat's route of the phone's stack: a chat's own header carries the back on the phone (S8), so its title is shown once.
import { StyleSheet, View } from "react-native";

import { useTheme } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { Guard } from "../Guard.tsx";
import { useSlots } from "../slots.tsx";
import { useShellView } from "../useShellView.ts";

export function ChatRoute() {
  const { tokens: t } = useTheme();
  const slots = useSlots();
  const view = useShellView();
  const chat = view.kind === "home" ? null : view.chat;
  if (!chat) return <View style={[styles.fill, { backgroundColor: t.bg }]} />;
  return (
    <View {...tid("chat-page")} style={[styles.fill, { backgroundColor: t.bg }]}>
      <Guard what="this page" resetKey={chat}><slots.ChatView chat={chat} /></Guard>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
