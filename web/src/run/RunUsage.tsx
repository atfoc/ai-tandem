// The dock's Usage tab: what the run's agents used, by tier and by kind of agent, and how many of
// the orchestrator's turns changed nothing. Every figure is derived from the run's detail on each
// render (logic/runusage.ts), so it stays current while the run is live.
import { useMemo } from "react";
import "./dock.css";
import "./usage.css";
import { useStore } from "../store.ts";
import { effortLabel } from "../logic/labels.ts";
import { fmtDuration } from "../logic/subagents.ts";
import { TIER_ROWS } from "../logic/rungoal.ts";
import { NO_TIER, costShare, manyQuiet, missingNote, runUsage, usageMoney, usageTokens, type UsageRow } from "../logic/runusage.ts";
import type { Catalog, RunDetail, RunTiers, Tier } from "../types.ts";

export interface RunUsageProps {
  runId: string;
  detail: RunDetail;
}

type Named = { row: UsageRow; name: string; note?: string };

/** "Opus 5.5 · Max": a tier's model and effort, named as the composer's Models chip names them. */
function tierNote(tiers: RunTiers | undefined, tier: Tier, cat?: Catalog): string {
  const c = tiers?.[tier];
  if (!c?.model) return "";
  const m = cat?.models.find((x) => x.id === c.model);
  const effort = c.effort && (m ? !!m.efforts?.length : true) ? effortLabel(c.effort, m) : "";
  return `${m?.label ?? c.model}${effort ? " · " + effort : ""}`;
}

/** A row none of whose agents has ended yet. */
const NONE_TIME = "running";

const KIND_NAMES: Record<string, string> = { orchestrator: "Orchestrator", merge: "Merge" };

const PEAK = <th title="The median of the agents' fullest context">Peak context</th>;

/** One of the two tables. They are sections of one <table> so that their columns line up.
 *  `bare`: no agent has a cost or tokens, and the table has the columns there are values for:
 *  the agents, how long they ran, and (`peak`) their context. */
function Section({ title, head, rows, bare, peak }: { title: string; head: string; rows: Named[]; bare: boolean; peak: boolean }) {
  const cost = rows.reduce<number | null>((sum, r) => (r.row.cost == null ? sum : (sum ?? 0) + r.row.cost), null);
  if (bare) return (
    <tbody>
      <tr className="ru-cap"><th colSpan={peak ? 4 : 3} scope="rowgroup" className="tool-sub">{title}</th></tr>
      <tr className="ru-cols"><th>{head}</th><th>Agents</th><th title="How long its agents ran, from start to end, added up; an agent still at work is not counted">Agent time</th>{peak && PEAK}</tr>
      {rows.map(({ row: r, name, note }) => (
        <tr key={r.key} data-key={r.key}>
          <td><b>{name}</b>{note && <span className="n"> {note}</span>}</td>
          <td>{r.agents}</td>
          <td>{r.ms != null ? fmtDuration(r.ms) : NONE_TIME}</td>
          {peak && <td>{usageTokens(r.medianPeakContext)}</td>}
        </tr>
      ))}
    </tbody>
  );
  return (
    <tbody>
      <tr className="ru-cap"><th colSpan={9} scope="rowgroup" className="tool-sub">{title}</th></tr>
      <tr className="ru-cols">
        <th>{head}</th><th>Agents</th><th>Cost</th><th className="bar" aria-label="Share of the cost" /><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th>
        {PEAK}
      </tr>
      {rows.map(({ row: r, name, note }) => {
        const share = costShare(r.cost, cost);
        return (
          <tr key={r.key} data-key={r.key}>
            <td><b>{name}</b>{note && <span className="n"> {note}</span>}</td>
            <td>{r.agents}</td>
            <td title={r.costPerAgent != null ? `${usageMoney(r.costPerAgent)} per agent` : undefined}>{usageMoney(r.cost)}</td>
            <td className="bar">{share > 0 && <i style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} title={`${Math.round(share * 100)}% of the cost`} />}</td>
            <td>{usageTokens(r.tokens?.in)}</td><td>{usageTokens(r.tokens?.out)}</td><td>{usageTokens(r.tokens?.cacheRead)}</td><td>{usageTokens(r.tokens?.cacheWrite)}</td>
            <td>{usageTokens(r.medianPeakContext)}</td>
          </tr>
        );
      })}
    </tbody>
  );
}

export function RunUsage({ runId, detail }: RunUsageProps) {
  const tiers = useStore((s) => s.runs[runId]?.tiers);
  const cat = useStore((s) => { const r = s.runs[runId]; return r ? s.catalogs[r.agent] : undefined; });
  const u = useMemo(() => runUsage(detail), [detail]);
  const note = useMemo(() => missingNote(detail), [detail]);
  if (!u.total.agents) return <div className="run-usage"><div className="ru-none">No agent has started yet: nothing is used.</div></div>;
  const tierName = new Map(TIER_ROWS.map(([k, name]) => [k as string, name]));
  const { turns, bare } = u, peak = u.total.medianPeakContext != null;
  return (
    <div className={`run-usage${bare ? " bare" : ""}`}>
      <div className="ru-top">
        {!bare && <div><b>{usageMoney(u.total.cost)}</b><span>total cost</span></div>}
        <div><b>{u.total.agents}</b><span>{u.total.agents === 1 ? "agent" : "agents"}</span></div>
        {bare && u.total.ms != null && <div title="How long the agents ran, from start to end, added up"><b>{fmtDuration(u.total.ms)}</b><span>agent time</span></div>}
        {(!bare || peak) && <div><b>{usageTokens(u.total.medianPeakContext)}</b><span>median peak context</span></div>}
        {turns.done > 0 && (
          <div className={manyQuiet(turns) ? "warn" : undefined} title="Finished turns in which the orchestrator added, changed, cancelled or retried no task and did not finish the run">
            <b>{turns.quiet} of {turns.done}</b>
            <span>orchestrator {turns.done === 1 ? "turn" : "turns"} changed nothing{turns.quiet > 0 && turns.quietCost != null ? ` · ${usageMoney(turns.quietCost)}` : ""}</span>
          </div>
        )}
      </div>
      <div className="ru-scroll">
        <table className="ru-table">
          {u.byTier.length > 0 && (
            <Section title="By tier" head="Tier" bare={bare} peak={peak}
              rows={u.byTier.map((row) => ({ row, name: tierName.get(row.key) ?? row.key, note: row.key === NO_TIER ? "no tier" : tierNote(tiers, row.key as Tier, cat) }))} />
          )}
          <Section title="By kind of task" head="Kind" bare={bare} peak={peak} rows={u.byKind.map((row) => ({ row, name: KIND_NAMES[row.key] ?? row.key }))} />
        </table>
      </div>
      {note && <div className="ru-note">{note}</div>}
    </div>
  );
}
