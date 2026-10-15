// The root of a self-test build (architecture AD-83): shown instead of the app when EXPO_PUBLIC_AIWB_SELFTEST=1 (App.tsx).
// One button per self-test; the Maestro flows (app/e2e/maestro) press one and wait for its verdict text. Every element a flow
// reads has a testID. The runner learns what each case did from the report URL it gave this build.
import { useCallback, useRef, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import AiwbNet from "../../modules/aiwb-net/src/AiwbNetModule.ts";
import { nativeConnector } from "../platform/net/nativeConnector.ts";
import { BoardSelfTest } from "./BoardSelfTest.tsx";
import { runConnSelfTest } from "./connSelfTest.ts";
import { KeysSelfTest } from "./KeysSelfTest.tsx";
import { SheetsSelfTest } from "./SheetsSelfTest.tsx";
import { runNetSelfTest, type NativeModuleLike } from "./netSelfTest.ts";
import { line, type Outcome, type Summary } from "./selftest.ts";
import { netSelfTestConfig, selfTestHosts, selfTestReportUrl } from "./selftestEnv.ts";

type Verdict = { name: string; summary: Summary; lines: string[] } | { name: string; error: string };

/** What became of the last post to the runner, shown on the screen (`selftest-report`): a post that fails must not fail a self-test, but it must be seen. */
let reportNote = "report: none";
let noteChanged: () => void = () => {};
const setNote = (n: string) => { reportNote = n; noteChanged(); };

/** Tells the runner (fire and forget). */
function report(kind: string, text: string) {
  const url = selfTestReportUrl();
  if (!url) { setNote("report: no url given"); return; }
  setNote(`report: sending to ${url}`);
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, text }) })
    .then((r) => setNote(`report: ${r.status}`))
    .catch((e) => setNote(`report to ${url} failed: ${e}`));
}

export function SelfTestRoot() {
  const [running, setRunning] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [keys, setKeys] = useState(false);
  const [sheets, setSheets] = useState(false); // the overlays on a phone with its keyboard (package P1)
  const [board, setBoard] = useState(false); // the board's page in the web view (AD-83 flow 2) has a screen of its own
  const busy = useRef(false);
  const [, redraw] = useState(0);
  noteChanged = () => redraw((n) => n + 1);

  const start = useCallback(async (name: string, go: (say: (o: Outcome) => void) => Promise<Summary & { outcomes: Outcome[] }>) => {
    if (busy.current) return;
    busy.current = true;
    setRunning(name);
    setVerdict(null);
    report("start", name);
    const say = (o: Outcome) => report("case", `${name}: ${line(o)}`);
    try {
      const r = await go(say);
      const lines = r.outcomes.filter((o) => o.status !== "pass").map(line);
      setVerdict({ name, summary: r, lines });
      report("verdict", `${name}: ${r.ok ? "ok" : "FAILED"} (${r.pass} passed, ${r.fail} failed, ${r.skip} skipped)`);
    } catch (e) {
      const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      setVerdict({ name, error });
      report("verdict", `${name}: FAILED to run: ${error}`);
    } finally {
      busy.current = false;
      setRunning(null);
    }
  }, []);

  const hosts = selfTestHosts();
  const net = (host: string) => () => start(`net ${host}`, async (say) => {
    const cfg = netSelfTestConfig(host);
    if (!cfg) throw new Error("this build was given no scratch server (EXPO_PUBLIC_AIWB_SELFTEST_PORT, _FINGERPRINT, _SECRET)");
    return runNetSelfTest(nativeConnector(AiwbNet), { ...cfg, probe: Platform.OS === "ios" }, say, AiwbNet as unknown as NativeModuleLike);
  });

  // The words a flow waits for: "<kind> self-test ok" (net: followed by the name the server was reached by).
  const headline = verdict === null ? (running ? `running ${running}` : "no self-test run yet")
    : "error" in verdict ? `${verdict.name.split(" ")[0]} self-test FAILED`
      : `${verdict.name.split(" ")[0]} self-test ${verdict.summary.ok ? "ok" : "FAILED"}${verdict.name.includes(" ") ? `: ${verdict.name.split(" ")[1]}` : ""}`;

  if (keys) return <KeysSelfTest />; // the hardware keyboard's screen (package N3): a device test sends keys and reads it
  if (sheets) return <SheetsSelfTest />;
  if (board) return <BoardSelfTest />;

  return (
    <View style={styles.root} testID="selftest-root">
      <Text style={styles.title}>Self-tests</Text>
      <Button id="selftest-conn" label="Run conn self-test" onPress={() => start("conn", runConnSelfTest)} />
      <Button id="selftest-net-ip" label={`Run net self-test (${hosts.ip})`} onPress={net(hosts.ip)} />
      <Button id="selftest-net-dotted" label={`Run net self-test (${hosts.dotted})`} onPress={net(hosts.dotted)} />
      <Button id="selftest-keys" label="Open the keys self-test" onPress={() => setKeys(true)} />
      <Button id="selftest-sheets" label="Open the sheets self-test" onPress={() => setSheets(true)} />
      <Button id="selftest-board" label="Open board self-test" onPress={() => setBoard(true)} />
      <Text style={styles.status} testID="selftest-status">{headline}</Text>
      <Text style={styles.line} testID="selftest-report">{reportNote}</Text>
      <ScrollView style={styles.detail} testID="selftest-detail">
        {verdict === null ? null : "error" in verdict
          ? <Text style={styles.line}>{verdict.error}</Text>
          : (
            <>
              <Text style={styles.line}>{`${verdict.summary.pass} passed, ${verdict.summary.fail} failed, ${verdict.summary.skip} skipped`}</Text>
              {verdict.lines.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
            </>
          )}
      </ScrollView>
    </View>
  );
}

function Button({ id, label, onPress }: { id: string; label: string; onPress(): void }) {
  return (
    <Pressable testID={id} accessibilityRole="button" onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 70, paddingHorizontal: 16, backgroundColor: "#ffffff" },
  title: { fontSize: 20, fontWeight: "600", marginBottom: 12 },
  button: { backgroundColor: "#6965db", borderRadius: 8, paddingVertical: 12, paddingHorizontal: 14, marginBottom: 10 },
  buttonText: { color: "#ffffff", fontSize: 15 },
  status: { fontSize: 18, fontWeight: "600", marginTop: 10, marginBottom: 6 },
  detail: { flex: 1 },
  line: { fontSize: 12, color: "#333333", marginBottom: 2 },
});
