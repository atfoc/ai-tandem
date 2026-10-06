// What became of the run's result in the person's folder, as a card of the Result tab: applied,
// nothing to apply, ready to apply, or not applied and why, with the Apply button.
import { useEffect, useRef, useState } from "react";
import "./result.css";
import { api } from "../api.ts";
import { useStore } from "../store.ts";
import { deliveryCard, type SayPart } from "../logic/rundelivery.ts";
import type { RunDelivery, RunDetail } from "../types.ts";

/** A sentence, its folders, branches and commits as code. */
export const Say = ({ parts }: { parts: SayPart[] }) => <>{parts.map((p, i) => (typeof p === "string" ? p : <code key={i}>{p.code}</code>))}</>;

/** Whether a delivery waits for the person: what the folder would answer now may differ from it. */
const open = (d: RunDelivery | undefined): boolean => d?.state === "pending" || d?.state === "blocked";

export function Delivery({ runId, detail }: { runId: string; detail: RunDetail }) {
  const r = useStore((s) => s.runs[runId]);
  const home = useStore((s) => s.home);
  const recorded = detail.delivery;
  const live = detail.status === "running" || detail.status === "stopping";
  // What the server last answered (an apply, a dry run), shown in place of the record until the
  // record changes: the server sends an apply's outcome in a patch too.
  const [answer, setAnswer] = useState<{ of: RunDelivery | undefined; d: RunDelivery } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState(false);
  // An apply that left the result as it was: the state it answered again, said under the card for a while.
  const [still, setStill] = useState<RunDelivery["state"] | null>(null);
  const shown = answer && answer.of === recorded ? answer.d : recorded;
  const asked = useRef(0); // the latest call: an answer that is not its own is dropped
  const waits = !live && open(shown);
  const now = useRef({ recorded, busy });
  now.current = { recorded, busy };

  // While the result waits, the folder is asked what applying would do now: when the tab opens and
  // when the window gets the focus back (the person may have committed or switched branch).
  useEffect(() => {
    if (!waits) return;
    const ask = () => {
      if (now.current.busy) return;
      const mine = ++asked.current, of = now.current.recorded;
      api.runDelivery(runId).then((d) => { if (mine === asked.current && of === now.current.recorded) setAnswer({ of, d }); }, () => {}); // the record stays
    };
    ask();
    window.addEventListener("focus", ask);
    return () => { window.removeEventListener("focus", ask); asked.current++; };
  }, [runId, waits]);

  useEffect(() => {
    if (!still) return;
    const t = setTimeout(() => setStill(null), 60_000); // "just now" does not stay true
    return () => clearTimeout(t);
  }, [still]);

  const card = deliveryCard(shown, { cwd: r?.cwd ?? "", home, startBranch: detail.git?.branch, resultBranch: detail.git?.integrationBranch, settings: r?.settings, status: detail.status });
  if (!card) return null;
  const apply = () => {
    if (busy) return;
    const mine = ++asked.current, of = recorded, was = shown?.state;
    setBusy(true); setError(""); setStill(null);
    api.applyRun(runId, shown?.branch).then(
      (d) => {
        if (mine !== asked.current) return;
        setAnswer({ of: now.current.recorded === of ? of : now.current.recorded, d });
        if (d.state === was && open(d)) setStill(d.state);
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    ).finally(() => setBusy(false));
  };
  return (
    <>
    <div className="rd-deliver" data-tone={card.tone} data-delivery={card.state} data-reason={shown?.reason}>
      <span className="rd-deliver-mark" aria-hidden="true">{card.mark}</span>
      <div className="rd-deliver-main">
        <div className="rd-deliver-title">{card.title}</div>
        <div className="rd-deliver-say"><Say parts={card.sentence} /></div>
        {card.detail && <div className="rd-deliver-detail mono rd-wrap">{card.detail}</div>}
        {error && <div className="note error rd-deliver-error" role="alert">Could not apply: {error}</div>}
        {card.files && files && (
          <ul className="rd-deliver-files">
            {card.files.list.map((f) => <li key={f} className="mono rd-wrap">{f}</li>)}
            {card.files.more > 0 && <li className="more">and {card.files.more} more</li>}
          </ul>
        )}
      </div>
      {(card.files || card.action) && (
        <div className="rd-deliver-btns">
          {card.files && <button type="button" className="btn ghost sm" aria-expanded={files} onClick={() => setFiles(!files)}>{files ? "Hide" : "Show"} {card.files.label}</button>}
          {card.action && (
            <button type="button" className="btn primary sm rd-apply" disabled={!card.canApply || busy} aria-busy={busy || undefined} title={card.applyTitle} onClick={apply}>
              {busy && <span className="spin" />}{busy ? "Applying…" : "Apply to my folder"}
            </button>
          )}
        </div>
      )}
    </div>
    {still && still === card.state && !busy && (
      <div className="rd-deliver-still" role="status">{still === "blocked" ? "Still blocked" : "Not applied"} · checked just now</div>
    )}
    </>
  );
}
