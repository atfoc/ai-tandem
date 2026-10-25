// The kit gallery's section "P3 FormSheet and P4 ConfirmSheet" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// `kit-open-<case>` opens a case (`shell-confirm` calls the shell's confirm()); `kit-forms-last` says what ended last: "saved:<text>", "deleted", "confirmed", "shell-deleted" or "closed".
// The gallery has no shell, so the section mounts the shell's ConfirmDialog itself, for the case that calls the shell's `confirm()`.
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";

import { ConfirmDialog } from "../../screens/shell/ConfirmDialog.tsx";
import { confirm } from "../../screens/shell/confirm.ts";
import { Button } from "../../ui/Button.tsx";
import { ConfirmSheet } from "../../ui/ConfirmSheet.tsx";
import { FormSheet } from "../../ui/FormSheet.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";

type Case = "form" | "form-fails" | "confirm" | "confirm-fails" | "confirm-accent";
const CASES: Case[] = ["form", "form-fails", "confirm", "confirm-fails", "confirm-accent"];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const CHAT = "Fix the flaky cart test";
const GONE = "The chat and its whole history are removed from Studio Mac. This can't be undone.";

export function Section() {
  const { tokens: t } = useTheme();
  const [shown, setShown] = useState<Case | null>(null);
  const [last, setLast] = useState("closed");
  const [text, setText] = useState("");
  const close = () => setShown(null);
  const show = (c: Case) => { setLast("closed"); setText(""); setShown(c); };
  /** The shell's `confirm()` with one danger action, as the screens call it. */
  const askShell = () => {
    setLast("closed");
    confirm({ title: `Delete “${CHAT}”?`, body: GONE, confirmLabel: "Delete chat",
      actions: [{ label: "Delete", tone: "danger", run: async () => { await wait(600); setLast("shell-deleted"); } }] });
  };
  const form = (fails: boolean) => (
    <FormSheet open={shown === (fails ? "form-fails" : "form")} onClose={close} title="Rename chat" sub="Checkout service · Studio Mac"
      canSave={text.trim() !== ""} dirty={text !== ""}
      onSave={async () => { await wait(600); if (fails) throw new Error("Could not save: the server is offline"); setLast(`saved:${text}`); }}>
      <View style={styles.field}>
        <Text size={TYPE.secondary} tone="muted">Name</Text>
        <TextInput testID="kit-form-field" value={text} onChangeText={setText} placeholder={CHAT} placeholderTextColor={t.faint} accessibilityLabel="Name"
          style={[styles.input, { color: t.text, borderColor: t.line2, backgroundColor: t.panel }]} />
      </View>
    </FormSheet>
  );
  return (
    <View style={styles.section}>
      <View style={styles.row}>
        {CASES.map((c) => <Button key={c} size="touch" label={c} testID={`kit-open-${c}`} onPress={() => show(c)} />)}
        <Button size="touch" label="shell-confirm" testID="kit-open-shell-confirm" onPress={askShell} />
      </View>
      <Text testID="kit-forms-last" tone="muted">{last}</Text>

      {form(false)}
      {form(true)}

      <ConfirmSheet open={shown === "confirm"} onClose={close} title={`Delete “${CHAT}”?`} body={GONE} confirmLabel="Delete chat"
        onConfirm={async () => { await wait(600); setLast("deleted"); }} />
      <ConfirmSheet open={shown === "confirm-fails"} onClose={close} title={`Delete “${CHAT}”?`} body={GONE} confirmLabel="Delete chat"
        onConfirm={async () => { await wait(600); throw new Error("Could not delete: the server is offline"); }} />
      <ConfirmSheet open={shown === "confirm-accent"} onClose={close} tone="accent" title="Save and close?" body="Your changes are saved to Studio Mac, then the form closes."
        confirmLabel="Save and close" onConfirm={async () => { await wait(600); setLast("confirmed"); }} />
      <ConfirmDialog />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  field: { gap: 6, padding: PHONE.margin - 8, paddingTop: 12 },
  input: { minHeight: PHONE.target, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, fontSize: TYPE.control },
});
