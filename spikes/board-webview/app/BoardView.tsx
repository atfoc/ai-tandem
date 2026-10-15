// The board in a web view: the page that ships in the app (assets/board.html, built by webview/build.mjs) and nothing else.
// It loads from the app's own bundle with no network, takes no navigation, opens no window, keeps nothing on disk, and
// talks to the app through the typed bridge (bridge/protocol.ts) only.
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { Asset } from "expo-asset";
import type { BoardBridge } from "../bridge/client.ts";

export type PageStats = { loadStartAt: number; loadEndAt: number; blockedNavigations: string[]; processTerminated: number; errors: string[]; assetUri: string };

export function BoardView({ bridge, stats, onPageLoaded }: { bridge: BoardBridge; stats: PageStats; onPageLoaded?: () => void }) {
  const ref = useRef<WebView>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0); // raised when the page's process was killed: the page is loaded again

  useEffect(() => {
    let live = true;
    (async () => {
      const a = Asset.fromModule(require("../assets/board.html"));
      await a.downloadAsync();
      const u = a.localUri ?? a.uri;
      stats.assetUri = u;
      if (live) setUri(u);
    })();
    return () => { live = false; };
  }, [stats]);

  useEffect(() => { bridge.attach((raw) => ref.current?.postMessage(raw)); }, [bridge]);
  if (!uri) return <View style={styles.fill} />;
  const dir = uri.slice(0, uri.lastIndexOf("/") + 1);
  return (
    <WebView
      key={epoch}
      ref={ref}
      style={styles.fill}
      source={{ uri }}
      // NOT ["file://*"]: react-native-webview hands every URL that fails the whitelist to Linking.openURL (it opens
      // Safari!) without asking onShouldStartLoadWithRequest. "*" lets every request reach the handler below, which refuses.
      originWhitelist={["*"]}
      allowingReadAccessToURL={dir}
      // the page is one file, loaded once: a navigation (a link, a redirect, a frame, window.open) is refused
      onShouldStartLoadWithRequest={(r) => {
        if (r.url === uri) return true;
        stats.blockedNavigations.push(r.url);
        return false;
      }}
      setSupportMultipleWindows={false}
      javaScriptCanOpenWindowsAutomatically={false}
      incognito // nothing of the page is kept on disk
      cacheEnabled={false}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      allowsLinkPreview={false}
      allowsBackForwardNavigationGestures={false}
      hideKeyboardAccessoryView
      textInteractionEnabled={false}
      webviewDebuggingEnabled
      onLoadStart={() => { stats.loadStartAt = Date.now(); }}
      onLoadEnd={() => { stats.loadEndAt = Date.now(); onPageLoaded?.(); }}
      onError={(e) => { stats.errors.push(`error ${e.nativeEvent.description}`); }}
      onHttpError={(e) => { stats.errors.push(`http ${e.nativeEvent.statusCode} ${e.nativeEvent.url}`); }}
      // iOS kills a page's process when memory is short: the board is shown again by the app (its scene is the app's)
      onContentProcessDidTerminate={() => { stats.processTerminated++; bridge.reset("the page's process ended"); setEpoch((n) => n + 1); }}
      onMessage={(e) => bridge.onMessage(e.nativeEvent.data)}
    />
  );
}

const styles = StyleSheet.create({ fill: { flex: 1, backgroundColor: "#fff" } });
