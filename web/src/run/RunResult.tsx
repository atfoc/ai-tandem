// How the run ended, in the dock: the outcome, the orchestrator's summary for the user, and what
// became of the result in the person's folder (Delivery.tsx), with the way to take it by hand.
import "./dock.css";
import "./detail.css";
import { useStore } from "../store.ts";
import { Markdown } from "../Markdown.tsx";
import { fmtDuration } from "../logic/subagents.ts";
import { runTaskTotal } from "../logic/run.ts";
import { dateTime } from "../logic/runlabels.ts";
import { whenText } from "../logic/runview.ts";
import { deliveryCard } from "../logic/rundelivery.ts";
import { CopyCmd, DirtyNote, cost, useDockTop } from "./bits.tsx";
import { Delivery } from "./Delivery.tsx";
import type { RunDetail } from "../types.ts";

export interface RunResultProps { runId: string; detail: RunDetail; /** The turn that finished the run was asked for. */ onSelectTurn?(n: number): void }

/** The branch the result is on and the command that takes it, closed under "Do it by hand". Only
 *  for a run that used git and merged something, and whose result is not applied: the card says the rest. */
function ByHand({ detail, open }: { detail: RunDetail; open: boolean }) {
  const git = detail.git;
  const merged = detail.tasks.some((t) => t.attempts.some((a) => a.merged || a.mergedAt != null)) || (!!git?.resultHead && git.resultHead !== git.baseRef);
  // an applied result is in the folder, and the server has deleted the branch: there is nothing to do by hand
  if (!git || !merged || detail.delivery?.state === "applied") return null;
  return (
    <details className="rd-take rd-byhand" open={open || undefined}>
      <summary>Do it by hand</summary>
      <DirtyNote git={git} />
      <div className="rd-take-line">
        Everything the tasks changed is merged into the branch <span className="mono rd-wrap rd-branch">{git.integrationBranch}</span>
        {git.resultHead ? <> (at <span className="mono" title={git.resultHead}>{git.resultHead.slice(0, 7)}</span>)</> : null}: that branch is the run's result. To take it into the branch you are on:
      </div>
      <CopyCmd text={`git merge ${git.integrationBranch}`} />
    </details>
  );
}

export function RunResult({ runId, detail, onSelectTurn }: RunResultProps) {
  const r = useStore((s) => s.runs[runId]);
  const res = detail.result;
  const top = useDockTop();
  // The card says where the result is; the block under the summary opens when the card points at it.
  const card = deliveryCard(detail.delivery, { cwd: r?.cwd ?? "", status: detail.status });
  const byHand = !!card?.byHand;
  if (!res) return (
    <div className="run-result" ref={top}>
      {!card && <div className="note rd-nothing">The run has no result yet.</div>}
      <Delivery key={runId} runId={runId} detail={detail} />
      <ByHand detail={detail} open={byHand} />
    </div>
  );
  const ok = res.outcome === "achieved", n = r ? runTaskTotal(r) : detail.tasks.length;
  return (
    <div className="run-result" ref={top} data-outcome={res.outcome}>
      <div className="rd-head">
        <span className={`rd-mark tone-${ok ? "ok" : "muted"}`}>{ok ? "✓" : "✕"}</span>
        <span className="rd-title">{ok ? "Achieved" : "Not achieved"}</span>
      </div>
      <div className="rd-sub">
        {onSelectTurn && detail.turns.some((t) => t.n === res.turn)
          ? <button type="button" className="link lk" data-turn={res.turn} title="The turn that finished the run" onClick={() => onSelectTurn(res.turn)}>turn {res.turn}</button>
          : <>turn {res.turn}</>} · <span title={dateTime(res.at)}>{whenText(res.at, Date.now())}</span>
        {r ? <> · <span title="Working time, stops left out">{fmtDuration(r.activeMs)}</span>{r.cost != null && <> · <span className="rd-cost" title={r.costPartial ? "Some agents reported no cost" : undefined}>{cost(r.cost)}{r.costPartial ? "+" : ""}</span></>}</> : null}
        {" · "}{n} task{n === 1 ? "" : "s"}
      </div>
      <Delivery key={runId} runId={runId} detail={detail} />
      <div className="rd-md rd-text"><Markdown text={res.summary} agent={r?.agent} /></div>
      <ByHand detail={detail} open={byHand} />
    </div>
  );
}
