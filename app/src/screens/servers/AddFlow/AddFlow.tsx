// The add flow on the phone (goal 3.8.3, mockups dl-04a … dl-04e): Choose how (P1), Scan the code (the camera), Check and test then
// Trust and save (one P3, "New server": Form.tsx), and the toast "Studio added · its chats are in your list". Mounted once in the shell's Overlays
// (index.ts) and opened by `openAddServer(how)` (open.ts); each opening starts anew (keyed by its count). Package S2.
//
// This file moves between the sheets: one is closed before the next opens (the iOS dismissal of a modal takes about 0.3 s, and two modals
// changing in one commit leave the page's accessibility tree empty), and leaving the flow drops everything it held, the secret among it.
import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";

import { readText } from "../../../platform/clipboard";
import { CodeScanner, canScan } from "../../../platform/scan";
import { read } from "../addcode.ts";
import { WORDS } from "../facts.ts";
import { closeAddServer, useAddFlow, type AddHow } from "../open.ts";
import { Choose, type Way } from "./Choose.tsx";
import { AddForm, EMPTY_FORM, type Start } from "./Form.tsx";

/** How long a sheet takes to be dismissed on iOS before the next may open. */
const DISMISS_MS = 400;

type Phase = "choose" | "help" | "scan" | "form" | "between";

export function AddFlowHost() {
  const flow = useAddFlow();
  return flow ? <AddFlow key={flow.n} how={flow.how} /> : null;
}

function AddFlow({ how }: { how: AddHow }) {
  const scanFirst = how === "scan" && canScan;
  const [phase, setPhase] = useState<Phase>(scanFirst ? "scan" : how === "choose" || how === "scan" ? "choose" : "between");
  const [start, setStart] = useState<Start | null>(how === "manual" ? { step: "manual", form: EMPTY_FORM, code: null } : null);
  const leaving = useRef(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);

  const go = (next: Phase) => {
    leaving.current = next !== "choose";
    if (Platform.OS !== "ios") { setPhase(next); return; }
    setPhase("between");
    setTimeout(() => { if (live.current) setPhase(next); }, DISMISS_MS);
  };
  const form = (s: Start) => { setStart(s); go("form"); };

  /** "Paste setup text" and a press that comes with one: the clipboard is read now, on the press. */
  const paste = async () => {
    let text = "";
    try { text = await readText(); } catch { /* the platform refused: the box is there to paste into */ }
    const r = text ? read(EMPTY_FORM, text) : null;
    if (r?.ok) form({ step: "check", form: r.form, code: { addresses: r.addresses, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) } });
    else form({ step: "paste", form: EMPTY_FORM, code: null, ...(r && !r.ok ? { note: r.message } : {}) });
  };
  useEffect(() => { if (how === "paste") void paste(); else if (how === "manual") go("form"); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const way = (w: Way) => {
    if (w === "scan") go("scan");
    else if (w === "manual") form({ step: "manual", form: EMPTY_FORM, code: null });
    else { leaving.current = true; void paste(); }
  };
  /** A text the camera read: the check step, or the parser's words on the camera. */
  const scanned = (text: string): string | null => {
    const r = read(EMPTY_FORM, text);
    if (!r.ok) return r.message;
    form({ step: "check", form: r.form, code: { addresses: r.addresses, ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}) } });
    return null;
  };
  const back = () => { if (scanFirst) closeAddServer(); else { leaving.current = false; go("choose"); } };

  return (
    <>
      {how === "choose" || how === "scan" ? (
        <Choose open={phase === "choose"} help={phase === "help"} onClose={() => { if (!leaving.current) closeAddServer(); }} onWay={way}
          onHelp={() => go("help")} onHelpClose={() => { leaving.current = false; go("choose"); }} />
      ) : null}
      {phase === "scan" ? <CodeScanner title={WORDS.scanTitle} hint={WORDS.scanHint} onText={scanned} onClose={back} onPaste={() => void paste()} /> : null}
      {phase === "form" && start ? <AddForm start={start} /> : null}
    </>
  );
}
