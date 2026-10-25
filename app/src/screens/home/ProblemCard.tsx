// The card above Home's list when the selected server is in trouble (plans/ux-improvements/h1-design.md §4.3; mockup sh2-10d).
// Red for the words that are bad, amber for Too old. Its buttons: Try again (a test of the saved entry, or for this computer the
// actions its section of the sidebar gives: logic/localsection.ts), Review for a certificate that changed, and Details.
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, View } from "react-native";

import { serversApi } from "@aiwb/core/serversapi.ts";
import { localExtra } from "@aiwb/core/logic/localsection.ts";
import type { ServerView } from "@aiwb/core/logic/servers.ts";
import { SERVER_WORDS } from "@aiwb/core/logic/statewords.ts";
import { inDesktopApp, openServerLog, pageVersion, restartServer, startAgain } from "@aiwb/core/state/version.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { MONO } from "../../ui/fonts.ts";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { toneOf, useServerWord, wordColour } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { said } from "../servers/parts.tsx";
import { problemSentence, wordSince } from "./cards.ts";
import { H1_TID } from "./ids.ts";
import { openServerDetail } from "./serverseam.ts";

export function ProblemCard({ view }: { view: ServerView }) {
  const t = useTokens();
  const word = useServerWord(view);
  const since = useStore((s) => s.serverSince[view.id]);
  const restart = useStore((s) => s.restart);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { setMessage(""); }, [view.state, view.id]); // an answer belongs to the state it came under
  const warn = word.tone === "warn";
  const edge = warn ? t.warn : t.danger, fill = warn ? t.warnSoft : t.dangerSoft;
  const cert = word.key === SERVER_WORDS.certChanged.key;
  const x = view.local ? localExtra(view, restart, pageVersion(), inDesktopApp()) : null;
  const sentence = problemSentence(word.key, view.name, view.version);
  const reason = word.reason ?? "";

  const tryAgain = async () => {
    setBusy(true); setMessage("");
    try {
      const res = await serversApi.testSaved(view.id);
      if (res && !res.ok) setMessage(res.message);
    } catch (e) { setMessage(said(e)); } finally { setBusy(false); }
  };
  const restarting = restart.phase === "restarting";
  // This computer's section offers "Retry" (start it again, or restart it again), "Restart server" and "Open server log".
  const own = x ? [
    ...(x.again ? [{ id: "again", label: "Try again", run: x.again === "start" ? startAgain : restartServer }] : []),
    ...(x.restart ? [{ id: "restart", label: "Restart server", run: restartServer }] : []),
    ...(x.log ? [{ id: "log", label: "Open server log", run: openServerLog }] : []),
  ] : [];

  return (
    <View {...tid(H1_TID.problemCard, { server: view.id, word: word.key })} role="alert" style={[styles.card, { backgroundColor: fill, borderColor: edge }]}>
      <View style={styles.head}>
        <View style={styles.name}>
          <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.dot, { backgroundColor: toneOf(t, word.tone) }]} />
          <Text size={TYPE.control} weight="600" style={styles.nameText}>{view.name}</Text>
        </View>
        <Text size={TYPE.secondary} style={[styles.since, { color: wordColour(t, word.tone) }]}>{wordSince(word.text, since, Date.now())}</Text>
      </View>
      {sentence ? <Text size={TYPE.body}>{sentence}</Text> : null}
      {x?.line ? <Text size={TYPE.secondary} tone="muted">{x.line}</Text> : null}
      {reason || x?.reason ? (
        <ScrollView {...tid(H1_TID.problemReason)} nestedScrollEnabled style={[styles.reason, { borderColor: t.line2, backgroundColor: t.bg }]} contentContainerStyle={styles.reasonBody}>
          <Text selectable mono size={TYPE.secondary} tone="muted" style={{ fontFamily: MONO }}>{x?.reason || reason}</Text>
        </ScrollView>
      ) : null}
      {message ? <Text {...tid(H1_TID.problemMessage)} selectable size={TYPE.secondary} tone={warn ? "warn" : "danger"}>{message}</Text> : null}
      <View style={styles.actions}>
        {cert ? (
          <Button {...tid(H1_TID.problemReview)} size="touch" tone="primary" label="Review" accessibilityLabel={`Review ${view.name}'s certificate`} onPress={() => openServerDetail(view.id)} />
        ) : x ? own.map((a, i) => (
          <Button key={a.id} {...tid(a.id === "again" ? H1_TID.problemRetry : a.id === "restart" ? H1_TID.problemRestart : H1_TID.problemLog)} size="touch" tone={i === 0 ? "primary" : "default"} label={a.label}
            accessibilityLabel={a.label} disabled={restarting} onPress={a.run} />
        )) : (
          <Button {...tid(H1_TID.problemRetry)} size="touch" tone="primary" label={busy ? "Trying…" : "Try again"} accessibilityLabel={busy ? "Trying again" : `Try ${view.name} again`}
            disabled={busy} onPress={() => void tryAgain()} />
        )}
        <Button {...tid(H1_TID.problemDetails)} size="touch" accessibilityLabel={`${view.name} details`} onPress={() => openServerDetail(view.id)}>
          <Text size={TYPE.control} tone="accent">Details</Text>
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: PHONE.margin, marginBottom: 12, borderWidth: 1, borderRadius: 4, paddingVertical: 12, paddingHorizontal: 12, gap: 8 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  name: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, minWidth: 0 },
  nameText: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  since: { flexShrink: 1, textAlign: "right" },
  reason: { maxHeight: 160, flexGrow: 0, borderWidth: 1, borderRadius: 6 },
  reasonBody: { paddingVertical: 6, paddingHorizontal: 8 },
  actions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 8, marginTop: 2 },
});
