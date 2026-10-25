// Home's body when the app has no server at all (plans/ux-improvements/h1-design.md §4.1; mockup sh-08a). Home draws the top row above it.
import { Linking, Pressable, StyleSheet, View } from "react-native";

import { AgentGlyph, BoardIcon } from "../../ui/icons.tsx";
import { Button } from "../../ui/Button.tsx";
import { MONO } from "../../ui/fonts.ts";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { FIRST_RUN_STEPS, SETUP_GUIDE_URL, stepText } from "./cards.ts";
import { H1_TID } from "./ids.ts";
import { openAddServer } from "./serverseam.ts";
import { ServerGlyph, Tile } from "./Tile.tsx";

export function FirstRun() {
  const t = useTokens();
  return (
    <View {...tid(H1_TID.firstRun)} style={styles.root}>
      <View style={styles.tiles}>
        <Tile tone="accent"><BoardIcon size={22} color={t.accent} /></Tile>
        <Tile tone="claude"><AgentGlyph agent="claude" size={22} /></Tile>
        <Tile tone="plain"><ServerGlyph color={t.muted} /></Tile>
      </View>
      <Text size={TYPE.h2} weight="600" accessibilityRole="header" style={styles.title}>Connect to your computer</Text>
      <Text size={TYPE.body} tone="muted" style={styles.lead}>
        Your boards and chats live on a computer that runs the AI Whiteboard server. This phone connects to it over your network.
      </Text>
      <View style={styles.actions}>
        <Button {...tid(H1_TID.firstRunAdd)} size="block" tone="primary" label="Add a server" accessibilityLabel="Add a server" onPress={() => openAddServer("paste")} />
        <Button {...tid(H1_TID.firstRunScan)} size="block" accessibilityLabel="Scan the server's code" onPress={() => openAddServer("scan")} style={{ borderColor: t.accent }}>
          <Text size={TYPE.control} tone="accent">Scan the server's code</Text>
        </Button>
      </View>
      <View style={[styles.card, { backgroundColor: t.panel, borderColor: t.line2 }]}>
        <Text size={TYPE.secondary} tone="muted" weight="500" accessibilityRole="header" style={styles.cardHead}>ON YOUR COMPUTER</Text>
        {FIRST_RUN_STEPS.map((step, i) => (
          <View key={i} accessible accessibilityLabel={`Step ${i + 1}: ${stepText(step)}`} style={styles.step}>
            <Text size={TYPE.busy} style={styles.num}>{i + 1}.</Text>
            <Text size={TYPE.busy} style={styles.stepText}>
              {step.map((p, j) => p.code
                ? <Text key={j} mono size={TYPE.secondary + 1} style={{ fontFamily: MONO }}>{p.text}</Text>
                : p.text)}
            </Text>
          </View>
        ))}
      </View>
      <Pressable {...tid(H1_TID.firstRunGuide)} accessibilityRole="link" accessibilityLabel="How to set up a server" style={styles.link}
        onPress={() => { Linking.openURL(SETUP_GUIDE_URL).catch(() => { /* no app takes the address: nothing opens */ }); }}>
        <Text size={TYPE.control} tone="accent">How to set up a server</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: PHONE.margin, paddingTop: 16, paddingBottom: 24 },
  tiles: { flexDirection: "row", justifyContent: "center", gap: 18 },
  title: { textAlign: "center", marginTop: 28 },
  lead: { textAlign: "center", marginTop: 8, marginBottom: 20 },
  actions: { gap: 12 },
  card: { marginTop: 24, borderWidth: 1, borderRadius: 4, paddingVertical: 14, paddingHorizontal: 16, gap: 8 },
  cardHead: { letterSpacing: 0.4, marginBottom: 2 },
  step: { flexDirection: "row", gap: 6 },
  num: { width: 20 },
  stepText: { flex: 1 },
  link: { alignSelf: "center", minHeight: PHONE.target, justifyContent: "center", paddingHorizontal: 12, marginTop: 8 },
});
