import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { setState } from "@aiwb/core/state/store.ts";

import { NO_WAY } from "./appname.ts";
import { bootstrap } from "./bootstrap.ts";
import { ChipDocGallery } from "./dev/ChipDocGallery.tsx";
import { Gallery } from "./dev/Gallery.tsx";
import { StorageProbe } from "./dev/StorageProbe.tsx";
import { kv } from "./platform/kv";
import { markReady } from "./platform/lifecycle";
import "./screens/register.ts";
import { Shell } from "./screens/shell/Shell.tsx";
import { ThemeProvider, useTheme } from "./ui/theme.tsx";

/** The gallery asked for: on web by the URL, `/?gallery` (the primitives, package U2) or `/?gallery=chipdoc` (the native chip
 *  input's logic, package K2); on iOS and Android by the bundle, EXPO_PUBLIC_AIWB_GALLERY=chipdoc (the device checks of app/e2e). */
const gallery = (): string | null =>
  Platform.OS === "web" ? new URLSearchParams(window.location.search).get("gallery") : process.env.EXPO_PUBLIC_AIWB_GALLERY ?? null;

/** A build made for the device tests (AD-83) shows their root instead of the app: `EXPO_PUBLIC_AIWB_SELFTEST=1`, set by app/e2e/run.mjs. */
const selfTest = process.env.EXPO_PUBLIC_AIWB_SELFTEST === "1";

/** The device test of the secure storage reads a line the app shows of it (package V4, dev/StorageProbe.tsx): EXPO_PUBLIC_AIWB_PROBE=1, development builds only. */
const probe = __DEV__ && process.env.EXPO_PUBLIC_AIWB_PROBE === "1";

export default function App() {
  if (selfTest) {
    const { SelfTestRoot } = require("./dev/SelfTestRoot.tsx") as typeof import("./dev/SelfTestRoot.tsx");
    return <SelfTestRoot />;
  }
  const which = gallery();
  if (which !== null) {
    return (
      <GestureHandlerRootView style={styles.fill}>
        <SafeAreaProvider>
          <ThemeProvider>{which === "chipdoc" ? <ChipDocGallery /> : <Gallery />}</ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    );
  }
  return <Root />;
}

/** The app: bootstrapped once (bootstrap.ts), then the shell; a web page with no way to a server says so, as the old page does. */
function Root() {
  const [ready] = useState(bootstrap);
  useEffect(() => { if (!ready) markReady(); }, [ready]);
  if (!ready) return <View testID="no-way" style={styles.noWay}><Text style={styles.noWayText}>{NO_WAY}</Text></View>;
  return (
    <GestureHandlerRootView style={styles.fill}>
      <SafeAreaProvider>
        <ThemeProvider kv={kv}>
          <ThemeToStore />
          <Shell />
          {probe ? <StorageProbe /> : null}
          <StatusBar style="auto" />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** The store's `themePref` and `theme` follow the theme provider's (what the board's view and the sidebar read of them). */
function ThemeToStore() {
  const { pref, theme } = useTheme();
  useEffect(() => { setState({ themePref: pref, theme }); }, [pref, theme]);
  return null;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  noWay: { flex: 1, alignItems: "center", marginTop: "20vh" as unknown as number, marginHorizontal: 16 },
  noWayText: { fontSize: 15, textAlign: "center", opacity: 0.8 },
});
