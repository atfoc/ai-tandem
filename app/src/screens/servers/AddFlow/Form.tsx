// The P3 "New server" of the add flow (goal 3.8.3, mockups dl-04c to dl-04e): Check and test, then Trust and save, or the mismatch. One
// FormSheet whose body is the step: `check` (filled from a code or a paste), `paste` (the box a text goes into), `manual` (typed), `trust`
// (the test passed: its answer, the fingerprint, Trust and save) and `mismatch` (the certificate is not the code's: only Cancel). Save in the
// head is on only in `trust`. The secret lives in this component's state alone: it is never drawn (dots that do not count it), and it is gone when
// the flow closes.
//
// What is sent and the trust rules are the Servers dialog's: a test with the code's fingerprint as the pin (conn checks it in the handshake before
// hello, so a mismatch sends no secret), and "Trust and save" is `serversApi.add(form, false)`, which tests again before it saves.
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform, Pressable, StyleSheet, View } from "react-native";

import { serversApi } from "@aiwb/core/serversapi.ts";
import { answered } from "@aiwb/core/state/serversdialog.ts";
import { formError, type ServerForm, type TestResult } from "@aiwb/core/logic/servers.ts";

import { localNetwork, type LocalNetworkState } from "../../../platform/localnetwork";
import { FormSheet } from "../../../ui/FormSheet.tsx";
import { PHONE, TYPE } from "../../../ui/metrics.ts";
import { Switch } from "../../../ui/Switch.tsx";
import { Text } from "../../../ui/Text.tsx";
import { useTokens } from "../../../ui/theme.tsx";
import { showToast } from "../../../ui/Toast.tsx";
import { tid } from "../../../ui/tid.ts";
import { chooseAddress, isLocalNetworkDenied, isPaste, LOCAL_NETWORK_DENIED_HELP, read } from "../addcode.ts";
import { fpShort, hostOf, WORDS } from "../facts.ts";
import { AgentsCell } from "../facts/parts.tsx";
import { Fingerprint } from "../facts/Fingerprint.tsx";
import { S2_TID } from "../ids.ts";
import { closeAddServer } from "../open.ts";
import { said } from "../parts.tsx";
import { Block, Card, FactRow, FieldRow, Notice, PencilMark, PLAIN, Row, SECRET, TickTile } from "./parts.tsx";
import { failure, formToSave, formToTest, judge, reachedLine, type Step, type Verdict } from "./steps.ts";

/** What a code gave the flow: the addresses it names and the fingerprint it prints (never the secret: that is in the form). */
export type Code = { addresses: string[]; fingerprint?: string };
export type Start = { step: "check" | "paste" | "manual"; form: ServerForm; code: Code | null; note?: string };

export const EMPTY_FORM: ServerForm = { name: "", address: "", secret: "", selfSigned: false, pin: "" };

const DOTS = "●●●●●●●●●●●●";

