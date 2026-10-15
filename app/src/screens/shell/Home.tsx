// The home screen: what the window shows when nothing is selected (the old page's App.tsx `Home`); while this computer's server has not
// answered, a spinner in its place.
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { homeAgentsText, usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { localOf } from "@aiwb/core/logic/localsection.ts";
import { UNGROUPED } from "@aiwb/core/types.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon, ChatIcon } from "../../ui/icons.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { addBoard, newChat } from "./nav.ts";

/** The home screen's sentence on agents while this computer's server is not connected: what agents it has is not known now. */
export const HOME_AWAY = "This computer's server is not connected: chats can be started when it is back.";

/** Home, or the spinner while this computer's server has not answered (the window does not wait for it, and says so when it is not there). */
export function HomeOrWait() {
  const connecting = useStore((s) => !s.connected && localOf(s.servers)?.state === "connecting");
  return connecting ? <Waiting /> : <Home />;
}

function Waiting() {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("home")} dataSet={{ waiting: true }} style={styles.home}>
      <ActivityIndicator {...tid("home-spin")} size="small" color={t.accent} />
    </View>
  );
}

export function Home() {
  const { tokens: t } = useTheme();
  const agents = useStore((s) => usableAgents(s));
  const here = useStore((s) => s.connected); // things are made on this computer: its server has to be connected
  return (
    <View {...tid("home")} style={styles.home}>
      <View {...tid("home-glyphs")} style={styles.glyphs}><ChatIcon size={26} color={t.muted} /><BoardIcon size={26} color={t.accent} /></View>
      <Text size={18} weight="600" accessibilityRole="header" style={styles.title}>Start a chat or a whiteboard</Text>
      <Text tone="muted" style={styles.lead}>{here ? homeAgentsText(agents) : HOME_AWAY} A whiteboard is an Excalidraw board with its own chats that can see and draw on it.</Text>
      <View style={styles.actions}>
        <Button {...tid("home-new-chat")} tone="primary" disabled={!here} icon={<ChatIcon color={t.onAccent} />} label="New chat" onPress={() => void newChat({ group: UNGROUPED })} />
        <Button {...tid("home-new-board")} disabled={!here} icon={<BoardIcon color={t.accent} />} label="New whiteboard" onPress={() => addBoard(UNGROUPED)} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  home: { flex: 1, minWidth: 0, alignItems: "center", justifyContent: "center", gap: 10, padding: 40 },
  glyphs: { flexDirection: "row", gap: 10 },
  title: { marginTop: 6, textAlign: "center" },
  lead: { maxWidth: 420, textAlign: "center", marginBottom: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 8 },
});
