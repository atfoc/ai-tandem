// What the run was started with, in the dock: the agent, the folder, the limits, and the goal.
import "./dock.css";
import "./detail.css";
import { useStore } from "../store.ts";
import { Markdown } from "../Markdown.tsx";
import { modelLabel, effortLabel, tildify } from "../Composer.tsx";
import { AgentGlyph, agentClass, agentName } from "../icons.tsx";
import { dateTime } from "../logic/runlabels.ts";
import { limitsLabel } from "../logic/run.ts";
import { orchestratorChoice, ORCHESTRATOR_ROW, TIER_ROWS } from "../logic/rungoal.ts";
import { DirtyNote, TextError, TextLoading, useDockTop } from "./bits.tsx";
import { useGoal } from "./texts.ts";
import { TIERS, type ModelChoice, type RunDetail } from "../types.ts";
import { catalogFor } from "../logic/agentlist.ts";
import { serverOf } from "../logic/serverlists.ts";
import { folderOn, runWhere } from "../logic/runserver.ts";

export interface RunGoalProps { runId: string; detail: RunDetail }

export function RunGoal({ runId, detail }: RunGoalProps) {
  const r = useStore((s) => s.runs[runId]);
  const server = serverOf(r);
  const cat = useStore((s) => (r ? catalogFor(s, server, r.agent) : undefined));
  const folder = useStore((s) => (r ? folderOn(runWhere(s, r), tildify(r.cwd, server)) : "")); // another server's folder names the server
  const text = useGoal(runId);
  const top = useDockTop();
  const s = r?.settings;
  // "Opus 5.5 · High": one tier's model and effort; a run whose three tiers are one choice names it once
  const choice = (c: ModelChoice | undefined) => (c?.model ? `${modelLabel(c, cat)}${c.effort ? ` · ${effortLabel(c.effort)}` : ""}` : "none");
  const same = !!r && TIERS.every((k) => choice(r.tiers[k]) === choice(orchestratorChoice(r.tiers)));
  const named = r?.tiers.orchestrator ? [ORCHESTRATOR_ROW, ...TIER_ROWS] : TIER_ROWS; // an orchestrator on the deep tier is not named apart
  return (
    <div className="run-goal-tab" ref={top}>
      {r && s && (
        <div className="rd-sub rd-started">
          <span className={`rd-agent agent-${agentClass(r.agent)}`}><AgentGlyph agent={r.agent} size={12} /></span> {agentName(r.agent)} · {same
            ? choice(r.tiers.deep)
            : named.map(([k, name], i) => <span key={k} className="rd-goal-tier" data-tier={k}>{i > 0 && " · "}<span className="rd-goal-tier-name">{name}</span> {choice(r.tiers[k])}</span>)}
          {" · "}<span className="mono rd-wrap rd-folder" title={r.cwd}>{folder}</span>{!detail.git ? " (not a git repository)" : ""} · started {dateTime(detail.startedAt)}
          {" · "}{limitsLabel(s)}
          {s.setup ? <> · setup <span className="mono rd-wrap">{s.setup}</span></> : null}
        </div>
      )}
      <DirtyNote git={detail.git} />
      {text.s === "loading" && <TextLoading />}
      {text.s === "error" && <TextError what="the goal" message={text.message} onRetry={text.retry} />}
      {text.s === "none" && <div className="note">The goal's text is not recorded.</div>}
      {text.s === "ok" && <div className="rd-md rd-text"><Markdown text={text.value.text} agent={r?.agent} /></div>}
    </div>
  );
}
