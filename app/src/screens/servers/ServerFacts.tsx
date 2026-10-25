// The one body of a server (decision D12, goal open question 8): its state, its facts, "Test connection" answering in place and
// "Remove server…", drawn by its detail screen (`place="screen"`, mockups dl-03b, dl-03d, dl-05b) and by the sheet of a chip's long press
// (`place="sheet"`, mockup sh2-13a). Package S2. The calls are today's row's: the test of the saved entry, the removal, and, for this
// computer's entry, the owner's things.
import { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { appCall } from "@aiwb/core/api.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";
import { entryRemoved } from "@aiwb/core/state/conn.ts";
import { heldResult, mcpLine, rowActions, type HeldResult, type ServerView } from "@aiwb/core/logic/servers.ts";
import { localExtra } from "@aiwb/core/logic/localsection.ts";
import { inDesktopApp, openServerLog, pageVersion, restartServer, startAgain } from "@aiwb/core/state/version.ts";

import { useStore } from "../../state/useStore.ts";
import { Cell } from "../../ui/Cells.tsx";
import { IconButton } from "../../ui/IconButton.tsx";
import { PHONE, TYPE } from "../../ui/metrics.ts";
import { StateWord, useServerWord, wordColour } from "../../ui/StateWord.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { TID, tid } from "../../ui/tid.ts";
import { showToast } from "../../ui/Toast.tsx";
import { DisclosureChevron } from "../../ui/icons.tsx";
import { copyText } from "../../platform/clipboard";
import { localNetwork } from "../../platform/localnetwork";
import { entriesNow } from "../shell/goback.ts";
import { goBack } from "../shell/BackButton.tsx";
import { confirm } from "../shell/nav.ts";
import { LOCAL_NETWORK_DENIED_HELP } from "./addcode.ts";
import { fpShort, removeWords, sinceLine, testLine, tileOf, tooOldText, whyOf, WORDS } from "./facts.ts";
import { AgentsCell, CopyMark, DangerCell, FactCell, Group, Note, Numbered, PrimaryButton, SoftButton, TestCell, TextCell, faint } from "./facts/parts.tsx";
import { S2_TID } from "./ids.ts";
import { ownerThings } from "./model.ts";
import { openServer, openServerCert, openServerEdit, SCREEN } from "./open.ts";
import { said, texts } from "./parts.tsx";
import { ServerTile, ShieldGlyph } from "./Tile.tsx";

export type ServerFactsProps = { id: string; place: "screen" | "sheet"; onLeave?(): void };

type Answer = { ok: boolean; text: string };

export function ServerFacts({ id, place, onLeave }: ServerFactsProps) {
  const v = useStore((s) => s.servers.find((x) => x.id === id));
  const gone = !v;
  const left = useRef(false);
  useEffect(() => {
    if (gone && !left.current) { left.current = true; onLeave?.(); }
  }, [gone, onLeave]);
  if (!v) return <Gone id={id} place={place} />;
  return <Body v={v} place={place} onLeave={onLeave} />;
}

/** An entry that was removed (here or by another window) while its screen or sheet was open. */
function Gone({ id, place }: { id: string; place: "screen" | "sheet" }) {
  return (
    <View {...tid(S2_TID.facts, { server: id, word: "gone", place })} style={styles.gone}>
      <Text size={TYPE.control} tone="muted" style={styles.centred}>This server is no longer in your list.</Text>
    </View>
  );
}

/** The state of the test: the answer with the state the entry had when it came (it goes once the entry is in another), how long the call
 *  took (measured here, since the answer has no time), and when it came. */
function useTest(v: ServerView) {
  const [held, setHeld] = useState<{ held: HeldResult; ms: number; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const state = useRef(v.state);
  state.current = v.state;
  const r = heldResult(held?.held ?? null, v.state);
  useEffect(() => { setHeld((h) => (heldResult(h?.held ?? null, v.state) ? h : null)); }, [v.state]);
  const run = async () => {
    setBusy(true); setErr("");
    const t0 = Date.now();
    try {
      const res = await serversApi.testSaved(v.id);
      setHeld(res ? { held: { result: res, state: state.current }, ms: Date.now() - t0, at: Date.now() } : null);
    } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  const answer: Answer | null = err ? { ok: false, text: err } : r && held ? testLine(r, held.ms) : null;
  return { r, busy, answer, run, checkedAt: r && held ? held.at : null };
}

/** The tick that keeps "Checked just now" honest while the screen stays open. */
function useNow(): number {
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(i); }, []);
  return Date.now();
}

/** The address as a row says it, without the scheme ("build-box.example:4790"). */
const hostPort = (address: string | undefined): string => (address ?? "").replace(/^[a-z]+:\/\//i, "").replace(/\/$/, "");

function Body({ v, place, onLeave }: { v: ServerView; place: "screen" | "sheet"; onLeave?(): void }) {
  const word = useServerWord(v);
  const since = useStore((s) => s.serverSince[v.id]);
  const now = useNow();
  const test = useTest(v);
  const acts = rowActions(v);
  const name = v.name;

  // Removing an entry takes it from this phone's list and tells that server nothing; a sheet leaves first (no sheet over a sheet).
  const remove = () => {
    if (place === "sheet") onLeave?.();
    const w = removeWords(name);
    confirm({
      title: w.title, body: w.body, confirmLabel: w.confirm,
      actions: [{
        label: w.confirm, tone: "danger",
        run: async () => {
          await serversApi.remove(v.id);
          entryRemoved(v.id);
          // the detail's screen goes with its entry, if it is still the one on top
          const top = entriesNow().at(-1);
          if (place === "screen" && top?.route === "pushed" && top.name === SCREEN.server) goBack();
        },
      }],
    });
  };

  const common = { v, word, test, now, since, acts, remove };
  return place === "sheet" ? <SheetBody {...common} onLeave={onLeave} /> : <ScreenBody {...common} />;
}

type Common = {
  v: ServerView; word: ReturnType<typeof useServerWord>; test: ReturnType<typeof useTest>; now: number; since: number | undefined;
  acts: ReturnType<typeof rowActions>; remove(): void;
};

// ── the detail screen ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ScreenBody({ v, word, test, now, since, acts, remove }: Common) {
  const t = useTokens();
  const name = v.name;
  const key = word.key;
  const local = !!v.local;
  const state = local ? "plain" : key === "cert-changed" ? "cert" : key === "unreachable" || key === "offline" ? "down" : key === "local-network-off" ? "net" : key === "too-old" ? "old" : "plain";
  // a changed certificate's word already says "paused", and the app does not know when it last answered: no second line (dl-05b)
  const line = state === "cert" ? "" : sinceLine(word, test.checkedAt, since, now);
  const canTest = acts.includes("test") && state !== "cert";
  const removable = acts.includes("remove");

  const testGroup = canTest ? (
    <Group footer={WORDS.testFoot}>
      <TestCell label="Test connection" busy={test.busy} answer={test.answer} onPress={() => void test.run()} testID={S2_TID.test} resultID={S2_TID.result} />
    </Group>
  ) : null;
  const again = canTest ? (
    <SoftButton label="Test again" busyLabel="Testing…" busy={test.busy} answer={test.answer} onPress={() => void test.run()} testID={S2_TID.test} resultID={S2_TID.result} />
  ) : null;
  const removeGroup = removable ? (
    <Group footer={WORDS.removeFoot(name)}>
      <DangerCell label="Remove server…" onPress={remove} testID={S2_TID.remove} />
    </Group>
  ) : null;
  const facts = <ServerGroup v={v} />;

  return (
    <ScrollView {...tid(S2_TID.facts, { server: v.id, word: key, place: "screen" })} style={[styles.page, { backgroundColor: t.panel }]} contentContainerStyle={styles.content}>
      <View {...tid(S2_TID.head)} style={styles.head}>
        <ServerTile kind={tileOf(word)} size={48} />
        <Text size={TYPE.h2} weight="600" style={styles.centred}>{name}</Text>
        <StateWord word={word} />
        {line ? <Text {...tid(S2_TID.since)} size={TYPE.secondary} tone="muted" style={styles.centred}>{line}</Text> : null}
      </View>

      {state === "down" ? <Down v={v} answer={test.r} /> : null}
      {state === "net" ? <LocalNetworkOff /> : null}
      {state === "old" ? <TooOld v={v} /> : null}
      {state === "cert" ? <CertChanged v={v} /> : null}

      {state === "down" || state === "net" || state === "old" ? again : null}
      {state === "down" && v.address ? <Note>Address <Text size={TYPE.secondary} tone="muted" mono selectable>{v.address}</Text></Note> : null}

      {state === "plain" || state === "old" ? facts : null}
      {state === "plain" ? testGroup : null}
      {local && ownerThings() ? <Owner v={v} /> : null}
      {removeGroup}
    </ScrollView>
  );
}

/** Group "Server": the address with its Copy, the version, the agents, the certificate (what is known; nothing is drawn for what is not). */
function ServerGroup({ v }: { v: ServerView }) {
  const t = useTokens();
  const agents = texts(v.agents);
  const cert = !!v.pin || !!v.selfSigned;
  const cells = [
    v.address ? (
      <FactCell key="address" caption="Address" text={v.address} testID={S2_TID.address}
        trailing={<CopyButton address={v.address} color={t.accent} />} />
    ) : null,
    v.version ? <Cell key="version" label="Version" value={v.version} testID={S2_TID.version} /> : null,
    agents.length > 0 ? <AgentsCell key="agents" agents={agents} testID={S2_TID.agents} /> : null,
    cert ? (
      <FactCell key="cert" caption={v.selfSigned ? "Certificate · self-signed" : "Certificate"} text={v.pin ? fpShort(v.pin) : undefined}
        onPress={() => openServerCert(v.id)} testID={S2_TID.certRow} chevron={<DisclosureChevron color={t.faint} />} />
    ) : null,
  ].filter(Boolean);
  if (cells.length === 0) return null;
  return <Group title="Server">{cells}</Group>;
}

/** The 44 pt Copy of the address: the address on the clipboard and a toast that says so. */
function CopyButton({ address, color }: { address: string; color: string }) {
  const copy = () => copyText(address).then(() => showToast({ text: "Address copied" }), () => showToast({ text: "Could not copy the address" }));
  return (
    <IconButton {...tid(S2_TID.copy)} size="touch" title="Copy address" accessibilityLabel="Copy address" onPress={() => void copy()}>
      {() => <CopyMark color={color} />}
    </IconButton>
  );
}

/** Unreachable (dl-03d): why in plain words, what to try, numbered. */
function Down({ v, answer }: { v: ServerView; answer: ReturnType<typeof useTest>["r"] }) {
  const why = whyOf(v, answer);
  return (
    <>
      <Group title="Why" testID={S2_TID.why}>
        <View style={styles.card}>
          <Text selectable size={TYPE.control}>{why.title}</Text>
          {why.body ? <Text selectable size={TYPE.secondary} tone="muted">{why.body}</Text> : null}
        </View>
      </Group>
      {why.tries.length > 0 ? (
        <Group title="What to try" testID={S2_TID.tries}>
          <View style={styles.tries}>{why.tries.map((s, i) => <Numbered key={i} n={i + 1}>{s}</Numbered>)}</View>
        </Group>
      ) : null}
    </>
  );
}

/** Local network off (iOS): the words and the one way on. */
function LocalNetworkOff() {
  return (
    <>
      <Group>
        <View style={styles.card}><Text selectable size={TYPE.control}>{LOCAL_NETWORK_DENIED_HELP}</Text></View>
      </Group>
      {localNetwork.canOpenSettings ? <PrimaryButton label="Open Settings" testID={S2_TID.openSettings} onPress={() => void localNetwork.openSettings().catch(() => {})} /> : null}
    </>
  );
}

/** Too old (amber): both versions and how to update. */
function TooOld({ v }: { v: ServerView }) {
  const text = tooOldText(v.name, v.version, pageVersion());
  return (
    <Group title="Update" testID={S2_TID.update}>
      <View style={styles.card}>
        <Text selectable size={TYPE.control}>{text.versions}</Text>
        <Text selectable size={TYPE.secondary} tone="muted">{text.how}</Text>
      </View>
    </Group>
  );
}

/** Certificate changed (dl-05b): the notice that names both readings, the one way forward, what "paused" means, the address. */
function CertChanged({ v }: { v: ServerView }) {
  const t = useTokens();
  const name = v.name;
  return (
    <>
      <View {...tid(S2_TID.certNotice)} accessibilityRole="alert" style={[styles.notice, { borderColor: t.danger, backgroundColor: t.dangerSoft }]}>
        <Text selectable size={TYPE.body} weight="600" tone="danger">{"⛨ "}{WORDS.certTitle}</Text>
        <Text selectable size={TYPE.busy}>{WORDS.certBody(name)}</Text>
        <Bullet>{WORDS.certRenewed}</Bullet>
        <Bullet>{WORDS.certPosing(name)}</Bullet>
      </View>
      <Group>
        <Cell label="Compare fingerprints" sub={WORDS.compareSub} testID={S2_TID.compare} onPress={() => openServerCert(v.id)}
          leading={<View style={[styles.shield, { borderColor: t.accent }]}><ShieldGlyph size={18} color={t.accent} /></View>} />
      </Group>
      <Note>{WORDS.certPaused(name)}</Note>
      <Group>
        {v.address ? <FactCell caption="Address" text={v.address} testID={S2_TID.address} /> : null}
      </Group>
    </>
  );
}

const Bullet = ({ children }: { children: string }) => (
  <View style={styles.bullet}>
    <Text size={TYPE.busy}>•</Text>
    <Text selectable size={TYPE.busy} style={styles.flex}>{children}</Text>
  </View>
);

/** This computer's things (the desktop app's and the test host's, which run a server of their own): what its section says of a start
 *  that failed or a restart, the state of its MCP listener, and the buttons of today's row. */
function Owner({ v }: { v: ServerView }) {
  const restart = useStore((s) => s.restart);
  const [mcp, setMcp] = useState("");
  useEffect(() => {
    let live = true;
    appCall("owner.status").then((r) => { if (live) setMcp(mcpLine(r)); }, () => { if (live) setMcp(""); });
    return () => { live = false; };
  }, []);
  const x = localExtra(v, restart, pageVersion(), inDesktopApp());
  return (
    <Group testID={S2_TID.owner} title="This computer">
      {x.line ? <TextCell testID="servers-owner-line" size={TYPE.body} tone="text">{x.line}</TextCell> : null}
      {x.reason ? <TextCell testID="servers-reason" mono>{x.reason}</TextCell> : null}
      {mcp ? <TextCell testID="servers-mcp">{mcp}</TextCell> : null}
      <Cell label="Restart server" tone="accent" disabled={restart.phase === "restarting"} onPress={restartServer} chevron={false} testID="servers-restart" />
      {x.again === "start" ? <Cell label="Retry" tone="accent" onPress={startAgain} chevron={false} testID="servers-retry" /> : null}
      {inDesktopApp() ? <Cell label="Open server log" tone="accent" onPress={openServerLog} chevron={false} testID="servers-log" /> : null}
    </Group>
  );
}

// ── the chip's sheet ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

function SheetBody({ v, word, test, acts, remove, onLeave }: Common & { onLeave?(): void }) {
  const t = useTokens();
  const key = word.key;
  const leave = (then: () => void) => () => { onLeave?.(); then(); };
  const canTest = acts.includes("test") && key !== "cert-changed";
  const detail = hostPort(v.address);
  return (
    <View {...tid(S2_TID.facts, { server: v.id, word: key, place: "sheet" })} style={styles.sheet}>
      <View {...tid(TID.sheetHead)} style={styles.sheetHead}>
        <ServerTile kind={tileOf(word)} size={36} />
        <View style={styles.flex}>
          <Text {...tid(TID.sheetTitle)} size={TYPE.h2} weight="600" accessibilityRole="header">{v.name}</Text>
          <View style={styles.wordLine}>
            <StateWord word={word} />
            {v.version ? <Text size={TYPE.secondary} style={{ color: wordColour(t, word.tone) }}>{`· version ${v.version}`}</Text> : null}
          </View>
          {detail ? <Text selectable size={TYPE.secondary} tone="muted" mono>{detail}</Text> : null}
        </View>
      </View>
      <Rule />
      {canTest ? (
        <>
          <Pressable {...tid(S2_TID.test)} disabled={test.busy} onPress={() => void test.run()} accessibilityRole="button" accessibilityLabel={test.busy ? "Testing" : "Test connection"}
            accessibilityState={{ disabled: test.busy }} style={[styles.sheetRow, test.busy && { opacity: 0.5 }]}>
            <Text size={TYPE.control} tone={test.busy ? "muted" : "accent"}>{test.busy ? "Testing…" : "Test connection"}</Text>
          </Pressable>
          {!test.busy && test.answer ? (
            <View {...tid(S2_TID.result, { ok: test.answer.ok })} accessibilityRole="alert"
              style={[styles.result, { backgroundColor: faint(test.answer.ok ? t.ok : t.danger), borderColor: test.answer.ok ? t.ok : t.danger }]}>
              <Text selectable size={TYPE.secondary} tone={test.answer.ok ? "ok" : "danger"}>{test.answer.text}</Text>
            </View>
          ) : null}
          <Rule />
        </>
      ) : null}
      {!v.local ? <SheetRow row="name" label="Name" value={v.name} onPress={leave(() => openServerEdit(v.id))} /> : null}
      {v.pin ? <SheetRow row="cert" label="Certificate" value={`SHA-256 ${v.pin.split(":").slice(0, 2).join(":")}…`} onPress={leave(() => openServerCert(v.id))} /> : null}
      <SheetRow row="settings" label="Server settings" onPress={leave(() => openServer(v.id))} />
      {acts.includes("remove") ? (
        <>
          <View style={styles.gap} />
          <Pressable {...tid(S2_TID.remove)} onPress={remove} accessibilityRole="button" accessibilityLabel="Remove server" style={styles.sheetRow}>
            <Text size={TYPE.control} tone="danger">Remove server</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

function Rule() {
  const t = useTokens();
  return <View style={[styles.rule, { backgroundColor: t.line }]} />;
}

/** A row of the sheet: its words, its value at the right, a chevron; a hairline under it. */
function SheetRow({ row, label, value, onPress }: { row: string; label: string; value?: string; onPress(): void }) {
  const t = useTokens();
  return (
    <>
      <Pressable {...tid(S2_TID.sheetRow, { row })} onPress={onPress} accessibilityRole="button" accessibilityLabel={[label, value].filter(Boolean).join(", ")}
        style={({ pressed }: { pressed: boolean }) => [styles.sheetRow, pressed && { backgroundColor: t.hover2 }]}>
        <Text size={TYPE.control} style={styles.flex}>{label}</Text>
        {value ? <Text size={TYPE.control} tone="muted" numberOfLines={1} style={styles.value}>{value}</Text> : null}
        <DisclosureChevron color={t.faint} />
      </Pressable>
      <Rule />
    </>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { paddingTop: 12, paddingBottom: 40 },
  head: { alignItems: "center", gap: 6, paddingHorizontal: PHONE.margin, paddingBottom: 22 },
  centred: { textAlign: "center" },
  flex: { flex: 1, minWidth: 0 },
  gone: { padding: 24 },
  card: { paddingHorizontal: PHONE.margin, paddingVertical: 12, gap: 4 },
  tries: { paddingVertical: 8 },
  notice: { marginHorizontal: PHONE.margin, marginBottom: 14, padding: 12, gap: 6, borderWidth: 1, borderRadius: 8 },
  bullet: { flexDirection: "row", gap: 8, paddingLeft: 2 },
  shield: { width: 36, height: 36, borderWidth: 1.5, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  sheet: { paddingBottom: 8 },
  sheetHead: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: PHONE.margin, paddingVertical: 12 },
  wordLine: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" },
  sheetRow: { minHeight: PHONE.sheetRow, flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: PHONE.margin },
  value: { flexShrink: 1, maxWidth: "55%" },
  rule: { height: StyleSheet.hairlineWidth, marginLeft: PHONE.margin },
  result: { marginHorizontal: PHONE.margin, marginBottom: 10, paddingVertical: 8, paddingHorizontal: 10, borderWidth: 1, borderRadius: 6 },
  gap: { height: 16 },
});
