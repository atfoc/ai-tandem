// The line between the run's meters and its timeline: how the run ended, or why it is halted.
// While the run is live there is none (the timeline's orchestrator lane and the rows' own tails say
// what is happening now), except while the connection to the server is down.
import "./run.css";
import "./result.css";
import { fmtDuration } from "../logic/subagents.ts";
import { runTaskTotal, runWord } from "../logic/run.ts";
import { clockTime, dateTime } from "../logic/runlabels.ts";
import { interrupted } from "../logic/runfeed.ts";
import { money, stalledWords, whenText } from "../logic/runview.ts";
import { sentence } from "../logic/rungoal.ts";
import { deliveryWords } from "../logic/rundelivery.ts";
import type { RunDetail, RunView } from "../types.ts";

export interface RunNowProps {
  run: RunView;
  detail: RunDetail;
  /** The moment the connection to the server was lost; null while it is up. */
  asOf?: number | null;
  /** "Result ›" of an ended run, and "Apply…" of a result that is not applied: opens the Result tab. */
  onResult(): void;
}

/** What became of the result, after the line's facts: "applied to main", or "not applied" with
 *  "Apply…", which opens the Result tab (the delivery card and its Apply button): it applies nothing.
 *  The words and the button stay on one line. An archived run has no button: the server applies
 *  nothing for it until it is unarchived. */
function Applied({ words: w, archived, onResult }: { words: ReturnType<typeof deliveryWords>; archived: boolean; onResult(): void }) {
  if (!w) return null;
  if (w.applied) return <> · <span className="run-applied" data-applied="true">{w.text}{w.branch ? <> <code>{w.branch}</code></> : null}</span></>;
  return (
    <> · <span className="run-applied" data-applied="false"><b>{w.text}</b>
      {!archived && <button type="button" className="btn sm run-banner-apply" title="Open the result: why it is not applied, and Apply" onClick={onResult}>Apply…</button>}
    </span></>
  );
}

export function RunNow({ run: r, detail: d, asOf = null, onResult }: RunNowProps) {
  if (r.status === "running" || r.status === "stopping") {
    if (asOf == null) return null;
    return <div className="run-now offline"><span className="tool-sub run-offline" role="status" title={dateTime(asOf)}>Reconnecting… · as of {clockTime(asOf)}</span></div>;
  }
  const words = deliveryWords(d.delivery);
  const stop = d.stops.findLast((s) => s.resumedAt == null);
  if (r.status === "completed" || r.status === "gave_up") {
    const res = d.result, at = res?.at ?? d.endedAt, n = runTaskTotal(r);
    return (
      <div className="run-now">
        <span className={`run-banner st-${r.status}`}>
          <span className="g">{r.status === "completed" ? "✓" : "✕"}</span>
          <span className="say">
            <b>{r.status === "completed" ? "Goal achieved" : "Gave up: goal not achieved"}</b>
            {res ? ` in turn ${res.turn}` : ""}
            {at != null && <span title={dateTime(at)}> · {whenText(at, Date.now())}</span>}
            {` · ${fmtDuration(r.activeMs)}`}
            {r.cost != null ? ` · ${money(r.cost)}${r.costPartial ? "+" : ""}` : ""}
            {` · ${n} task${n === 1 ? "" : "s"}`}
            <Applied words={words} archived={!!r.archived} onResult={onResult} />
          </span>
          {res && <button type="button" className="link run-banner-link" onClick={onResult}>Result ›</button>}
        </span>
      </div>
    );
  }
  // stopped, stalled, error
  const left = interrupted(d);
  const head = r.status === "stopped" ? "Stopped" : r.status === "stalled" ? "Stalled" : r.status === "error" ? "Error" : runWord(r);
  // A run the user stopped says so; any other stop shows the server's sentence (after a crash: what
  // happened and what to do), and without one what kind of stop it was.
  const by = stop?.reason === "user" ? "by you" : "";
  const quit = !r.reason && stop?.reason === "app_quit" ? "the app quit" : "";
  // A stalled run says which limit: in the server's sentence, and without one in words.
  const why = r.status === "stopped" ? by || quit : r.status === "stalled" && !r.reason ? `reached ${stalledWords(r)}` : "";
  const reason = r.status === "stopped" && by ? "" : r.reason;
  return (
    <div className="run-now">
      <span className={`run-banner st-${r.status}`}>
        <span className={r.status === "stopped" ? "g sq" : "g"}>{r.status === "stopped" ? "■" : "!"}</span>
        <span className="say">
          <b>{head}</b>
          {stop && <span title={dateTime(stop.at)}> at {whenText(stop.at, Date.now())}</span>}
          {why && ` · ${why}`}
          {reason && <span className="why" data-why="reason"> · {reason}</span>}
          {r.blocked && <span className="why" data-why="blocked"> · {sentence(r.blocked)}</span>}
          {/* what blocks the resume comes first: nothing continues until it is fixed */}
          {r.blocked ? !r.archived && " Fix this, then resume." : left.length > 0 && !r.archived && ` · ${left.join(", ")} will continue on resume`}
          <Applied words={words} archived={!!r.archived} onResult={onResult} />
        </span>
      </span>
    </div>
  );
}
