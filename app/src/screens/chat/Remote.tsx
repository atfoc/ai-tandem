// What a chat of another server shows when that server is not connected or no longer has the chat (the old page's ChatView.tsx's remote bar
// and remote-off view, B-RO): under the thread that stays, a warning with "Servers…"; in the thread's place when the app has none,
// the sentence alone, with the server's state and "Servers…", or "Try again".
import { StyleSheet, View } from "react-native";

import { SERVERS, TRY_AGAIN } from "@aiwb/core/logic/remoteview.ts";
import { loadItems } from "@aiwb/core/state/conn.ts";
import { openServers } from "@aiwb/core/state/serversdialog.ts";

import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";

/** The warning under a thread that stays as it was. gone: the chat is no longer on its server (no "Servers…" then). */
export function RemoteBar({ text, state, gone }: { text: string; state?: string; gone: boolean }) {
  const t = useTokens();
  return (
    <View {...tid("remote-bar", { kind: gone ? "gone" : "off" })} role="status" accessibilityLiveRegion="polite"
      style={[styles.bar, { backgroundColor: t.warnSoft, borderColor: t.warn }]}>
      <Text {...tid("remote-bar-text")} size={12} style={styles.barText}>{text}</Text>
      {state ? <Text {...tid("remote-bar-state")} size={12} tone="muted">{state}</Text> : null}
      {!gone && <Button {...tid("remote-servers")} label={SERVERS} tone="ghost" size="sm" onPress={() => openServers()} />}
    </View>
  );
}

/** The thread's place when the app holds none of the chat: the sentence, and by kind the state and "Servers…", or "Try again". */
export function RemoteOff({ kind, text, state, chatId }: { kind: "unreachable" | "gone" | "failed"; text: string; state?: string; chatId: string }) {
  return (
    <View {...tid("remote-off", { kind })} role="status" style={styles.off}>
      <Text {...tid("remote-off-text")} style={styles.centred}>{text}</Text>
      {kind === "unreachable" && state ? <Text {...tid("remote-off-state")} size={12} tone="muted" style={styles.centred}>{state}</Text> : null}
      {kind === "unreachable" && <Button {...tid("remote-servers")} label={SERVERS} size="sm" onPress={() => openServers()} />}
      {kind === "failed" && <Button {...tid("remote-retry")} label={TRY_AGAIN} size="sm" onPress={() => void loadItems(chatId)} />}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderRadius: 8 },
  barText: { flex: 1, minWidth: 0 },
  off: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 10, paddingHorizontal: 8, paddingBottom: 24 },
  centred: { textAlign: "center" },
});
