// The add and edit form of the Servers dialog (the old page's Servers.tsx `ServerForm`): Name, Address, Secret, the self-signed box, "Test connection",
// the fingerprint to compare and "Accept fingerprint", "Save anyway" and "Save", by the rules of logic/servers.ts (formError, formView).
// The secret is held here alone, and dropped at save and at close. The phone's add-server flow (S12) opens this form with the fields
// filled (`openServers(form)`) and puts its own steps (paste, scan) before it.
import { useState } from "react";
import { Keyboard, View } from "react-native";

import { answered } from "@aiwb/core/state/serversdialog.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";
import { formError, formView, stepText, type ServerForm as Form, type TestResult } from "@aiwb/core/logic/servers.ts";

import { Button } from "../../ui/Button.tsx";
import { DialogActions, DialogError, DialogTitle } from "../../ui/Dialog.tsx";
import { tid } from "../../ui/tid.ts";
import { AddByCode, LocalNetworkHelp, useCodeFlow } from "./AddByCode.tsx";
import { isLocalNetworkDenied } from "./addcode.ts";
import { patchOf } from "./model.ts";
import { Check, Field, FpLine, Line, PLAIN_INPUT, Result, SECRET_INPUT, said } from "./parts.tsx";

export function ServerForm({ initial, onClose }: { initial: Form; onClose: () => void }) {
  const [f, setF] = useState<Form>(initial);
  const [tested, setTested] = useState<Form | null>(null);
  const [r, setR] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const code = useCodeFlow(); // the phone's way in (S12): paste or scan what the server printed
  const problem = formError(f);
  const view = formView(f, tested, r, initial);
  const current = view.message !== undefined ? r : null; // the answer of the form as it is now
  const done = () => { setF((x) => ({ ...x, secret: "" })); onClose(); };
  const set = (p: Partial<Form>) => setF((x) => ({ ...x, ...p }));

  const runTest = async (form: Form) => {
    Keyboard.dismiss(); // the answer shows below the boxes
    setBusy(true); setErr("");
    try {
      const res = form.id
        ? await serversApi.testSaved(form.id, { address: form.address, selfSigned: form.selfSigned, pin: form.pin, ...(form.secret ? { secret: form.secret } : {}) })
        : await serversApi.test(form);
      setTested(form); setR(res);
    } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  // The fingerprint goes into the form, and the test runs again: only now is the secret sent.
  const accept = (fingerprint: string) => { const next = { ...f, selfSigned: true, pin: fingerprint }; setF(next); void runTest(next); };
  const save = async (force: boolean) => {
    const sent = f;
    Keyboard.dismiss();
    setBusy(true); setErr("");
    try {
      const a = sent.id ? await serversApi.edit(sent.id, patchOf(sent, initial), force) : await serversApi.add(sent, force);
      answered(a?.server);
      if (a?.saved) return done();
      // The app ran the test itself, and it did not pass.
      setTested(sent); setR(a?.result ?? null);
      if (!a?.result) setErr("The server was not saved.");
      setBusy(false);
    } catch (e) { setErr(said(e)); setBusy(false); }
  };
  // Enter in a field saves when it can, else tests.
  const submit = () => { if (busy) return; if (view.canSave) void save(!!view.force); else if (!problem) void runTest(f); };

  return (
    <View {...tid("servers-form", { mode: f.id ? "edit" : "add" })}>
      <DialogTitle>{f.id ? "Edit server" : "Add server"}</DialogTitle>
      {code && !f.id ? <AddByCode form={f} set={set} presented={view.accept} /> : null}
      <Field {...PLAIN_INPUT} label="Name" field="name" value={f.name} autoFocus maxLength={80} placeholder="Studio" onChangeText={(name) => set({ name })} onSubmitEditing={submit} returnKeyType="go" />
      <Field {...PLAIN_INPUT} label="Address" field="address" value={f.address} placeholder="https://host:port" spellCheck={false} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" onChangeText={(address) => set({ address })} onSubmitEditing={submit} returnKeyType="go" />
      <Field {...SECRET_INPUT} label="Secret" field="secret" value={f.secret}
        placeholder={f.id ? "unchanged" : ""} onChangeText={(secret) => set({ secret })} onSubmitEditing={submit} returnKeyType="go" />
      <Check testID="servers-selfsigned" label="Self-signed certificate" value={f.selfSigned} onChange={(selfSigned) => set({ selfSigned, pin: selfSigned ? f.pin : "" })} />
      {f.selfSigned && f.pin ? <FpLine label="Accepted fingerprint" fp={f.pin} /> : null}
      {problem && (f.name || f.address || f.secret) ? <Line testID="servers-problem">{problem}</Line> : null}
      <Result ok={!!current?.ok} message={view.message} step={current && !current.ok ? stepText(current.step) : ""} detail={view.detail} version={current?.version} agents={current?.agents} accept={view.accept} pinned={view.pinned} />
      {isLocalNetworkDenied(current) ? <LocalNetworkHelp /> : null}
      {err ? <DialogError>{err}</DialogError> : null}
      <DialogActions>
        <Button size="sm" label="Cancel" onPress={done} />
        <Button size="sm" label={busy ? "Working…" : "Test connection"} testID="servers-form-test" disabled={busy || !!problem} onPress={() => void runTest(f)} />
        {view.accept ? <Button size="sm" tone="primary" label="Accept fingerprint" testID="servers-form-accept" disabled={busy} onPress={() => accept(view.accept!)} /> : null}
        {view.saveAnyway ? <Button size="sm" label="Save anyway" disabled={busy} onPress={() => void save(true)} /> : null}
        <Button size="sm" tone="primary" label="Save" testID="servers-save" disabled={busy || !view.canSave} onPress={() => void save(!!view.force)} />
      </DialogActions>
    </View>
  );
}

