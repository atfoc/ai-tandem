// The board host on the phone (AD-52, spike board-webview): board-view's one-file page in a `react-native-webview`, reached
// through the typed bridge only. The page loads from the app's own file with no network, takes no navigation, opens no
// window and keeps nothing on disk; messages go in by the web view's `postMessage` (the page takes the events that have no
// source, AD-51) and come out as the text the page posts. The channel (boardchannel.ts) holds what is sent until the page
// says `ready`; if the web view's process ends (iOS kills it under memory pressure) the requests in flight are refused, the
// web view is made anew (a new `key`) and the board side sends its board again when the page says `ready`.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import type { BoardHostProps } from "./board.types.ts";
import { navigation } from "./boardnav.ts";
import { createHostChannel, drained } from "./boardchannel.ts";
import { resolvePage, type PageSource } from "./boardpage.native.ts";

export type { BoardHostProps, HostChannel } from "./board.types.ts";

export const BOARD_VIEW_ID = "board-view";

/** Whether the web view lets the user select text and use the text caret outside an input (iOS `textInteractionEnabled`). Tried on the
 *  iPad simulator with Excalidraw's text tool (flow board-webview, package B5): with the on-screen keyboard, tap the text tool, tap the
 *  canvas, type, and the page tells the text, with `true` and with `false` alike; a long press in the open editor kept its caret with
 *  `true` and lost it with `false` (the editor is for typing and selecting text, so it stays on the web view's own default). Drawing
 *  by finger works with either. */
export const TEXT_INTERACTION = true;

export function BoardHost({ onChannel, hidden, onOpenLink, testID = BOARD_VIEW_ID }: BoardHostProps) {
  const web = useRef<WebView>(null);
  const [page, setPage] = useState<PageSource | null>(null);
  const [epoch, setEpoch] = useState(0); // raised when the web view's process ended: the page is loaded again
  const latest = useRef({ onChannel, onOpenLink });
  latest.current = { onChannel, onOpenLink };
  const link = useMemo(() => createHostChannel((m) => web.current?.postMessage(JSON.stringify(m))), []);

  useEffect(() => {
    latest.current.onChannel(link.channel);
    return () => {
      latest.current.onChannel(null);
      // (the board side may have asked the view for its scene as the board was left; it answers, then the view goes)
      void drained(link.channel).then(() => link.reset("the board view was closed"));
    };
  }, [link]);

  useEffect(() => {
    let live = true;
    resolvePage().then((p) => { if (live) setPage(p); }, (e) => { link.receive({ t: "error", message: e?.message ?? String(e) }); });
    return () => { live = false; };
  }, [link]);

  const ended = useCallback((why: string) => { link.reset(why); setEpoch((n) => n + 1); }, [link]);
  const onMessage = useCallback((e: WebViewMessageEvent) => link.receive(e.nativeEvent.data), [link]);

  if (!page) return <View style={hidden ? styles.hidden : styles.fill} />;
  return (
    <View style={hidden ? styles.hidden : styles.fill} pointerEvents={hidden ? "none" : "auto"} testID={testID}>
      <WebView
        key={epoch}
        ref={web}
        style={styles.web}
        source={{ uri: page.uri }}
        // NOT ["file://*"]: react-native-webview hands every address that fails the whitelist to Linking.openURL (it opened Safari
        // on the simulator) without asking onShouldStartLoadWithRequest. "*" lets every request reach the handler below.
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(r) => {
          const n = navigation(r.url, page.uri);
          if (n.allow) return true;
          if (n.open) latest.current.onOpenLink?.(n.open);
          else console.warn(`board view: refused a navigation to a ${n.scheme || "unknown"} address`);
          return false;
        }}
        allowingReadAccessToURL={page.dir}
        allowFileAccess
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        javaScriptEnabled
        incognito
        cacheEnabled={false}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        allowsLinkPreview={false}
        allowsBackForwardNavigationGestures={false}
        hideKeyboardAccessoryView
        textInteractionEnabled={TEXT_INTERACTION}
        webviewDebuggingEnabled={__DEV__}
        onMessage={onMessage}
        onError={(e) => link.receive({ t: "error", message: `the board page did not load: ${e.nativeEvent.description}` })}
        onHttpError={(e) => link.receive({ t: "error", message: `the board page did not load (${e.nativeEvent.statusCode})` })}
        onContentProcessDidTerminate={() => ended("the board view's process ended")}
        onRenderProcessGone={() => ended("the board view's process ended")}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minHeight: 0, backgroundColor: "transparent" },
  web: { flex: 1, backgroundColor: "transparent" },
  hidden: { position: "absolute", width: 1, height: 1, opacity: 0, overflow: "hidden" },
});
