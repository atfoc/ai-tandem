// A server's certificate on the phone (goal 3.8.4, mockups dl-05c, dl-05d): the fingerprint it is trusted by, or, when it changed, where to
// read the true one (the command, with Copy, or a scan of the server's code), the one presented now in 16 red blocks and the old one muted,
// "Trust the new certificate…" with its P4, and "Not now". A scan whose fingerprint is the presented one is the check, so it trusts without
// the P4. What is sent to a server and the trust rules are today's: the trust is `serversApi.accept`, as the row of the dialog calls it.
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { serversApi } from "@aiwb/core/serversapi.ts";
import { answered } from "@aiwb/core/state/serversdialog.ts";
import type { ServerForm, ServerView } from "@aiwb/core/logic/servers.ts";

import { copyText } from "../../platform/clipboard";
import { CodeScanner, canScan } from "../../platform/scan";
import { useStore } from "../../state/useStore.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { ConfirmSheet } from "../../ui/ConfirmSheet.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { MONO } from "../../ui/fonts.ts";
import { goBack } from "../shell/BackButton.tsx";
import { isPaste, read } from "./addcode.ts";
import { CERT_MISMATCH, CERT_NO_PRINT, firstPairs, samePrinted } from "./cert/compare.ts";
import { fpEnds, WORDS } from "./facts.ts";
import { CopyMark, Note } from "./facts/parts.tsx";
import { Fingerprint } from "./facts/Fingerprint.tsx";
import { S2_TID } from "./ids.ts";
import type { ServerParams } from "./open.ts";
import { Field, said } from "./parts.tsx";

const NO_FORM: ServerForm = { name: "", address: "", secret: "", selfSigned: false, pin: "" };

export function CertScreen({ params }: { params: ServerParams }) {
  const v = useStore((s) => s.servers.find((x) => x.id === params.id));
  const t = useTokens();
  if (!v) {
    return (
      <View {...tid(S2_TID.cert, { server: params.id, changed: "gone" })} style={styles.gone}>
        <Text size={TYPE.control} tone="muted" style={styles.centred}>This server is no longer in your list.</Text>
      </View>
    );
  }
  const changed = v.state === "certificate_changed";
  return (
    <ScrollView {...tid(S2_TID.cert, { server: v.id, changed: changed ? "yes" : "no" })} style={[styles.page, { backgroundColor: t.panel }]} contentContainerStyle={styles.content}>
      {changed ? <Changed v={v} /> : <Unchanged v={v} />}
    </ScrollView>
  );
}

/** The command's cell: the command in the mono type and a 44 pt Copy. */
function CommandCell() {
  const t = useTokens();
  const copy = () => copyText(WORDS.command).then(() => showToast({ text: "Command copied" }), () => showToast({ text: "Could not copy the command" }));
  return (
    <View {...tid(S2_TID.command)} style={styles.command}>
      <Text selectable size={TYPE.control} weight="600" style={styles.commandText}>{WORDS.command}</Text>
      <Pressable onPress={() => void copy()} accessibilityRole="button" accessibilityLabel="Copy command" style={({ pressed }: { pressed: boolean }) => [styles.copy, pressed && { backgroundColor: t.accentSoft }]}>
        <CopyMark color={t.accent} />
      </Pressable>
    </View>
  );
}

/** "#": the code the scan reads, as the add flow's row draws it. */
function CodeGlyph({ color }: { color: string }) {
  return <Text size={TYPE.control} style={[styles.hash, { color }]}>#</Text>;
}

