// A server's edit form on the phone (P3: Cancel · Edit server · Save), from the detail's "Edit" and the sheet's "Name" row. Mounted once
// in the shell's Overlays (Hosts.tsx) and opened by `openServerEdit(id)` (open.ts). Package S2.
//
// The same save as the Servers dialog's form: `serversApi.edit(id, patchOf(form, entry))`; what changed is what is sent, an empty secret
// keeps the stored one, and a rename alone is saved without a test (the dialog's "force"). When the app's own test did not pass, the
// words of its answer are shown in the form, which stays open. The secret lives in this component's state and is dropped when it closes.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, TextInput, View, type TextInputProps } from "react-native";

import { answered } from "@aiwb/core/state/serversdialog.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";
import { formError, stepText, type ServerForm } from "@aiwb/core/logic/servers.ts";

import { useStore } from "../../state/useStore.ts";
import { Cell, CellGroup } from "../../ui/Cells.tsx";
import { FormSheet } from "../../ui/FormSheet.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { MONO } from "../../ui/fonts.ts";
import { EyeIcon } from "../../ui/icons.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { SecretInput } from "../../ui/SecretInput.tsx";
import { Switch } from "../../ui/Switch.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { webStyle } from "../../ui/webstyle.ts";
import { S2_TID } from "./ids.ts";
import { editForm, patchOf } from "./model.ts";
import { closeServerEdit, useServerEdit } from "./open.ts";
import { PLAIN_INPUT, SECRET_INPUT } from "./parts.tsx";

type Field = "name" | "address" | "secret";

/** One 48 pt row of a group holding a text box (17 pt), and, for the secret, the eye. */
function FieldRow({ field, label, value, onChangeText, secret, ...input }: { field: Field; label: string; value: string; onChangeText(v: string): void; secret?: boolean } & TextInputProps) {
  const t = useTokens();
  const [reveal, setReveal] = useState(false);
  const Input = secret ? SecretInput : TextInput;
  return (
    <View style={styles.row}>
      <Input {...input} {...tid(S2_TID.editField, { field })} value={value} onChangeText={onChangeText} accessibilityLabel={label} aria-label={label}
        placeholderTextColor={t.faint} {...(secret ? { reveal, mono: reveal } : {})}
        style={[styles.input, { color: t.text }, field === "address" && { fontFamily: MONO }, webStyle({ outlineStyle: "none" }) as object]} />
      {secret ? (
        <IconButton size="touch" title={reveal ? "Hide secret" : "Show secret"} on={reveal} onPress={() => setReveal((r) => !r)}>
          {(c) => <EyeIcon size={20} color={c} />}
        </IconButton>
      ) : null}
    </View>
  );
}

function EditSheet({ id, open }: { id: string; open: boolean }) {
  const v = useStore((s) => s.servers.find((x) => x.id === id));
  const latest = useRef(v);
  latest.current = v;
  const [was, setWas] = useState<ServerForm | null>(null);
  const [f, setF] = useState<ServerForm | null>(null);
  useEffect(() => {
    if (open && latest.current) { const start = editForm(latest.current); setWas(start); setF(start); }
    if (!open) setF((x) => (x ? { ...x, secret: "" } : x)); // the secret goes with the form
  }, [open, id]);
  // The entry was removed while the form was open (here or in another window): nothing to edit.
  useEffect(() => { if (open && !v) closeServerEdit(); }, [open, v]);

  const form = f ?? (v ? editForm(v) : null);
  const base = was ?? form;
  if (!form || !base) return null;
  const set = (p: Partial<ServerForm>) => setF({ ...form, ...p });
  const patch = patchOf(form, base);
  const problem = formError(form);
  const changed = Object.keys(patch).length > 0;
  const touched = form.name !== base.name || form.address !== base.address || !!form.secret;

  const save = async () => {
    // A rename alone is saved at once; anything else is tested first by the app (the dialog's "Save" and its force).
    const a = await serversApi.edit(id, patch, Object.keys(patch).join() === "name");
    answered(a?.server);
    if (a?.saved) return;
    const r = a?.result;
    throw new Error(r ? [r.message, r.detail, stepText(r.step)].filter(Boolean).join(" · ") || "The server was not saved." : "The server was not saved.");
  };

  return (
    <FormSheet open={open} onClose={closeServerEdit} title="Edit server" testID={S2_TID.editForm} canSave={changed && !problem} dirty={changed} onSave={save}>
      <View style={styles.page}>
        <CellGroup title="Name">
          <FieldRow {...PLAIN_INPUT} field="name" label="Name" value={form.name} maxLength={80} placeholder="Studio" onChangeText={(name) => set({ name })} />
        </CellGroup>
        <CellGroup title="Address">
          <FieldRow {...PLAIN_INPUT} field="address" label="Address" value={form.address} placeholder="https://host:port" spellCheck={false} autoCapitalize="none"
            autoCorrect={false} keyboardType="url" onChangeText={(address) => set({ address })} />
        </CellGroup>
        <CellGroup title="Secret" footer="Leave empty to keep the secret this phone has.">
          <FieldRow {...SECRET_INPUT} field="secret" label="Secret" value={form.secret} placeholder="Unchanged" onChangeText={(secret) => set({ secret })} />
        </CellGroup>
        <CellGroup>
          <Cell label="Self-signed certificate" chevron={false} onPress={() => set({ selfSigned: !form.selfSigned, pin: form.selfSigned ? "" : form.pin })}
            trailing={<Switch size="touch" on={form.selfSigned} label="Self-signed certificate" onChange={(selfSigned) => set({ selfSigned, pin: selfSigned ? form.pin : "" })} />} />
        </CellGroup>
        {problem && touched ? <Text {...tid("srv-edit-problem")} size={TYPE.secondary} tone="danger" style={styles.problem}>{problem}</Text> : null}
      </View>
    </FormSheet>
  );
}

export function ServerEditHost() {
  const id = useServerEdit();
  const last = useRef<string | null>(null);
  if (id) last.current = id; // the form keeps its server while it closes
  if (!last.current) return null;
  return <EditSheet id={last.current} open={!!id} />;
}

const styles = StyleSheet.create({
  page: { paddingTop: 16 },
  row: { minHeight: PHONE.cell, flexDirection: "row", alignItems: "center", paddingLeft: PHONE.margin, paddingRight: 4 },
  input: { flex: 1, minWidth: 0, minHeight: PHONE.target, fontSize: TYPE.control, paddingVertical: 0 },
  problem: { marginHorizontal: PHONE.margin, marginBottom: 12 },
});
