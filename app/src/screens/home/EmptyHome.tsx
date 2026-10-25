// Home's body when the selected server is connected and has nothing on it (plans/ux-improvements/h1-design.md §4.4; mockup sh-08b).
// Home draws the top row, the title and the sub-line above it.
import { StyleSheet, View } from "react-native";

import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { usableAgents } from "@aiwb/core/logic/agentlist.ts";
import { ungroupedOn } from "@aiwb/core/logic/keys.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { BoardIcon, ChatIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { addBoard, newChat } from "../shell/nav.ts";
import { agentsLine } from "./cards.ts";
import { H1_TID } from "./ids.ts";
import { Tile } from "./Tile.tsx";

export function EmptyHome({ view }: { view: ServerView }) {
  const t = useTokens();
  const usable = useStore((s) => usableAgents(s, view.id));
  const place = ungroupedOn(view.id);
  return (
    <View {...tid(H1_TID.empty)} style={styles.root}>
      <View style={styles.tiles}>
        <Tile tone="plain"><ChatIcon size={22} color={t.muted} /></Tile>
        <Tile tone="accent"><BoardIcon size={22} color={t.accent} /></Tile>
      </View>
      <Text size={TYPE.h2} weight="600" accessibilityRole="header" style={styles.title}>Start a chat or a whiteboard</Text>
      <Text {...tid(H1_TID.emptyAgents)} size={TYPE.body} tone="muted" style={styles.lead}>{agentsLine(usable, view.name)}</Text>
      <View style={styles.actions}>
        <Button {...tid(H1_TID.emptyChat)} size="block" tone="primary" label="New chat" accessibilityLabel="New chat" onPress={() => void newChat({ group: place })} />
        <Button {...tid(H1_TID.emptyBoard)} size="block" accessibilityLabel="New whiteboard" onPress={() => addBoard(place)} style={{ borderColor: t.accent }}>
          <Text size={TYPE.control} tone="accent">New whiteboard</Text>
        </Button>
      </View>
      <Text size={TYPE.secondary} tone="muted" style={styles.note}>A whiteboard is an Excalidraw board with its own chats that can see it and draw on it.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: PHONE.margin, paddingTop: 24, paddingBottom: 24 },
  tiles: { flexDirection: "row", justifyContent: "center", gap: 18 },
  title: { textAlign: "center", marginTop: 24 },
  lead: { textAlign: "center", marginTop: 8, marginBottom: 20 },
  actions: { gap: 12 },
  note: { textAlign: "center", marginTop: 20 },
});