function Changed({ v }: { v: ServerView }) {
  const t = useTokens();
  const name = v.name;
  const [confirming, setConfirming] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [err, setErr] = useState("");
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");

  // The same call as the row of the dialog: the fingerprint presented now is the one trusted. The entry then reconnects; the detail shows it.
  const trust = async () => {
    const a = await serversApi.accept(v.id, v.fingerprint ?? "");
    answered(a?.server);
    goBack();
  };

  const onText = (text: string): string | null => {
    const r = read(NO_FORM, text);
    if (!r.ok) return r.message;
    if (!r.fingerprint) return CERT_NO_PRINT;
    setScanning(false);
    if (!samePrinted(r.fingerprint, v.fingerprint)) { setMismatch(true); return null; }
    // the check was made: no P4
    setMismatch(false); setErr("");
    trust().then(() => showToast({ text: `${name}'s new certificate is trusted` }), (e) => setErr(said(e)));
    return null;
  };

  /** The pasted text goes through the same reading as a scan; the box is emptied at once (the code holds the secret) and keeps only a refusal's words. */
  const compareText = (raw: string) => {
    setText("");
    const why = onText(raw);
    if (why) setErr(why); else { setErr(""); setPasting(false); }
  };

  return (
    <View {...tid("srv-cert-changed")}>
      <CellGroup title={`1 · ON ${name.toUpperCase()}, RUN`}>
        <CommandCell />
        {canScan ? (
          <Cell label="Or scan its code instead" sub="server-code.sh · the app compares for you" tone="accent" chevron={false} testID={S2_TID.scanCompare}
            leading={<CodeGlyph color={t.accent} />} onPress={() => { setMismatch(false); setScanning(true); }} />
        ) : (
          <Cell label="Or paste its code instead" sub="what server-code.sh printed · the app compares for you" tone="accent" chevron={false} testID={S2_TID.pasteCompare}
            leading={<CodeGlyph color={t.accent} />} onPress={() => { setMismatch(false); setErr(""); setPasting(true); }} />
        )}
        {!canScan && pasting ? (
          <View style={styles.paste}>
            <Field label="Pasted code" field="code" value={text} multiline numberOfLines={3} autoCapitalize="none" autoCorrect={false} spellCheck={false}
              placeholder="Paste the text server-code.sh printed"
              onChangeText={(next) => { const was = text; setText(next); if (isPaste(was, next)) compareText(next); }} />
            <Pressable {...tid(S2_TID.pasteRead)} onPress={() => compareText(text)} disabled={!text.trim()} accessibilityRole="button" accessibilityLabel="Compare the pasted code"
              style={[styles.pasteRead, !text.trim() && { opacity: 0.4 }]}>
              <Text size={TYPE.control} tone="accent">Compare</Text>
            </Pressable>
          </View>
        ) : null}
      </CellGroup>
      <Note>{WORDS.commandNote(firstPairs(v.fingerprint))}</Note>

      <CellGroup title="2 · IT MUST PRINT THIS · PRESENTED NOW">
        <View style={styles.print}><Fingerprint value={v.fingerprint} tone="bad" testID={S2_TID.fpNow} label="Presented now" /></View>
      </CellGroup>
      {mismatch ? <Text {...tid("srv-scan-mismatch")} accessibilityRole="alert" size={TYPE.secondary} weight="600" tone="danger" style={styles.flag}>{CERT_MISMATCH}</Text> : null}
      {err ? <Text {...tid("srv-cert-error")} accessibilityRole="alert" size={TYPE.secondary} tone="danger" style={styles.flag}>{err}</Text> : null}

      <CellGroup title="ACCEPTED BEFORE">
        <View style={styles.print}><Fingerprint value={v.pin} tone="muted" testID={S2_TID.fpOld} label="Accepted before" /></View>
      </CellGroup>

      <View style={styles.buttons}>
        <Pressable {...tid(S2_TID.trust)} onPress={() => setConfirming(true)} accessibilityRole="button" accessibilityLabel="Trust the new certificate…"
          style={({ pressed }: { pressed: boolean }) => [styles.trust, { backgroundColor: t.dangerSoft }, pressed && { opacity: 0.8 }]}>
          <Text size={TYPE.control} tone="danger">Trust the new certificate…</Text>
        </Pressable>
        <Pressable {...tid(S2_TID.notNow)} onPress={goBack} accessibilityRole="button" accessibilityLabel="Not now" style={styles.notNow}>
          <Text size={TYPE.control} tone="accent">Not now</Text>
        </Pressable>
      </View>

      <ConfirmSheet open={confirming} onClose={() => setConfirming(false)} tone="danger" title={WORDS.trustTitle(name)}
        body={WORDS.trustBody(name, fpEnds(v.fingerprint))} confirmLabel="Trust and reconnect" onConfirm={trust} />
      {scanning ? <CodeScanner onText={onText} onClose={() => setScanning(false)} /> : null}
    </View>
  );
}

/** Any other state with a pin: the fingerprint the server is trusted by, and how to read it on the server. */
function Unchanged({ v }: { v: ServerView }) {
  return (
    <View {...tid("srv-cert-same")}>
      <CellGroup title={v.selfSigned ? "Certificate · self-signed" : "Certificate"}>
        <View style={styles.print}>
          {v.pin ? <Fingerprint value={v.pin} tone="plain" testID={S2_TID.fpNow} label="Certificate" /> : <Text size={TYPE.secondary} tone="muted">No certificate is pinned for this server.</Text>}
        </View>
      </CellGroup>
      <CellGroup>
        <CommandCell />
      </CellGroup>
      {v.pin ? <Note>{WORDS.commandNote(firstPairs(v.pin))}</Note> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingTop: 12, paddingBottom: 40 },
  gone: { padding: 24 },
  centred: { textAlign: "center" },
  command: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", gap: 10, paddingLeft: PHONE.margin, paddingRight: 4 },
  commandText: { flex: 1, minWidth: 0, fontFamily: MONO },
  copy: { width: PHONE.target, height: PHONE.target, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  hash: { width: 20, textAlign: "center", fontFamily: MONO },
  paste: { paddingHorizontal: PHONE.margin, paddingBottom: 8 },
  pasteRead: { minHeight: PHONE.target, alignItems: "flex-start", justifyContent: "center" },
  print: { paddingHorizontal: PHONE.margin, paddingVertical: 14 },
  flag: { marginHorizontal: PHONE.margin, marginTop: -10, marginBottom: 20 },
  buttons: { marginHorizontal: PHONE.margin, gap: 6 },
  trust: { minHeight: PHONE.sheetRow, alignItems: "center", justifyContent: "center", borderRadius: 10, paddingHorizontal: 16 },
  notNow: { minHeight: PHONE.target, alignItems: "center", justifyContent: "center" },
});