export function AddForm({ start }: { start: Start }) {
  const t = useTokens();
  const [step, setStep] = useState<Step>(start.step);
  const [form, setForm] = useState<ServerForm>(start.form);
  const [code, setCode] = useState<Code | null>(start.code);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [note, setNote] = useState(start.note ?? "");
  const [net, setNet] = useState<LocalNetworkState>("unknown");
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  useEffect(() => { void localNetwork.state().then((s) => { if (live.current) setNet(s); }, () => {}); }, []);

  const set = (p: Partial<ServerForm>) => setForm((f) => ({ ...f, ...p }));
  const problem = formError(form);
  const fingerprint = code?.fingerprint;

  /** Takes a pasted text: the check step with the form filled, or the parser's words. */
  const take = (raw: string): void => {
    const r = read(form, raw);
    if (!r.ok) { setNote(r.message); return; }
    setForm(r.form);
    setCode({ addresses: r.addresses, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) });
    setText(""); setNote(""); setErr(""); setStep("check");
  };

  const test = async () => {
    if (busy || problem) return;
    Keyboard.dismiss();
    setBusy(true); setErr("");
    const sent = formToTest(form, fingerprint);
    const began = Date.now();
    try {
      const r = await serversApi.test(sent);
      if (!live.current) return;
      const took = Date.now() - began;
      const v = judge(r, fingerprint);
      setResult(r); setMs(took); setVerdict(v);
      if (v.kind === "trust") setStep("trust");
      else if (v.kind === "mismatch") setStep("mismatch");
      else setErr(v.text);
    } catch (e) { if (live.current) setErr(said(e)); } finally { if (live.current) setBusy(false); }
  };

  /** Trust and save: the same call the dialog's Save makes. A throw is shown by the sheet (Save in the head) or under the button. */
  const save = async (): Promise<void> => {
    if (verdict?.kind !== "trust") return;
    const sent = formToSave(form, verdict);
    const a = await serversApi.add(sent, false);
    answered(a?.server);
    if (!a?.saved) throw new Error(a?.result ? failure(a.result) : "The server was not saved.");
    showToast({ text: WORDS.added(a.server?.name ?? sent.name.trim()) });
  };
  const trust = async () => {
    if (busy) return;
    setBusy(true); setErr("");
    try { await save(); closeAddServer(); } catch (e) { if (live.current) { setErr(said(e)); setBusy(false); } }
  };

  const dirty = step !== "mismatch" && (!!form.secret || !!form.name || !!form.address || !!text);
  const canSave = step === "trust" && !busy;
  const asks = Platform.OS === "ios" && net !== "granted";
  const denied = isLocalNetworkDenied(result);

  return (
    <FormSheet open onClose={closeAddServer} title="New server" saveLabel="Save" canSave={canSave} dirty={dirty} onSave={save} testID={S2_TID.addFormSheet}>
      <View {...tid(S2_TID.addForm, { step })} style={styles.body}>
        {step === "check" ? (
          <>
            <Notice tone="ok" testID={S2_TID.addFilled}>{`✓ ${WORDS.filled}`}</Notice>
            <Card title="Server">
              <FieldRow {...PLAIN} caption="Name" field="name" value={form.name} maxLength={80} placeholder="Studio" returnKeyType="done" onChangeText={(name) => set({ name })}
                trailing={<PencilMark color={t.faint} />} />
              <FactRow caption="Address" text={form.address} />
              <FactRow caption="Secret" text={DOTS} mono={false} trailing={<Text size={TYPE.secondary} tone="muted">from the code</Text>} />
              {fingerprint ? <Row><Text size={TYPE.control} style={styles.grow}>Certificate</Text><Text size={TYPE.control} tone="muted">Self-signed</Text></Row> : null}
            </Card>
            {code && code.addresses.length > 1 ? (
              <Card title="The code has several addresses" footer="Use the one this phone can reach.">
                {code.addresses.map((a) => <AddressRow key={a} address={a} on={form.address === a} onPress={() => setForm(chooseAddress(form, a))} />)}
              </Card>
            ) : null}
            {asks ? <Notice tone="info" testID={S2_TID.addLocalNet} title={WORDS.localNetTitle}>{WORDS.localNetBody(form.name.trim() || "the server")}</Notice> : null}
            <TestButton busy={busy} off={!!problem} onPress={() => void test()} />
            {problem ? <Text {...tid(S2_TID.addError, { why: "form" })} size={TYPE.secondary} tone="danger" style={styles.words}>{problem}</Text> : null}
            <Failure err={err} denied={denied} />
            {fingerprint ? <Text size={TYPE.secondary} tone="muted" style={styles.words}>{WORDS.nothingSent}</Text> : null}
          </>
        ) : null}

        {step === "paste" ? (
          <>
            <Card title="Setup text" footer="Paste what setup-remote.sh printed on the server, or an address and the secret.">
              <FieldRow {...PLAIN} caption="Pasted text" field="code" value={text} multiline placeholder="Paste here"
                onChangeText={(next) => { const was = text; setText(next); setNote(""); if (isPaste(was, next)) take(next); }} />
            </Card>
            {note ? <Text {...tid(S2_TID.addNote, { ok: false })} accessibilityRole="alert" selectable size={TYPE.secondary + 1} tone="danger" style={styles.words}>{note}</Text> : null}
            <Block label="Use this text" tone="soft" testID={S2_TID.addRead} disabled={!text.trim()} onPress={() => take(text)} />
          </>
        ) : null}

        {step === "manual" ? (
          <>
            <Card title="Server">
              <FieldRow {...PLAIN} caption="Name" field="name" value={form.name} maxLength={80} placeholder="Studio" onChangeText={(name) => set({ name })} />
              <FieldRow {...PLAIN} caption="Address" field="address" value={form.address} placeholder="https://host:port" keyboardType="url" onChangeText={(address) => set({ address })} />
              <FieldRow {...SECRET} caption="Secret" field="secret" value={form.secret} onChangeText={(secret) => set({ secret })} />
              <Row>
                <Text size={TYPE.control} style={styles.grow}>Self-signed certificate</Text>
                <Switch size="touch" label="Self-signed certificate" testID={S2_TID.addSelfSigned} on={form.selfSigned} onChange={(selfSigned) => set({ selfSigned, pin: selfSigned ? form.pin : "" })} />
              </Row>
            </Card>
            {asks ? <Notice tone="info" testID={S2_TID.addLocalNet} title={WORDS.localNetTitle}>{WORDS.localNetBody(form.name.trim() || "the server")}</Notice> : null}
            <TestButton busy={busy} off={!!problem} onPress={() => void test()} />
            {problem && (form.name || form.address || form.secret) ? <Text {...tid(S2_TID.addError, { why: "form" })} size={TYPE.secondary} tone="danger" style={styles.words}>{problem}</Text> : null}
            <Failure err={err} denied={denied} />
          </>
        ) : null}

        {step === "trust" && verdict?.kind === "trust" ? (
          <>
            <Who name={form.name.trim()} address={form.address} />
            {verdict.tested && result ? (
              <Card title="Test">
                <Row>
                  <TickTile />
                  <View {...tid(S2_TID.addResult, { ok: true })} style={styles.words2}>
                    <Text size={TYPE.control}>Connected</Text>
                    <Text size={TYPE.secondary} tone="muted">{reachedLine(result, ms)}</Text>
                  </View>
                </Row>
                {result.agents?.length ? <AgentsCell agents={result.agents.map(String)} /> : null}
              </Card>
            ) : null}
            {verdict.tone !== "none" ? (
              <Card title="Certificate fingerprint" footer={WORDS.trustFoot(form.name.trim())}>
                <View style={styles.print}>
                  <Fingerprint value={verdict.fingerprint} tone={verdict.tone} testID={S2_TID.fpNow} label="Presented now" />
                  {verdict.tone === "ok"
                    ? <Text {...tid(S2_TID.addMatch, { match: "yes" })} size={TYPE.control} tone="ok">{`✓ ${WORDS.matches}`}</Text>
                    : <Text {...tid(S2_TID.addCompare)} size={TYPE.secondary + 1} tone="muted">Compare it with the Fingerprint line the server printed</Text>}
                </View>
              </Card>
            ) : null}
            <Failure err={err} denied={false} />
            <Block label={verdict.tone === "none" ? "Save server" : "Trust and save"} tone="primary" testID={S2_TID.addTrust} disabled={busy} onPress={() => void trust()} />
          </>
        ) : null}

        {step === "mismatch" && verdict?.kind === "mismatch" ? (
          <>
            <Who name={form.name.trim()} address={form.address} />
            <Card title="Certificate fingerprint">
              <View style={styles.print}>
                <Text size={TYPE.secondary} tone="muted">Presented now</Text>
                <Fingerprint value={verdict.presented} tone="bad" testID={S2_TID.fpNow} label="Presented now" />
                <Text size={TYPE.secondary} tone="muted" mono>{`In the code: ${fpShort(fingerprint)}`}</Text>
                <Text {...tid(S2_TID.addMatch, { match: "no" })} size={TYPE.control} tone="danger" weight="600">{`✗ ${WORDS.mismatch}`}</Text>
              </View>
            </Card>
            <Text selectable size={TYPE.secondary} tone="muted" style={styles.words}>{WORDS.mismatchWhy(hostOf(form.address), form.name.trim())}</Text>
            <View style={styles.gap}><Block label="Cancel" tone="grey" testID={S2_TID.addCancel} onPress={closeAddServer} /></View>
          </>
        ) : null}
      </View>
    </FormSheet>
  );
}

