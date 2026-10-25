// The kit gallery's section "Sizes (Button, IconButton, Switch, SecretInput, DialogActions)" (`/?gallery=kit`, dev/KitGallery.tsx; package F1 of plans/ux-improvements/PLAN.md).
// Its cases are what web/dev/checks/UX.F1-kit.mjs opens and measures: every control a check presses has a testID `kit-<what>`.
// `kit-sizes-last` says what was pressed last. The `md` and `sm` cases sit in a View with the dataSet `kit-small`: the phone sweep skips them.
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import { Button } from "../../ui/Button.tsx";
import { DialogActions } from "../../ui/Dialog.tsx";
import { EyeIcon } from "../../ui/icons.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { SearchField } from "../../ui/SearchField.tsx";
import { SecretInput } from "../../ui/SecretInput.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";

/** The `md` and `sm` cases are the sizes that stay as they were; the check's phone sweep (UX.F1-kit.mjs) leaves what has this out. */
const SMALL = { kitSmall: "1" };

export function Section() {
  const t = useTokens();
  const [last, setLast] = useState("");
  const [on, setOn] = useState(false);
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <View style={styles.col}>
      <Text testID="kit-sizes-last" tone="muted">{last}</Text>
      <View style={styles.row}>
        <View dataSet={SMALL}><Button testID="kit-btn-md" label="Medium" onPress={() => setLast("btn-md")} /></View>
        <View dataSet={SMALL}><Button testID="kit-btn-sm" size="sm" label="Small" onPress={() => setLast("btn-sm")} /></View>
        <Button testID="kit-btn-touch" size="touch" label="Touch" onPress={() => setLast("btn-touch")} />
        <View dataSet={SMALL}>
          <IconButton testID="kit-icon-md" title="Medium icon" onPress={() => setLast("icon-md")}>{(c) => <EyeIcon size={14} color={c} />}</IconButton>
        </View>
        <IconButton testID="kit-icon-touch" size="touch" title="Touch icon" onPress={() => setLast("icon-touch")}>{(c) => <EyeIcon size={18} color={c} />}</IconButton>
        <View testID="kit-switch-touch">
          <Switch size="touch" on={on} label="A switch" onChange={(next) => { setOn(next); setLast(next ? "switch on" : "switch off"); }} />
        </View>
      </View>
      <Button testID="kit-btn-block" size="block" tone="danger" label="Remove server" onPress={() => setLast("btn-block")} />
      <View style={styles.row}>
        <SecretInput testID="kit-secret" value={secret} onChangeText={setSecret} reveal={reveal} mono placeholder="Secret" accessibilityLabel="Secret"
          style={[styles.secret, { color: t.text, backgroundColor: t.panel }]} />
        <IconButton testID="kit-secret-eye" size="touch" title={reveal ? "Hide secret" : "Show secret"} on={reveal}
          onPress={() => { setReveal(!reveal); setLast(reveal ? "secret hidden" : "secret shown"); }}>{(c) => <EyeIcon size={18} color={c} />}</IconButton>
      </View>
      <View testID="kit-actions-stacked">
        <DialogActions layout="stacked">
          <Button size="block" label="Cancel" onPress={() => setLast("stacked cancel")} />
          <Button size="block" tone="danger" label="Remove server" onPress={() => setLast("stacked remove")} />
        </DialogActions>
      </View>
      <View testID="kit-search" style={styles.search}>
        <SearchField value={query} onChangeText={setQuery} placeholder="Search chats" onCancel={() => setLast("search cancel")} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  col: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  secret: { flex: 1, minWidth: 160, minHeight: PHONE.target, fontSize: TYPE.control, paddingHorizontal: 12, borderRadius: 10 },
  search: { marginHorizontal: -PHONE.margin },
});
