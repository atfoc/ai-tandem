// The board's page in the web view, on the device (architecture AD-83 flow 2, flow board-webview). Opened from the self-test root
// (`selftest-board`). It mounts the real host (`platform/board`: react-native-webview with the real `board.html` the build shipped),
// runs the cases of boardSelfTest.ts over its channel, and says the verdict as "board self-test ok" / "board self-test FAILED". Then it
// loads an empty board for the flow's fingers: a swipe draws a stroke and the text tool types, and what the page tells (the deltas
// of `changed`) is counted on the screen, `boardtest-touch`: "touch strokes: N; texts: [...]". The runner reads the memory of the
// processes at the phases the cases announce (report kind "memory").
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";

import type { FromView } from "@aiwb/core/board/channel.ts";

import { BoardHost, type HostChannel } from "../platform/board";
import { Listener, runBoardSelfTest, TouchWatch } from "./boardSelfTest.ts";
import { emptyScene } from "./boardfixtures.ts";
import { line, type Outcome } from "./selftest.ts";
import { resolvePage } from "../platform/boardpage.native.ts";
import { selfTestReportUrl } from "./selftestEnv.ts";

/** How long the app waits after announcing a memory phase: the runner reads the processes' memory after a pause of its own. */
export const MEMORY_PAUSE = 4500;

/** Tells the runner (fire and forget; no url: nobody to tell). */
function report(kind: string, text: string) {
  const url = selfTestReportUrl();
  if (!url) return;
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, text }) }).catch(() => {});
}

type Verdict = "running" | "ok" | "FAILED";

export function BoardSelfTest() {
  const [channel, setChannel] = useState<HostChannel | null>(null);
  const [verdict, setVerdict] = useState<Verdict>("running");
  const [lines, setLines] = useState<string[]>([]);
  const [touch, setTouch] = useState("touch: not yet");
  const started = useRef(false);

  const onChannel = useCallback((c: HostChannel | null) => { if (c) setChannel(c); }, []);

  useEffect(() => {
    if (!channel || started.current) return;
    started.current = true;
    report("start", "board");
    // where the page is in this build (what the device log and the report show: the way Android finds it is the point of the flow)
    resolvePage().then((p) => { console.log(`[aiwb-page] ${p.uri}`); report("page", p.uri); }, (e) => { console.log(`[aiwb-page] failed: ${e?.message ?? e}`); report("page", `failed: ${e?.message ?? e}`); });
    const say = (o: Outcome) => { report("case", `board: ${line(o)}`); if (o.status !== "pass" || o.detail) setLines((l) => [...l, line(o)]); };
    const env = {
      channel,
      phase: async (name: string) => { console.log(`[aiwb-phase] ${name}`); report("memory", name); await new Promise((r) => setTimeout(r, MEMORY_PAUSE)); },
    };
    (async () => {
      let ok = false;
      try {
        const r = await runBoardSelfTest(env, say);
        ok = r.ok;
        report("verdict", `board: ${r.ok ? "ok" : "FAILED"} (${r.pass} passed, ${r.fail} failed, ${r.skip} skipped)`);
        setLines((l) => [...l, `${r.pass} passed, ${r.fail} failed, ${r.skip} skipped`]);
      } catch (e) {
        const error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        report("verdict", `board: FAILED to run: ${error}`);
        setLines((l) => [...l, error]);
      }
      setVerdict(ok ? "ok" : "FAILED");
      if (!ok) return;
      // The flow's turn: an empty board that takes fingers. What the page tells of it is counted here.
      const board = "touch-board";
      const watch = new TouchWatch(board);
      const listener = new Listener(channel);
      let last = "";
      channel.on((m: FromView) => {
        if (watch.feed(m)) {
          const l = watch.line();
          if (l !== last) { last = l; setTouch(l); report("touch", l); }
        }
      });
      channel.send({ t: "load", board, scene: emptyScene(), viewMode: false, theme: { mode: "light", filter: null }, style: {} });
      await listener.until((m): m is Extract<FromView, { t: "loaded" }> => m.t === "loaded" && m.board === board, "loaded touch-board", 0, 60_000).catch(() => {});
      listener.stop();
      setTouch(watch.line());
    })();
  }, [channel]);

  return (
    <View style={styles.root} testID="boardtest-root">
      <Text style={styles.status} testID="boardtest-status">{verdict === "running" ? "board self-test running" : `board self-test ${verdict}`}</Text>
      <Text style={styles.line} testID="boardtest-touch">{touch}</Text>
      <ScrollView style={styles.detail} testID="boardtest-detail">
        {lines.map((l, i) => <Text key={i} style={styles.line}>{l}</Text>)}
      </ScrollView>
      <View style={styles.board} testID="boardtest-board"><BoardHost onChannel={onChannel} /></View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingTop: 54, backgroundColor: "#ffffff" },
  status: { fontSize: 16, fontWeight: "600", paddingHorizontal: 12 },
  line: { fontSize: 11, color: "#333333", paddingHorizontal: 12 },
  detail: { maxHeight: 64, flexGrow: 0 },
  board: { flex: 1 },
});
