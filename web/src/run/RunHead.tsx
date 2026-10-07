// The line under the run bar: the run's meters on the left (turns, cost, slots, tasks, idle turns,
// working time, the agent) and the timeline's tools on the right (row filter, zoom, follow now,
// legend). The meters are the composer's context meter (.ctx-meter and its ring).
import { memo, useRef } from "react";
import "./run.css";
import "./result.css";
import { useStore } from "../store.ts";
import { modelLabel, effortLabel, tildify } from "../Composer.tsx";
import { useNow } from "../Subagents.tsx";
import { AgentGlyph, agentClass, agentName } from "../icons.tsx";
import { agentShortName } from "../agents.ts";
import { fmtDuration } from "../logic/subagents.ts";
import { runTaskTotal, runTasksDone } from "../logic/run.ts";
import { dateTime } from "../logic/runlabels.ts";
import { fitZoom, zoomIn, zoomOut, type RowFilter } from "../logic/runzoom.ts";
import { busySlots, countsTitle, meterTone, money, moneyLimit, stoppedTotal, workingMs } from "../logic/runview.ts";
import type { TimelineView } from "./Timeline.tsx";
import { TIGHT, useSize } from "./actions.ts";
import { TIER_ROWS } from "../logic/rungoal.ts";
import { TIERS, type RunView, type Stop, type Tier } from "../types.ts";
import { catalogFor } from "../logic/agentlist.ts";
import { serverOf } from "../logic/serverlists.ts";
import { folderOn, runWhere } from "../logic/runserver.ts";
import { yourFolder } from "../logic/runrows.ts";

/** The context meter's ring, for a value of a limit. */
function Ring({ used, max }: { used: number; max: number }) {
  const r = 6, circ = 2 * Math.PI * r, part = max > 0 ? Math.min(1, used / max) : 0;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r={r} className="ring-bg" />
      <circle cx="8" cy="8" r={r} className="ring" strokeDasharray={`${circ * part} ${circ}`} transform="rotate(-90 8 8)" />
    </svg>
  );
}

/** The working time, stops left out. It alone follows the clock. */
function Working({ run, stops }: { run: RunView; stops: Stop[] }) {
  const live = run.status === "running" || run.status === "stopping";
  const connected = useStore((s) => s.connected); // the clock stops while nothing is heard of the run
  const now = useNow(live && connected);
  const stopped = stoppedTotal(stops, now);
  const title = `Working time, stops left out. Started ${run.started ? dateTime(Date.parse(run.started)) : "—"}${stopped >= 1000 ? `; stopped for ${fmtDuration(stopped)} in all` : ""}.`;
  return <span className="ctx-meter run-meter" role="img" aria-label={`Working time ${fmtDuration(workingMs(run, now))}`} title={title}><b>{fmtDuration(workingMs(run, now))}</b></span>;
}

export interface RunHeadProps {
  run: RunView;
  /** The run's stops, for the working time's title. */
  stops: Stop[];
  /** What the timeline last said of itself; null until it has measured its width. */
  view: TimelineView | null;
  rows: RowFilter; follow: boolean; legend: boolean;
  /** The tools show (not while the dock covers the timeline). */
  tools: boolean;
  /** The stage is narrow: the agent chip is left out. */
  narrow: boolean;
  onRows(rows: RowFilter): void;
  onZoom(ppm: number | null): void;
  onFollow(on: boolean): void;
  onLegend(on: boolean): void;
  /** Opens the dock's Usage tab. */
  onUsage?(): void;
}

