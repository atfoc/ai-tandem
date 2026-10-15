// The phone's way into the add form (S12, goal 4.7): paste what the server printed (the whole output of setup-remote.sh, or an address and the
// secret), or scan the code scripts/server-code.sh shows, and the form is filled; the user then tests the connection and accepts the
// fingerprint as always. Nothing is weaker than typing the fields: the text goes through the parser of @aiwb/core (https only, the form's own
// rules), the fingerprint is never accepted for the user, and the secret goes into the form's field alone (the box that held the paste is
// emptied at once, and the words never repeat the secret). Also: why the system will ask to reach the local network, before the first
// connection (AD-34), and the way to the settings when it was refused (`LocalNetworkHelp`).
import { useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";

import type { ServerForm as Form } from "@aiwb/core/logic/servers.ts";

import { localNetwork, type LocalNetworkState } from "../../platform/localnetwork";
import { CodeScanner, canScan } from "../../platform/scan";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { MONO } from "../../ui/fonts.ts";
import { useLayout } from "../../ui/useLayout.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { chooseAddress, FP_DIFFERS, FP_MATCH, fingerprintLine, isPaste, LOCAL_NETWORK_DENIED_HELP, LOCAL_NETWORK_WHY, read } from "./addcode.ts";
import { ownerThings } from "./model.ts";
import { Field, FpLine, Line, PLAIN_INPUT } from "./parts.tsx";

/** Whether the add form offers the code: on a phone's layout, and wherever the app has no server of its own (a phone or a tablet app). */
export function useCodeFlow(): boolean {
  const layout = useLayout();
  return layout === "phone" || !ownerThings();
}

/** What the person is told when the system refused the local network, with the way to the settings where the system has them. */
export function LocalNetworkHelp() {
  const { tokens: t } = useTheme();
  return (
    <View {...tid("addserver-localnet-denied")} role="alert" style={[styles.box, { borderColor: t.warn, backgroundColor: t.warnSoft }]}>
      <Text selectable size={12}>{LOCAL_NETWORK_DENIED_HELP}</Text>
      {localNetwork.canOpenSettings ? (
        <Button size="sm" label="Open settings" testID="addserver-open-settings" style={styles.gap} onPress={() => void localNetwork.openSettings().catch(() => {})} />
      ) : null}
    </View>
  );
}

/** presented = the fingerprint the server presented to the last test of the form as it is, which is set against the one the text printed. */
export function AddByCode({ form, set, presented }: { form: Form; set(patch: Partial<Form>): void; presented?: string }) {
  const { tokens: t } = useTheme();
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const [code, setCode] = useState<{ addresses: string[]; fingerprint?: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [net, setNet] = useState<LocalNetworkState>("unknown");
  useEffect(() => {
    let live = true;
    localNetwork.state().then((s) => { if (live) setNet(s); }, () => {});
    return () => { live = false; };
  }, []);

  /** Takes a text (pasted or scanned): fills the form, or answers the words of the refusal and fills nothing. */
  const take = (raw: string): string | null => {
    const r = read(form, raw);
    if (!r.ok) { setNote({ ok: false, message: r.message }); return r.message; }
    set(r.form);
    setCode({ addresses: r.addresses, fingerprint: r.fingerprint });
    setText("");
    setNote({ ok: true, message: "Filled in the address and the secret from the text. Now test the connection." });
    return null;
  };

  const match = fingerprintLine(presented, code?.fingerprint);
  const asks = Platform.OS !== "android" && net !== "granted";
  return (
    <View {...tid("addserver-code-box")}>
      <Text size={12} tone="muted" style={styles.lead}>Paste what the server printed (setup-remote.sh), or scan its code.</Text>
      <Field {...PLAIN_INPUT} label="Pasted text" field="code" value={text} multiline numberOfLines={3} autoCapitalize="none" autoCorrect={false} spellCheck={false}
        placeholder="Paste the output of setup-remote.sh, or an address and the secret"
        onChangeText={(next) => { const was = text; setText(next); if (isPaste(was, next)) take(next); }} />
      <View style={styles.actions}>
        <Button size="sm" label="Fill in the form" testID="addserver-read" disabled={!text.trim()} onPress={() => take(text)} />
        {canScan ? <Button size="sm" label="Scan code" testID="addserver-scan" onPress={() => setScanning(true)} /> : null}
      </View>
      {note ? <Text {...tid("addserver-note", { ok: note.ok })} role={note.ok ? "status" : "alert"} selectable size={12} tone={note.ok ? "ok" : "danger"} style={styles.gap}>{note.message}</Text> : null}
      {code?.fingerprint ? <FpLine label="The text says the fingerprint is" fp={code.fingerprint} /> : null}
      {match ? <Text {...tid("addserver-fp-match", { match })} role="status" selectable size={12} weight="600" tone={match === "match" ? "ok" : "danger"} style={styles.gap}>{match === "match" ? FP_MATCH : FP_DIFFERS}</Text> : null}
      {code && code.addresses.length > 1 ? (
        <View style={styles.gap}>
          <Line>The text has {code.addresses.length} addresses. Use the one this phone can reach:</Line>
          {code.addresses.map((a) => {
            const on = form.address === a;
            return (
              <Pressable key={a} {...tid("addserver-address", { address: a })} role="radio" aria-checked={on} accessibilityState={{ checked: on }} accessibilityLabel={a}
                onPress={() => set(chooseAddress(form, a))} style={[styles.choice, { borderColor: on ? t.accentFill : t.line2 }, webStyle({ cursor: "pointer" })]}>
                <Text size={11} mono style={{ fontFamily: MONO }}>{a}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {asks ? <Text {...tid("addserver-localnet")} selectable size={12} tone="muted" style={styles.gap}>{LOCAL_NETWORK_WHY}</Text> : null}
      {scanning ? <CodeScanner onText={(s) => { const why = take(s); if (why === null) setScanning(false); return why; }} onClose={() => setScanning(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  lead: { marginTop: 6 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  gap: { marginTop: 8 },
  box: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 8, borderRadius: 6, borderWidth: 1 },
  choice: { marginTop: 4, borderWidth: 1, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 },
});