/** The name and the address, as the first cell of trust and mismatch. */
function Who({ name, address }: { name: string; address: string }) {
  return (
    <Card>
      <Row>
        <View style={styles.words2} accessible accessibilityLabel={`${name}, ${address}`}>
          <Text size={TYPE.control}>{name}</Text>
          <Text selectable size={TYPE.secondary} mono numberOfLines={2}>{address}</Text>
        </View>
      </Row>
    </Card>
  );
}

function AddressRow({ address, on, onPress }: { address: string; on: boolean; onPress(): void }) {
  const t = useTokens();
  return (
    <Pressable {...tid(S2_TID.addAddress, { address, on })} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={address} onPress={onPress}>
      <Row>
        <Text size={TYPE.secondary + 1} mono style={styles.words2}>{address}</Text>
        {on ? <Text size={TYPE.control} style={{ color: t.accent }}>✓</Text> : null}
      </Row>
    </Pressable>
  );
}

function TestButton({ busy, off, onPress }: { busy: boolean; off: boolean; onPress(): void }) {
  return <Block label={busy ? "Testing…" : "Test connection"} tone="soft" testID={S2_TID.addTest} disabled={busy || off} onPress={onPress} />;
}

/** What a test that did not pass says, red under the button; the local network's refusal says where to allow it. */
function Failure({ err, denied }: { err: string; denied: boolean }) {
  if (!err && !denied) return null;
  return (
    <View style={styles.gap}>
      {err ? <Text {...tid(S2_TID.addError, { why: "test" })} selectable accessibilityRole="alert" size={TYPE.secondary + 1} tone="danger" style={styles.words}>{err}</Text> : null}
      {denied ? (
        <>
          <Text selectable size={TYPE.secondary + 1} tone="muted" style={styles.words}>{LOCAL_NETWORK_DENIED_HELP}</Text>
          {localNetwork.canOpenSettings ? <Block label="Open Settings" tone="soft" testID={S2_TID.addSettings} onPress={() => void localNetwork.openSettings().catch(() => {})} /> : null}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingTop: 12, paddingBottom: 8 },
  grow: { flex: 1 },
  words: { marginHorizontal: PHONE.margin, marginBottom: 20 },
  words2: { flex: 1, minWidth: 0 },
  gap: { gap: 8 },
  print: { padding: PHONE.margin, gap: 12 },
});
