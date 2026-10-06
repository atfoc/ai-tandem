// A task in the dock: what it is, what it waits on and what waits on it, and under tabs its
// report, its brief (every revision), its attempts (where their time went, their agents and those
// agents' restarts), what it changed in the code, and every call that was made on it.
import { useState, type ReactNode } from "react";
import "./dock.css";
import "./detail.css";
import "../fork/popup.css";
import { useStore } from "../store.ts";
import { Markdown } from "../Markdown.tsx";
import { useNow } from "../Subagents.tsx";
import { fmtDuration } from "../logic/subagents.ts";
import { STATES, addingTurn, taskState } from "../logic/runtimeline.ts";
import { waitSentence } from "../logic/runlabels.ts";
import { choiceLabel, launchNotes, launchWords, measuredAt, mergeAgents, phaseLine, renameOf, runLive, taskHistory, tokenLine, workedMs } from "../logic/runfeed.ts";
import { ChatRef, Clock, CopyCmd, Line, TaskChip, TaskMark, TextError, TextLoading, cost, stateOf, useDockTop } from "./bits.tsx";
import { useBrief, useChanges, useReport } from "./texts.ts";
import type { TaskTab } from "../logic/runview.ts";
import type { AgentKind, Attempt, CatalogModel, RunAgent, RunDetail, RunTiers, Task } from "../types.ts";

export interface RunTaskProps {
  runId: string;
  task: Task;
  detail: RunDetail;
  /** The tab shown, kept by the run's view (it outlives a visit to a transcript). */
  tab: Tab;
  onTab(tab: Tab): void;
  /** An agent's transcript was asked for (its chat id). */
  onOpenAgent(agentId: string): void;
  onSelectTask(id: string): void;
  onSelectTurn(n: number): void;
}

type Tab = TaskTab;
const sha = (s: string | undefined) => (s ?? "").slice(0, 7);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const running = (st: string) => st === "setup" || st === "work" || st === "merge";
/** An agent's state in the words of the run's pages (a halted run's agent is paused, as its task). */
const AGENT_WORDS: Record<string, string> = { running: "paused", done: "done", failed: "failed", cancelled: "cancelled", interrupted: "paused" };

/** A link to an agent's transcript, by the name the run gives the agent. */
function AgentLink({ agent, id, label, onOpen }: { agent: RunAgent | undefined; id: string; label?: string; onOpen(id: string): void }) {
  return <button type="button" className="link" data-agent={id} title={`Transcript of ${agent?.name ?? id}`} onClick={() => onOpen(id)}>{label ?? agent?.name ?? id} ›</button>;
}

