// The login row of an account (multiple-claude goal §1.3, screen 3): drawn under the account's row while its login runs, and in its
// sheet. The URL was opened on this device (core state/aliases.ts startLogin, with the platform's openLater); the row says so, asks for the
// code Claude shows, and has Submit, Open link again and Cancel. A malformed code shows Claude's error in red under the field, which stays
// for another try; a well-formed wrong one ends the login (failed): the row shows the error and Log in again, which starts a new one. A
// right code ends the flow, and the chip says "Logged in as <email>" from the list that follows. Words and buttons: core's loginView.
import { useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { LOGIN_WORDS, loginView, type LoginFlow } from "@aiwb/core/logic/aliases.ts";
import { cancelLogin, openLinkAgain, submitCode } from "@aiwb/core/state/aliases.ts";

import { openLater, openLink } from "../../../platform/openlink";
import { useTokens } from "../../../ui/theme.tsx";
import { tid } from "../../../ui/tid.ts";
import { ActionButton, Actions, Field, Line, useSizes } from "./parts.tsx";
import { ACCOUNTS_TID } from "./ids.ts";
import { logIn } from "./open.ts";
import { Text } from "../../../ui/Text.tsx";

export function LoginRow({ server, id, flow }: { server: string; id: string; flow: LoginFlow }) {
  const t = useTokens(), { name } = useSizes();
  const [code, setCode] = useState("");
  const v = loginView(flow);
  if (!v) return null;
  const submit = () => { if (!code.trim() || v.busy) return; submitCode(server, id, code.trim()).catch(() => { /* (the flow keeps the sentence) */ }); };
  // The URL kept opens now; without one the login is started again, and the window it goes to is readied now (openLater: in the press).
  const openAgain = () => { openLinkAgain(server, id, flow.url ? openLink : openLater()).catch(() => { /* (the flow says it) */ }); };
  return (
    <View {...tid(ACCOUNTS_TID.login, { id, phase: flow.phase })} style={[styles.box, { borderColor: t.line, backgroundColor: t.panel }]}>
      <View style={styles.head}>
        {v.busy ? <ActivityIndicator size="small" color={t.muted} /> : null}
        <Text size={name} weight="600" style={styles.grow}>{v.line}</Text>
      </View>
      {v.code ? (
        <Field label={v.prompt ?? LOGIN_WORDS.prompt} testID={ACCOUNTS_TID.code} value={code} onChangeText={setCode} autoCapitalize="none" placeholder="Code"
          returnKeyType="go" onSubmitEditing={submit} editable={!v.busy} />
      ) : null}
      {v.error ? <View accessibilityRole="alert"><Line testID={ACCOUNTS_TID.loginError} tone="danger">{v.error}</Line></View> : null}
      <Actions>
        {v.code ? <ActionButton tone="primary" label={LOGIN_WORDS.submit} testID={ACCOUNTS_TID.codeSubmit} disabled={v.busy || !code.trim()} onPress={submit} /> : null}
        {v.again?.action === "link" ? <ActionButton label={v.again.label} testID={ACCOUNTS_TID.openAgain} disabled={v.busy} onPress={openAgain} /> : null}
        {v.again?.action === "login" ? (
          <ActionButton tone="primary" label={v.again.label} testID={ACCOUNTS_TID.loginAgain} disabled={v.busy} onPress={() => logIn(server, id)} />
        ) : null}
        <ActionButton label={LOGIN_WORDS.cancel} testID={ACCOUNTS_TID.loginCancel} onPress={() => { cancelLogin(server, id).catch(() => { /* (dropped here whatever it answers) */ }); }} />
      </Actions>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 10, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 12, gap: 2 },
  head: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flexShrink: 1 },
});
