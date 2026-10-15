// The spike's app: the board in a web view over the typed bridge. With a launch argument (-AIWBScenario auto|touch) it
// runs a check (app/driver.ts) and writes its results; without one it is a small manual harness.
import React, { useMemo, useState } from "react";
import { Button, SafeAreaView, ScrollView, Settings, StyleSheet, Text, View } from "react-native";
import { BoardBridge } from "./bridge/client.ts";
import { BoardView, type PageStats } from "./app/BoardView.tsx";
import { Driver } from "./app/driver.ts";
import { largeScene, smallScene } from "./app/scenes.ts";
import type { ThemeName } from "./bridge/protocol.ts";

const SCENARIO = (Settings.get("AIWBScenario") as string | null) ?? "";

export default function App() {
  const bridge = useMemo(() => new BoardBridge(), []);
  const stats = useMemo<PageStats>(() => ({ loadStartAt: 0, loadEndAt: 0, blockedNavigations: [], processTerminated: 0, errors: [], assetUri: "" }), []);
  const [said, setSaid] = useState("");
  const driver = useMemo(() => {
    if (!SCENARIO) return null;
    const d = new Driver(bridge, stats, SCENARIO);
    void d.run();
    return d;
  }, [bridge, stats]);
  const say = (p: Promise<unknown>) => p.then((r) => setSaid(JSON.stringify(r).slice(0, 300)), (e) => setSaid(String(e.message)));
  const themes: ThemeName[] = ["light", "dark", "latte", "mocha"];
  const [t, setT] = useState(0);
  return (
    <SafeAreaView style={styles.root}>
      {!driver && (
        <View style={styles.bar}>
          <ScrollView horizontal contentContainerStyle={styles.row}>
            <Button title="small" onPress={() => say(bridge.call("loadScene", { scene: smallScene() }))} />
            <Button title="2000" onPress={() => say(bridge.call("loadScene", { scene: largeScene(2000) }, 120000))} />
            <Button title="pen" onPress={() => say(bridge.call("setTool", { tool: "freedraw" }))} />
            <Button title="agent adds" onPress={() => say(bridge.call("applyChange", { change: { create: [{ type: "ellipse", x: 300, y: 300, width: 120, height: 120, label: { text: "Agent" } }] } }))} />
            <Button title="export" onPress={() => say(bridge.call("exportPng", {}).then((r) => ({ w: r.width, h: r.height, bytes: r.bytes })))} />
            <Button title="flush" onPress={() => say(bridge.call("flush", {}))} />
            <Button title={`theme: ${themes[t]}`} onPress={() => { const n = (t + 1) % themes.length; setT(n); say(bridge.call("setTheme", { theme: themes[n] })); }} />
          </ScrollView>
          <Text numberOfLines={2} style={styles.said}>{said}</Text>
        </View>
      )}
      <BoardView bridge={bridge} stats={stats} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  bar: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: "#999" },
  row: { gap: 8, paddingHorizontal: 8 },
  said: { fontSize: 11, paddingHorizontal: 8, color: "#333" },
});