export function RunTask({ runId, task, detail, tab, onTab: setTab, onOpenAgent, onSelectTask, onSelectTurn }: RunTaskProps) {
  const r = useStore((s) => s.runs[runId]);
  const models = useStore((s) => (r ? s.catalogs[r.agent]?.models : undefined));
  const top = useDockTop();
  const live = runLive(detail), st = taskState(task), state = stateOf(task, live), turn = addingTurn(task);
  const last = task.attempts[task.attempts.length - 1];
  const open = !last?.outcome;
  const now = useNow(live && open && running(st));
  // A run whose folder is not a git repository has no branches: its tasks have no Changes.
  const git = !!detail.git;
  const changes = task.writes && git;
  const shown: Tab = tab === "changes" && !changes ? "report" : tab;
  // The attempt the Report and Changes tabs show: the last one until another is picked.
  const [pick, setPick] = useState<number | null>(null);
  const attempt = task.attempts.find((a) => a.n === pick) ?? last;
  const neededBy = detail.tasks.filter((t) => t.dependsOn.includes(task.id)).map((t) => t.id);

  // The sub line: the state with its time (or why it waits), who added it, how long it ran, what it cost.
  const at = measuredAt(detail, now);
  const wait = waitSentence(task);
  const merging = st === "merge" && !!last?.conflicts?.length ? "resolving conflicts" : state.word;
  const stateText = last?.outcome && last.endedAt != null ? <>{state.word} <Clock t={last.endedAt} /></>
    : wait ? wait : live ? merging : "paused · continues on Resume";
  const ran = last?.startedAt != null ? fmtDuration(workedMs(detail.stops, last.startedAt, last.endedAt ?? Math.max(at, last.startedAt))) : "";
  const costs = task.attempts.map((a) => a.cost).filter((c): c is number => typeof c === "number");
  const total = r?.cost === null || !costs.length ? null : costs.reduce((a, b) => a + b, 0);
  // The transcript the head links to: of the agent at work now, else of the latest work agent.
  // What its tier runs on, in the catalogue's words: "Opus 5.5 · Max".
  const runsOn = choiceLabel(r?.tiers?.[task.tier], models);
  const latest = (st === "merge" && last?.agents.merge) || task.attempts.findLast((a) => a.agents.work)?.agents.work || null;

  const tabs: [Tab, string][] = [["report", "Report"], ["brief", task.briefs.length > 1 ? `Brief · rev ${task.briefRev}` : "Brief"],
    ["attempts", task.attempts.length > 1 ? `Attempts ${task.attempts.length}` : "Attempts"], ...(changes ? [["changes", "Changes"] as [Tab, string]] : []), ["history", "History"]];
  return (
    <div className="run-task" ref={top} data-task={task.id}>
      <div className="rd-head"><TaskMark task={task} live={live} /><span className="rd-title" dir="auto">{task.id} · {task.title}</span></div>
      <div className="rd-sub">
        {task.kind} · {task.writes ? "✎ writes code" : "report only"} · <span className="rd-state">{stateText}</span>
        {" · "}{task.addedBy ? <>added from <ChatRef id={task.addedBy} /></>
          : turn ? <>added in <button type="button" className="link lk" data-turn={turn} onClick={() => onSelectTurn(turn)}>turn {turn}</button></> : <>added <Clock t={task.createdAt} /></>}
        {task.attempts.length > 1 && ` · attempt ${task.attempts.length}`}
        {ran && <> · <span className="rd-ran">{open ? (live ? "running " : "ran ") : "ran "}{ran}{open && !live ? " so far" : ""}</span></>}
        {total != null && <> · <span className="rd-cost" title="What its agents cost, merge agents included">{cost(total)}</span></>}
      </div>
      {task.tier && (
        <div className="rd-sub rd-tier" data-tier={task.tier}>
          Tier <b>{task.tier}</b>{runsOn ? ` (${runsOn})` : ""}{task.tierReason ? <>: <i dir="auto">{task.tierReason}</i></> : null}
        </div>
      )}
      <div className="rd-chips">
        <span className="rd-k">Depends on</span>
        {task.dependsOn.length ? task.dependsOn.map((id) => <TaskChip key={id} id={id} detail={detail} onSelect={onSelectTask} suffix={(task.needsReport ?? []).includes(id) ? "full report" : "summary"} />) : <span>nothing</span>}
        <span className="rd-k rd-k2">Needed by</span>
        {neededBy.length ? neededBy.map((id) => <TaskChip key={id} id={id} detail={detail} onSelect={onSelectTask} />) : <span>nothing</span>}
      </div>
      <div className="rd-seg">
        <span className="fk-filters" role="tablist" aria-label={`Details of ${task.id}`}>
          {tabs.map(([k, label]) => <button key={k} type="button" role="tab" data-sub={k} aria-selected={shown === k} className={shown === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>)}
        </span>
        {latest && <AgentLink agent={detail.agents[latest]} id={latest} label={`Transcript of ${detail.agents[latest]?.name ?? latest}`} onOpen={onOpenAgent} />}
      </div>
      {(shown === "report" || shown === "changes") && task.attempts.length > 1 && (
        <div className="rd-pick">
          <span className="fk-filters">
            {task.attempts.map((a) => (
              <button key={a.n} type="button" data-attempt={a.n} className={a.n === attempt.n ? "on" : ""} onClick={() => setPick(a.n === last.n ? null : a.n)}>
                attempt {a.n} · {a.outcome ?? state.word}
              </button>
            ))}
          </span>
        </div>
      )}
      {shown === "report" && <Report key={attempt.n} runId={runId} task={task} a={attempt} isLast={attempt === last} detail={detail} agentKind={r?.agent} onOpenAgent={onOpenAgent} onSelectTurn={onSelectTurn} />}
      {shown === "brief" && <Brief runId={runId} task={task} agentKind={r?.agent} onSelectTurn={onSelectTurn} />}
      {shown === "attempts" && <Attempts task={task} detail={detail} tiers={r?.tiers} models={models} retries={r?.settings.agentRetries} noCost={r?.cost === null} onOpenAgent={onOpenAgent} onSelectTurn={onSelectTurn} />}
      {shown === "changes" && <Changes key={attempt.n} runId={runId} task={task} a={attempt} detail={detail} onOpenAgent={onOpenAgent} />}
      {shown === "history" && <History task={task} detail={detail} onSelectTask={onSelectTask} onSelectTurn={onSelectTurn} />}
    </div>
  );
}

/** Who cancelled an attempt, and why. */
function Cancelled({ a, onSelectTurn }: { a: Attempt; onSelectTurn(n: number): void }) {
  const c = a.cancel;
  if (!c) return <div className="note rd-cancel">Cancelled.</div>;
  return (
    <div className="note rd-cancel">
      Cancelled <Clock t={c.t} />{" "}
      {c.chat ? <>from <ChatRef id={c.chat} /></> : c.turn != null ? <>in <button type="button" className="link lk" data-turn={c.turn} onClick={() => onSelectTurn(c.turn!)}>turn {c.turn}</button></> : null}
      {c.reason ? <> · {c.reason}</> : null}
    </div>
  );
}

// ---- Report: the attempt's error, its outcome and summary, then the report's text

function Report({ runId, task, a, isLast, detail, agentKind, onOpenAgent, onSelectTurn }: {
  runId: string; task: Task; a: Attempt; isLast: boolean; detail: RunDetail; agentKind?: AgentKind; onOpenAgent(id: string): void; onSelectTurn(n: number): void;
}) {
  const live = runLive(detail), st = isLast ? taskState(task) : a.outcome ?? "held";
  // The detail says whether there is a report: one is asked for only then.
  const text = useReport(runId, task.id, a.n, !!a.result && a.result.reportSize !== 0);
  const work = a.agents.work ? detail.agents[a.agents.work] : undefined;
  const merge = a.agents.merge ? detail.agents[a.agents.merge] : undefined;
  const res = text.s === "ok" ? text.value : a.result;
  const failed = res?.outcome === "failed";
  // What an attempt that is not over is doing, in a sentence, with the way to its agent.
  let doing: ReactNode = null;
  if (!a.outcome && isLast) {
    const agent = st === "merge" ? merge : work, id = st === "merge" ? a.agents.merge : a.agents.work;
    const link = id ? <> <AgentLink agent={agent} id={id} label="Transcript" onOpen={onOpenAgent} /></> : null;
    if (!running(st)) doing = <>{sentence(waitSentence(task))}</>;
    else if (!live) doing = <>{st === "merge" ? "The merge" : "The agent"} was interrupted when the run stopped. It continues on Resume.{link}</>;
    else if (st === "setup") doing = <>Its checkout is being set up.</>;
    else if (st === "merge") doing = <>{a.conflicts?.length ? <>The work is done; {merge?.name ?? "a merge agent"} is resolving conflicts in {plural(a.conflicts.length, "file")}{merge?.activity ? `: ${merge.activity}` : ""}.</> : <>The work is done and is being merged.</>}{link}</>;
    else doing = <>{work?.name ?? "The agent"} is working{work?.activity ? <>: <span className="rd-activity">{work.activity}</span></> : null}.{link}</>;
  }
  return (
    <div className="rd-report" data-attempt={a.n}>
      {a.outcome === "failed" && a.error && <div className="note error rd-error">{a.error}</div>}
      {a.outcome === "cancelled" && <Cancelled a={a} onSelectTurn={onSelectTurn} />}
      {!res && (
        <div className="note rd-noreport">
          {a.outcome === "done" ? "The agent left no report." : a.outcome === "failed" ? "The agent left no report." : a.outcome === "cancelled" ? (a.startedAt == null ? "It never started." : "It was cancelled before it reported.") : <>No report yet. {doing}</>}
        </div>
      )}
      {res && doing && <div className="note rd-doing">{doing}</div>}
      {res && (
        <>
          <div className="rd-outcome"><b className={failed ? "tone-danger" : "tone-ok"}>{res.outcome === "completed" ? "done" : res.outcome}</b><span className="tone-muted"> · what the agent reported</span></div>
          <div className="rd-md rd-summary"><Markdown text={res.summary} agent={agentKind} /></div>
          {text.s === "loading" && a.result?.reportSize !== 0 && <TextLoading />}
          {text.s === "error" && <TextError what="the report" message={text.message} onRetry={text.retry} />}
          {(text.s === "none" || a.result?.reportSize === 0) && <div className="note rd-noreport">The agent wrote no report beyond this summary.</div>}
          {text.s === "ok" && text.value.report.trim() !== "" && <div className="rd-md rd-text"><Markdown text={text.value.report} agent={agentKind} /></div>}
          {text.s === "ok" && text.value.report.trim() === "" && <div className="note rd-noreport">The agent wrote no report beyond this summary.</div>}
        </>
      )}
    </div>
  );
}

/** A wait sentence as a sentence of its own: "It starts when turn 14 ends." */
function sentence(wait: string): string {
  if (!wait) return "";
  if (wait.startsWith("starts")) return `It ${wait}.`;
  if (wait.startsWith("ready")) return "It is ready and waits for a free slot.";
  return `It is ${wait}.`;
}

// ---- Brief: the revision in force, or another one

function Brief({ runId, task, agentKind, onSelectTurn }: { runId: string; task: Task; agentKind?: AgentKind; onSelectTurn(n: number): void }) {
  // null: the revision in force, whichever that becomes
  const [pick, setPick] = useState<number | null>(null);
  const rev = pick != null && task.briefs.some((b) => b.rev === pick) ? pick : task.briefRev;
  const meta = task.briefs.find((b) => b.rev === rev);
  const text = useBrief(runId, task.id, rev);
  return (
    <div className="rd-brief" data-rev={rev}>
      {task.briefs.length > 1 && (
        <div className="rd-pick">
          <span className="fk-filters">
            {task.briefs.map((b) => (
              <button key={b.rev} type="button" data-rev={b.rev} className={b.rev === rev ? "on" : ""} onClick={() => setPick(b.rev === task.briefRev ? null : b.rev)}>
                rev {b.rev} · {b.chat ? "a chat" : b.turn != null ? `turn ${b.turn}` : "the run"}{b.rev === task.briefRev ? " (in force)" : ""}
              </button>
            ))}
          </span>
        </div>
      )}
      {meta && (
        <div className="rd-sub rd-meta">
          rev {meta.rev} · written{" "}
          {meta.chat ? <>from <ChatRef id={meta.chat} /></> : meta.turn != null ? <>in <button type="button" className="link lk" data-turn={meta.turn} onClick={() => onSelectTurn(meta.turn!)}>turn {meta.turn}</button></> : null}
          {" · "}<Clock t={meta.at} /> · {meta.size.toLocaleString("en-US")} characters{meta.rev === task.briefRev ? (task.briefs.length > 1 ? " · in force" : "") : " · replaced"}
        </div>
      )}
      {text.s === "loading" && <TextLoading />}
      {text.s === "error" && <TextError what="the brief" message={text.message} onRetry={text.retry} />}
      {text.s === "none" && <div className="note">This revision of the brief is not recorded.</div>}
      {text.s === "ok" && <div className="rd-md rd-text"><Markdown text={text.value.text} agent={agentKind} /></div>}
    </div>
  );
}

// ---- Attempts: each one's outcome, times, cost, agents, error, phases and launches

function Attempts({ task, detail, tiers, models, retries, noCost, onOpenAgent, onSelectTurn }: {
  task: Task; detail: RunDetail; tiers?: RunTiers; models?: CatalogModel[]; retries?: number; noCost: boolean; onOpenAgent(id: string): void; onSelectTurn(n: number): void;
}) {
  const live = runLive(detail), last = task.attempts[task.attempts.length - 1];
  const now = useNow(live && !last?.outcome);
  const at = measuredAt(detail, now);
  return (
    <div className="rd-attempts">
      {task.attempts.map((a, i) => {
        const isLast = a === last, st = a.outcome ?? (isLast ? taskState(task) : "held");
        // The tier it ran on, with the model and effort of its agent (of the run's tier before it has one).
        const work = a.agents.work ? detail.agents[a.agents.work] : undefined, was = task.attempts[i - 1]?.tier;
        const ranOn = choiceLabel(work ?? (a.tier ? tiers?.[a.tier] : null), models);
        const paused = !a.outcome && !live && running(st);
        const v = STATES[st];
        const end = a.endedAt ?? Math.max(at, a.startedAt ?? at);
        const merges = mergeAgents(detail, task.id, a.n, a.agents.merge);
        const agents = [...(a.agents.work && detail.agents[a.agents.work] ? [detail.agents[a.agents.work]] : []), ...merges];
        const phases = phaseLine(a, now, detail.stops);
        return (
          <div key={a.n} className="rd-attempt" data-attempt={a.n}>
            <div className="rd-att-head">
              <span className={`rd-mark tone-${paused ? "muted" : v.tone}`}>{paused ? "‖" : v.pulse && live ? <i className="sub-dot" /> : v.glyph}</span>
              <b>Attempt {a.n}</b>
              <span>{paused ? "paused" : a.outcome ?? v.word}</span>
              {a.startedAt != null
                ? <span className="rd-times"><Clock t={a.startedAt} /> → {a.endedAt != null ? <Clock t={a.endedAt} /> : live ? "now" : "stopped"} · {fmtDuration(workedMs(detail.stops, a.startedAt, end))}</span>
                : <span className="rd-times">{a.endedAt != null ? <>never started · ended <Clock t={a.endedAt} /></> : "not started"}</span>}
              <span className="rd-cost">{cost(noCost ? null : a.cost)}</span>
              {a.tier && <span className="rd-att-tier" data-tier={a.tier}>{a.tier}{ranOn ? ` · ${ranOn}` : ""}{was && was !== a.tier ? <span className="rd-was"> (was {was})</span> : null}</span>}
              {a.agents.work && <AgentLink agent={detail.agents[a.agents.work]} id={a.agents.work} onOpen={onOpenAgent} />}
              {merges.map((m, i) => <AgentLink key={m.id} agent={m} id={m.id} label={merges.length > 1 ? `${m.name} (round ${i + 1})` : undefined} onOpen={onOpenAgent} />)}
            </div>
            {agents.map((g) => {
              const on = g.status === "running" && live;
              const ms = Math.max(0, (g.endedAt ?? (on ? Math.max(at, g.startedAt) : g.launches.at(-1)?.endedAt ?? g.startedAt)) - g.startedAt);
              const used = tokenLine(g);
              return (
                <div key={g.id} className="rd-att-line rd-att-agent" data-agent={g.id}>
                  {g.name} · {g.role === "merge" ? "merge agent" : "work agent"} · <span className={`tone-${g.status === "failed" ? "danger" : "muted"}`}>{on ? "running" : AGENT_WORDS[g.status] ?? g.status}</span>
                  {" · "}{fmtDuration(ms)}{!noCost && g.cost != null ? ` · ${cost(g.cost)}` : ""}
                  {g.role === "merge" && g.model ? ` · ${g.tier} · ${choiceLabel(g, models)}` : ""}
                  {used && <span className="rd-tokens"> · {used}</span>}
                </div>
              );
            })}
            {(a.queuedBy || a.n > 1) && (
              <div className="rd-att-line">
                queued <Clock t={a.queuedAt} />{" "}
                {a.queuedBy ? <>from <ChatRef id={a.queuedBy} /></> : <>in <button type="button" className="link lk" data-turn={a.queuedTurn} onClick={() => onSelectTurn(a.queuedTurn)}>turn {a.queuedTurn}</button></>}
              </div>
            )}
            {a.error && <div className="note error rd-error">{a.error}</div>}
            {a.outcome === "cancelled" && <Cancelled a={a} onSelectTurn={onSelectTurn} />}
            {paused && <div className="rd-att-line">Interrupted when the run stopped. It continues on Resume.</div>}
            {!!a.conflicts?.length && <div className="rd-att-line tone-warn">⚠ merge conflicts in {plural(a.conflicts.length, "file")}{merges.length > 1 ? ` · ${merges.length} merge rounds` : ""}</div>}
            {phases && <div className="rd-att-line rd-phases">{phases}</div>}
            {agents.map((g) => {
              const notes = launchNotes(g);
              if (!notes.length) return null;
              const k = notes.filter((n) => n.kind === "restart").length;
              return (
                <div key={g.id} className="rd-launches" data-agent={g.id}>
                  {k > 0 && <div className="rd-att-line tone-warn">↻ {g.name} · agent restarted ({k}{retries ? ` of ${retries}` : ""})</div>}
                  {notes.map((n) => (
                    <div key={n.n} className={`rd-att-line rd-launch k-${n.kind}`}>
                      <Clock t={n.t} /> {g.name} {launchWords(n, retries)}{n.why ? <span className="tone-muted"> · {n.why}</span> : null}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ---- Changes: what the attempt committed, and what became of it

function Changes({ runId, task, a, detail, onOpenAgent }: { runId: string; task: Task; a: Attempt; detail: RunDetail; onOpenAgent(id: string): void }) {
  const live = runLive(detail);
  const text = useChanges(runId, task.id, a.n, a.head ?? null, a.endedAt != null);
  const merges = mergeAgents(detail, task.id, a.n, a.agents.merge);
  if (!a.head) {
    return <div className="rd-changes"><div className="note rd-nochanges">{a.outcome ? "This attempt committed nothing." : a.startedAt == null ? "The attempt has not started." : "Nothing is committed yet."}</div></div>;
  }
  if (text.s === "loading") return <div className="rd-changes"><TextLoading /></div>;
  if (text.s === "error") return <div className="rd-changes"><TextError what="the changes" message={text.message} onRetry={text.retry} /></div>;
  if (text.s === "none") return <div className="rd-changes"><div className="note rd-nochanges">No changes are recorded for this attempt.</div></div>;
  const c = text.value, conflicts = c.conflicts ?? a.conflicts ?? [];
  const hit = new Set(conflicts);
  const unchanged = !c.files.length || c.base === c.head;
  const resolving = !a.outcome && live && taskState(task) === "merge";
  return (
    <div className="rd-changes" data-attempt={a.n}>
      <div className="rd-kv">
        <span className="rd-k">Branch</span><span className="mono rd-wrap">{c.branch}</span>
        <span className="rd-k">Commits</span>
        <span><span className="mono" title={`${c.base}..${c.head}`}>{sha(c.base)}..{sha(c.head)}</span>
          {" · "}<span className="rd-merged">{c.merged ? <>merged {c.mergedAt != null ? <Clock t={c.mergedAt} /> : null} as <span className="mono" title={c.merged}>{sha(c.merged)}</span></> : unchanged ? "no changes" : a.outcome ? "not merged" : "not merged yet"}</span></span>
      </div>
      {conflicts.length > 0 && (
        <div className="rd-conflicts tone-warn">
          ⚠ Conflicts in {plural(conflicts.length, "file")}{merges.length ? <>, {resolving ? "being resolved" : "resolved"} by </> : "."}
          {merges.map((m, i) => <span key={m.id}>{i ? ", " : ""}<AgentLink agent={m} id={m.id} label={merges.length > 1 ? `${m.name} (round ${i + 1})` : undefined} onOpen={onOpenAgent} /></span>)}
        </div>
      )}
      {c.files.length > 0 && (
        <>
          <div className="tool-sub">{plural(c.files.length, "file")} · <span className="tone-ok">+{c.add}</span> <span className="tone-danger">−{c.del}</span></div>
          <div className="rd-files">
            {c.files.map((f) => {
              const mv = renameOf(f.path);
              return (
                <div key={f.path} className="rd-file">
                  <span className="mono rd-wrap">{mv ? <>{mv.from} <span className="tone-muted">→</span> {mv.to}</> : f.path}</span>
                  {mv && <span className="rd-tag">renamed</span>}
                  {(hit.has(f.path) || (mv && (hit.has(mv.to) || hit.has(mv.from)))) && <span className="rd-tag tone-warn">⚠ conflict</span>}
                  <span className="rd-stat">{f.binary ? <span className="tone-muted">binary</span> : <><span className="tone-ok">+{f.add}</span> <span className="tone-danger">−{f.del}</span></>}</span>
                </div>
              );
            })}
            {conflicts.filter((p) => !c.files.some((f) => f.path === p || renameOf(f.path)?.to === p || renameOf(f.path)?.from === p)).map((p) => (
              <div key={p} className="rd-file"><span className="mono rd-wrap">{p}</span><span className="rd-tag tone-warn">⚠ conflict</span><span className="rd-stat tone-muted">merge only</span></div>
            ))}
          </div>
        </>
      )}
      {c.commits.length > 0 && (
        <>
          <div className="tool-sub">{plural(c.commits.length, "commit")}</div>
          <div className="rd-commits">
            {c.commits.map((k) => <div key={k.sha} className="rd-commit"><span className="mono" title={k.sha}>{sha(k.sha)}</span><span className="rd-wrap">{k.subject}</span><span className="tone-faint"><Clock t={k.at} /></span></div>)}
          </div>
        </>
      )}
      {!unchanged && <CopyCmd text={`git diff ${c.base}..${c.head}`} />}
    </div>
  );
}

// ---- History: every call on the task

function History({ task, detail, onSelectTask, onSelectTurn }: { task: Task; detail: RunDetail; onSelectTask(id: string): void; onSelectTurn(n: number): void }) {
  const rows = taskHistory(detail, task.id);
  if (!rows.length) return <div className="rd-history"><div className="note">No call on this task is recorded.</div></div>;
  return (
    <div className="rd-history feed">
      {rows.map((h) => (
        <Line key={h.key} t={h.t} glyph={h.glyph} tone={h.tone} parts={h.parts} note={h.note} onSelectTask={onSelectTask}
          before={<>{h.chat ? <ChatRef id={h.chat} /> : h.turn != null ? <button type="button" className="link lk" data-turn={h.turn} onClick={() => onSelectTurn(h.turn!)}>Turn {h.turn}</button> : null}{" "}</>} />
      ))}
    </div>
  );
}
