// What a chat of another server shows when that server is not connected or no longer has the chat (the old page's ChatView.tsx's remote bar
// and remote-off view, B-RO): under the thread that stays, a warning with "Servers…"; in the thread's place when the app has none,
// the sentence alone, with the server's state and "Servers…", or "Try again".
//
// On the phone (ux-improvements goal 3.5, mockup 10 "Another server: offline and archived") there is no bar under the thread: the composer's place
// says it once. The thread's place keeps its sentence, in the phone's sizes, with the server's state word and since when, and "Servers" opens the
// server's detail. `useBackOnline` shows the "<Server> is back online" toast when the server of a chat on screen returns.
import { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

import { serverOfKey } from "@aiwb/core/logic/keys.ts";
import { SERVERS, TRY_AGAIN } from "@aiwb/core/logic/remoteview.ts";
import { serverConnected, serverName } from "@aiwb/core/logic/serverlists.ts";
import { formatSince } from "@aiwb/core/logic/statewords.ts";
import { loadItems } from "@aiwb/core/state/conn.ts";
import { openServers } from "@aiwb/core/state/serversdialog.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { TYPE } from "../../ui/metrics.ts";
import { StateWord, useServerWord } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { usePhone } from "../../ui/useLayout.ts";
import { openServerDetail } from "../home/serverseam.ts";
import { backOnlineStep, backOnlineText, type Seen } from "./backonline.ts";
import { OFFLINE_ID } from "./offlineids.ts";

/** The warning under a thread that stays as it was. gone: the chat is no longer on its server (no "Servers…" then). Not drawn on the phone. */
export function RemoteBar({ text, state, gone }: { text: string; state?: string; gone: boolean }) {
  const t = useTokens();
  if (usePhone()) return null;
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
  if (usePhone()) return <RemoteOffPhone kind={kind} text={text} chatId={chatId} />;
  return (
    <View {...tid("remote-off", { kind })} role="status" style={styles.off}>
      <Text {...tid("remote-off-text")} style={styles.centred}>{text}</Text>
      {kind === "unreachable" && state ? <Text {...tid("remote-off-state")} size={12} tone="muted" style={styles.centred}>{state}</Text> : null}
      {kind === "unreachable" && <Button {...tid("remote-servers")} label={SERVERS} size="sm" onPress={() => openServers()} />}
      {kind === "failed" && <Button {...tid("remote-retry")} label={TRY_AGAIN} size="sm" onPress={() => void loadItems(chatId)} />}
    </View>
  );
}

/** The phone's thread place: a 16 pt sentence, the server's state word (13 pt) with since when, and 44 pt buttons. */
function RemoteOffPhone({ kind, text, chatId }: { kind: "unreachable" | "gone" | "failed"; text: string; chatId: string }) {
  const server = serverOfKey(chatId);
  const view = useStore((s) => s.servers.find((v) => v.id === server));
  const since = useStore((s) => s.serverSince[server]);
  const word = useServerWord({ state: view?.state ?? "unreachable" });
  return (
    <View {...tid("remote-off", { kind })} role="status" style={styles.off}>
      <Text {...tid("remote-off-text")} size={TYPE.body} style={styles.centred}>{text}</Text>
      {kind === "unreachable" ? (
        <View {...tid("remote-off-state")} style={styles.state}>
          <StateWord word={word} />
          {since !== undefined ? <Text {...tid(OFFLINE_ID.since)} size={TYPE.secondary} tone="muted">{formatSince(since, Date.now())}</Text> : null}
        </View>
      ) : null}
      {kind === "unreachable" && <Button {...tid("remote-servers")} label="Servers" size="touch" style={styles.centre} onPress={() => openServerDetail(server)} />}
      {kind === "failed" && <Button {...tid("remote-retry")} label={TRY_AGAIN} size="touch" style={styles.centre} onPress={() => void loadItems(chatId)} />}
    </View>
  );
}

/** Shows "<Server> is back online" when the server of the chat `chatId` goes from not connected to connected while the chat is on screen (the
 *  phone only; backonline.ts says when). The thread calls it; the toast stands above the composer, which asks for its own measured height (PhoneComposer.tsx useToastLift). */
export function useBackOnline(chatId: string): void {
  const phone = usePhone();
  const server = serverOfKey(chatId);
  const connected = useStore((s) => serverConnected(s, server));
  const name = useStore((s) => serverName(s, server));
  const seen = useRef<Seen>(null);
  useEffect(() => {
    const step = backOnlineStep(seen.current, server, connected);
    seen.current = step.seen;
    if (phone && step.show) showToast({ text: backOnlineText(name), kind: "back-online" });
  }, [server, connected, name, phone]);
}

const styles = StyleSheet.create({
  state: { flexDirection: "row", alignItems: "center", gap: 8 },
  centre: { alignSelf: "center" },
  bar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 6, paddingHorizontal: 10, borderWidth: 1, borderRadius: 8 },
  barText: { flex: 1, minWidth: 0 },
  off: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingTop: 10, paddingHorizontal: 8, paddingBottom: 24 },
  centred: { textAlign: "center" },
});
