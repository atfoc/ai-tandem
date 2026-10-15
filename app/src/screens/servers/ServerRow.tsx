// One entry of the Servers dialog (the old page's Servers.tsx `ServerRow` and `LocalRow`): its name and state, its address, detail, version and
// agents, and the buttons of rowActions; a test's answer under them, each fact once. This computer's row (where the transport offers the
// owner's things) has the owner's things instead of those buttons.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { entryRemoved } from "@aiwb/core/state/conn.ts";
import { answered } from "@aiwb/core/state/serversdialog.ts";
import { serversApi } from "@aiwb/core/serversapi.ts";
import { heldResult, removeText, resultHeading, rowActions, rowResult, stateLabel, type HeldResult, type ServerView } from "@aiwb/core/logic/servers.ts";
import { localExtra } from "@aiwb/core/logic/localsection.ts";
import { inDesktopApp, openServerLog, pageVersion, restartServer, startAgain } from "@aiwb/core/state/version.ts";

import { useStore } from "../../state/useStore.ts";
import { Button } from "../../ui/Button.tsx";
import { DialogError } from "../../ui/Dialog.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTheme } from "../../ui/theme.tsx";
import { tid } from "../../ui/tid.ts";
import { MONO } from "../../ui/fonts.ts";
import { confirm } from "../shell/nav.ts";
import { LocalNetworkHelp } from "./AddByCode.tsx";
import { isLocalNetworkDenied } from "./addcode.ts";
import { toneOf } from "./model.ts";
import { FpLine, Line, Result, said, texts } from "./parts.tsx";

/** The owner's things of this computer's row: what its section says of a start that failed or a restart (logic/localsection.ts), the
 *  state of its MCP listener, and the buttons. "Restart server" is always offered; "Retry" after a start that failed. */
function LocalRow({ v, mcp }: { v: ServerView; mcp: string }) {
  const { tokens: t } = useTheme();
  const restart = useStore((s) => s.restart);
  const x = localExtra(v, restart, pageVersion(), inDesktopApp());
  return (
    <>
      {x.line ? <Line testID="servers-owner-line">{x.line}</Line> : null}
      {x.reason ? <Text {...tid("servers-reason")} selectable size={11} mono style={[styles.reason, { color: t.muted, backgroundColor: t.bg, borderColor: t.line, fontFamily: MONO }]}>{x.reason}</Text> : null}
      {mcp ? <Line testID="servers-mcp">{mcp}</Line> : null}
      <View style={styles.actions}>
        <Button size="sm" label="Restart server" disabled={restart.phase === "restarting"} onPress={restartServer} />
        {x.again === "start" ? <Button size="sm" tone="primary" label="Retry" onPress={startAgain} /> : null}
        {inDesktopApp() ? <Button size="sm" label="Open server log" onPress={openServerLog} /> : null}
      </View>
    </>
  );
}