export const RunHead = memo(function RunHead({ run: r, stops, view: v, rows, follow, legend, tools, narrow, onRows, onZoom, onFollow, onLegend, onUsage }: RunHeadProps) {
  const server = serverOf(r);
  const cat = useStore((s) => catalogFor(s, server, r.agent));
  // the run's folder, "~" by its server's home; another server's names the server, and is not "your folder"
  const folder = useStore((s) => folderOn(runWhere(s, r), tildify(r.cwd, server)));
  const yours = useStore((s) => yourFolder(runWhere(s, r)));
  const startBranch = useStore((s) => s.runDetail[r.id]?.git?.branch); // the folder's branch when the run started
  const live = r.status === "running" || r.status === "stopping";
  const line = useRef<HTMLDivElement>(null);
  // The line is one row where leaving parts out achieves it: the apply chip goes first, then the
  // slots meter, then the agent chip. Under 700 px the tools have a row of their own whatever is
  // left out, so the meters' row keeps what it holds; in a tight stage (the side panel open in a
  // small window) the slots meter and the apply chip go.
  const w = useSize(line).w || 1200, tight = w < TIGHT, row = tools && !!v && w >= 700;
  const showSlots = live && !tight && (!row || w >= 980);
  const showApply = live && !!r.git && (row ? w >= 1150 : w >= 640);
  const showAgent = !narrow && (!row || w >= 840);
  const s = r.settings, busy = busySlots(r), total = runTaskTotal(r), done = runTasksDone(r);
  const turnsTone = meterTone(r.turns, s.maxTurns), costTone = r.cost != null ? meterTone(r.cost, s.maxCost) : "ok";
  const deep = r.tiers.deep, model = modelLabel(deep, cat), effort = deep.effort ? effortLabel(deep.effort) : ""; // the orchestrator's tier
  const same = TIERS.every((k) => r.tiers[k]?.model === deep.model && (r.tiers[k]?.effort ?? "") === (deep.effort ?? "")); // one model at three efforts is three tiers
  const tier = (k: Tier) => { const c = r.tiers[k], e = c?.effort ? effortLabel(c.effort) : ""; return `${c?.model ? modelLabel(c, cat) : "none"}${e ? `, ${e} effort` : ""}`; };
  // In a tight stage the three filters of a selected task do not fit the tools' row: their counts
  // go to their titles and the Now button keeps its mark only.
  const brief = tight && v?.counts.related != null;
  const filter = (k: RowFilter, label: string, n: number, title: string) => (
    <button type="button" className={rows === k ? "on" : ""} aria-pressed={rows === k} aria-label={`${label} ${n}`} title={brief ? `${title}: ${n}` : title} onClick={() => onRows(k)}>{label}{brief ? "" : ` ${n}`}</button>
  );
  return (
    <div className="run-head" ref={line}>
      <span className={`ctx-meter run-meter ${turnsTone}`} role="img" aria-label={`${r.turns} of ${s.maxTurns} orchestrator turns used`}
        title={`Orchestrator turns used of the limit. The run stalls when it has used ${s.maxTurns}.`}>
        <Ring used={r.turns} max={s.maxTurns} /><span><b>{r.turns}</b>/{s.maxTurns} turns</span>
      </span>
      {r.cost == null
        ? <span className="tchip static run-na" title={`${agentName(r.agent)} does not report cost`}>cost n/a</span>
        : (
          <button type="button" className={`ctx-meter run-meter run-cost ${costTone}`} onClick={onUsage} aria-label={`Cost ${money(r.cost)}${s.maxCost > 0 ? ` of ${moneyLimit(s.maxCost)}` : ""}${r.costPartial ? ", incomplete" : ""}`}
            title={`Open Usage. Cost of the run's agents so far; an agent that is running is added when it reports.${r.costPartial ? " The sum is incomplete: some agents reported no cost." : ""}${s.maxCost > 0 ? ` The run stalls at ${moneyLimit(s.maxCost)}.` : ""}${r.stalledBy === "cost" ? " The limit counts what running agents had spent; this sum has only what agents reported." : ""}`}>
            {s.maxCost > 0 && <Ring used={r.cost} max={s.maxCost} />}<span><b>{money(r.cost)}{r.costPartial ? "+" : ""}</b>{s.maxCost > 0 ? `/${moneyLimit(s.maxCost)}` : ""}</span>
          </button>
        )}
      {/* slots are a fact of a run at work: a run that is not live holds none */}
      {showSlots && <span className="ctx-meter run-meter" role="img" aria-label={`${busy} of ${s.maxParallel} slots busy`}
        title={`Tasks at work of the ${s.maxParallel} that may run at once. A task that is ready waits for a free slot.`}>
        {s.maxParallel <= 8
          ? <span className="run-slots" aria-hidden="true">{Array.from({ length: s.maxParallel }, (_, i) => <i key={i} className={i < busy ? "on" : ""} />)}</span>
          : <Ring used={busy} max={s.maxParallel} />}
        <span><b>{busy}</b>/{s.maxParallel} slots</span>
      </span>}
      <span className="ctx-meter run-meter" role="img" aria-label={`${done} of ${total} tasks done`} title={countsTitle(r.counts)}><span><b>{done}</b>/{total} task{total === 1 ? "" : "s"}</span></span>
      {r.idleStreak > 0 && (r.status === "running" || r.status === "stalled") && (
        <span className="ctx-meter run-meter run-idle" title={`Turns in a row with nothing running and nothing added. The run stalls after ${s.maxIdleTurns}.`}>idle {r.idleStreak}/{s.maxIdleTurns}</span>
      )}
      <Working run={r} stops={stops} />
      {showAgent && (
        <span className={`tchip static run-agent-chip agent-${agentClass(r.agent)}`} title={same
          ? `Every agent of this run is ${agentName(r.agent)}, in ${folder}. Its orchestrator works on ${model}${effort ? `, ${effort} effort` : ""}`
          : `Every agent of this run is ${agentName(r.agent)}, in ${folder}. ${TIER_ROWS.map(([k, name]) => `${name}: ${tier(k)}`).join("; ")}`}>
          <span className="run-agent-glyph"><AgentGlyph agent={r.agent} size={12} /></span>{agentShortName(r.agent)} · {same ? `${model}${effort ? ` · ${effort}` : ""}` : "3 tiers"}
        </span>
      )}
      {showApply && (s.applyResult === "manual"
        ? <span className="tchip static run-apply-chip" title="Automatic applying is off for this run: when it ends, the result waits for Apply in the Result tab.">auto-apply off</span>
        : <span className="tchip static run-apply-chip" title={`When the run ends, its result is applied to this branch of ${yours} if that is safe.`}>→ applies to {startBranch ? <code>{startBranch}</code> : yours} at the end</span>
      )}
      {tools && v && (
        <span className="run-tools">
          <span className="fk-filters" role="group" aria-label="Which tasks are listed">
            {filter("all", "All", v.counts.all, "Every task")}
            {filter("open", "Open", v.counts.open, "The tasks that are not done, failed or cancelled")}
            {v.counts.related != null && filter("related", "Related", v.counts.related, "The selected task, what it needs and what needs it (f)")}
          </span>
          <span className="run-zoom">
            <button type="button" className="icon-btn sm" title="Zoom out (−)" aria-label="Zoom out" disabled={!v.canZoomOut}
              onClick={() => { const z = zoomOut(v.ppm, v.fitPpm, live); if (z !== undefined) onZoom(z); }}>−</button>
            <button type="button" className={`btn ghost sm run-fit${v.fit ? " on" : ""}`} title="Show the whole run (0)" aria-pressed={v.fit} onClick={() => onZoom(fitZoom(v.fitPpm, live))}>Fit</button>
            <button type="button" className="icon-btn sm" title="Zoom in (+)" aria-label="Zoom in" disabled={!v.canZoomIn}
              onClick={() => { const z = zoomIn(v.ppm, v.fitPpm); if (z !== undefined) onZoom(z); }}>+</button>
          </span>
          {live && <button type="button" className={`btn ghost sm run-tool${follow ? " on" : ""}`} title="Keep now in view (n)" aria-label="Now" aria-pressed={follow} onClick={() => onFollow(!follow)}>◉{brief ? "" : " Now"}</button>}
          <button type="button" className={`btn ghost sm run-tool${legend ? " on" : ""}`} title="What the marks mean" aria-pressed={legend} onClick={() => onLegend(!legend)}>Legend</button>
        </span>
      )}
    </div>
  );
});