/** One entry. mcp = the line on this computer's MCP listener (its row only). owner = the owner's things are offered (its row). */
export function ServerRow({ v, onEdit, mcp = "", owner = false }: { v: ServerView; onEdit?: (v: ServerView) => void; mcp?: string; owner?: boolean }) {
  const { tokens: t } = useTheme();
  // The answer is kept with the state the entry had when it came, and dropped once the entry is in another.
  const [held, setHeld] = useState<HeldResult | null>(null);
  const state = useRef(v.state);
  state.current = v.state;
  const r = heldResult(held, v.state);
  useEffect(() => { setHeld((h) => (heldResult(h, v.state) ? h : null)); }, [v.state]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const acts = rowActions(v);
  const attempt = async (f: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await f(); } catch (e) { setErr(said(e)); } finally { setBusy(false); }
  };
  // A test of the entry as saved; the app reads the certificate before it sends anything.
  const test = () => attempt(async () => { const res = await serversApi.testSaved(v.id); setHeld(res ? { result: res, state: state.current } : null); });
  const accept = (fingerprint: string) => attempt(async () => {
    const a = await serversApi.accept(v.id, fingerprint);
    setHeld(null);
    answered(a?.server);
  });
  // Removing an entry takes its section away and tells that server nothing: the question says so, and counts nothing.
  // What is open of that server is closed with it, by the answer or by the `servers` event, whichever is here first.
  const remove = () => confirm({
    title: "Remove server", body: removeText(v.name),
    actions: [{ label: "Remove", tone: "danger", run: async () => { await serversApi.remove(v.id); entryRemoved(v.id); } }],
  });
  const tone = toneOf(v.state);
  const agents = texts(v.agents);
  // What the test's answer adds to the row's own lines: each fact is shown once.
  const shown = rowResult(v, r);
  const fp = shown.accept ?? "";
  return (
    <View {...tid("servers-row", { server: v.id, state: v.state })} style={[styles.row, { borderColor: t.line }]}>
      <View style={styles.head}>
        <Text {...tid("servers-name")} weight="600" numberOfLines={1} style={styles.name}>{v.name}</Text>
        <View style={styles.stateBox}>
          <View style={[styles.dot, { backgroundColor: tone === "ok" ? t.ok : tone === "bad" ? t.danger : t.faint }]} />
          <Text {...tid("servers-state", { tone, server: v.id })} size={12} tone={tone === "bad" ? "danger" : "muted"}>{stateLabel(v.state)}</Text>
        </View>
      </View>
      {v.address ? <Line testID="servers-addr" mono>{v.address}</Line> : null}
      {v.detail && !v.local ? <Line>{v.detail}</Line> : null}
      {v.version ? <Line>Version {v.version}</Line> : null}
      {agents.length > 0 ? <Line>Agents: {agents.join(", ")}</Line> : null}
      {!shown.ownCert ? null : v.state === "certificate_changed" ? (
        <>
          {v.pin ? <FpLine label="Accepted before" fp={v.pin} /> : null}
          {v.fingerprint ? <FpLine label="Presented now" fp={v.fingerprint} /> : null}
        </>
      ) : v.pin ? <FpLine label="Fingerprint" fp={v.pin} /> : null}
      {!v.local && v.state === "unreachable" && (isLocalNetworkDenied(v) || isLocalNetworkDenied(r)) ? <LocalNetworkHelp /> : null}
      {r ? <Result ok={r.ok} message={resultHeading(shown, r.ok)} step={shown.step} detail={shown.detail} version={shown.version} agents={shown.agents} accept={fp} pinned={shown.pinned} /> : null}
      {err ? <DialogError>{err}</DialogError> : null}
      {v.local && owner ? <LocalRow v={v} mcp={mcp} /> : null}
      {acts.length > 0 || fp ? (
        <View style={styles.actions}>
          {fp ? <Button size="sm" tone="primary" disabled={busy} label="Accept fingerprint" testID="servers-accept" onPress={() => void accept(fp)} />
            : acts.includes("accept") && v.fingerprint ? <Button size="sm" tone="primary" disabled={busy} label="Accept fingerprint" testID="servers-accept" onPress={() => void accept(v.fingerprint!)} />
            : acts.includes("showFingerprint") ? <Button size="sm" tone="primary" disabled={busy} label="Show fingerprint" testID="servers-show-fp" onPress={() => void test()} /> : null}
          {acts.includes("test") ? <Button size="sm" disabled={busy} label="Test connection" testID="servers-test" onPress={() => void test()} /> : null}
          {acts.includes("edit") ? <Button size="sm" disabled={busy} label="Edit" testID="servers-edit" onPress={() => onEdit?.(v)} /> : null}
          {acts.includes("remove") ? <Button size="sm" disabled={busy} label="Remove" testID="servers-remove" onPress={remove} /> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  head: { flexDirection: "row", alignItems: "baseline", gap: 8 },
  name: { flex: 1, minWidth: 0 },
  stateBox: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  dot: { width: 7, height: 7, borderRadius: 4, marginRight: 5 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  reason: { marginTop: 4, maxHeight: 200, paddingVertical: 5, paddingHorizontal: 7, borderWidth: 1, borderRadius: 6, lineHeight: 15 },
});
