// An orchestrator turn in the dock: when it ran and what it cost, why it started, what it learned
// while it ran, what it did (its reads in one line, then each change and each refused call), what
// it waits for after that, and what it said when it ended.
import "./dock.css";
import "./detail.css";
import { useStore } from "../store.ts";
import { Markdown } from "../Markdown.tsx";
import { useNow } from "../Subagents.tsx";
import { fmtDuration } from "../logic/subagents.ts";
import { callLine, isWrite, launchNotes, launchWords, measuredAt, runLive, turnKept, turnReads, turnStart, turnThen, workedMs } from "../logic/runfeed.ts";
import { ChatRef, Clock, Line, Parts, TaskChip, cost, useDockTop } from "./bits.tsx";
import type { RunDetail, RunEvent, Turn } from "../types.ts";

export interface RunTurnProps {
  runId: string;
  turn: Turn;
  detail: RunDetail;
  /** An agent's transcript was asked for (its chat id). */
  onOpenAgent(agentId: string): void;
  onSelectTask(id: string): void;
  /** A version of the notes was asked for: the Notes tab shows it. */
  onOpenNotes?(v: number): void;
}

/** The events a turn learned of: a task that finished or failed as its chip and when; what a chat did in
 *  the words the run recorded, with the way to the chat. The same event can stand in two turns (a
 *  failed turn's successor carries it again): the list is keyed by position. */
function Events({ events, detail, onSelectTask }: { events: RunEvent[]; detail: RunDetail; onSelectTask(id: string): void }) {
  return (
    <div className="rd-events">
      {events.map((e, i) => (e.type === "chat_op" || !e.task
        ? <div key={i} className="rd-event k-chat"><span className="rd-mark">◆</span><span className="rd-wrap">{e.text || "A chat changed the run."} <span className="tone-muted">· <Clock t={e.t} />{e.chat ? <> · <ChatRef id={e.chat} /></> : null}</span></span></div>
        : <div key={i} className="rd-event" title={e.text}><TaskChip id={e.task} detail={detail} onSelect={onSelectTask} /><span>{e.type === "task_failed" ? "failed" : "finished"} <Clock t={e.t} /></span></div>
      ))}
    </div>
  );
}

export function RunTurn({ runId, turn, detail, onOpenAgent, onSelectTask, onOpenNotes }: RunTurnProps) {
  const r = useStore((s) => s.runs[runId]);
  const top = useDockTop();
  // A turn whose record says "running" is running only while the run is: in a halted run it was interrupted.
  const open = turn.endedAt == null && turn.status === "running";
  const running = open && runLive(detail), interrupted = open && !running;
  const now = useNow(running);
  const end = turn.endedAt ?? Math.max(measuredAt(detail, now), turn.startedAt);
  const took = fmtDuration(workedMs(detail.stops, turn.startedAt, end));
  // Why it started is one sentence; what a chat did to start it is said below it, in the run's words.
  const why = turnStart(turn, detail.turns[detail.turns.indexOf(turn) - 1]), woke = (turn.wokenBy ?? []).filter((e) => e.type === "chat_op"), learned = turn.learned ?? [];
  const then = turnThen(turn), kept = turnKept(turn, r?.cost === null ? null : turn.cost);
  const reads = turnReads(turn), calls = (turn.ops ?? []).filter(isWrite);
  const agent = detail.agents[turn.agent];
  const notes = agent ? launchNotes(agent) : [];
  const links = { onSelectTask, onOpenNotes };
  return (
    <div className="run-turn" ref={top} data-turn={turn.n}>
      <div className="rd-head">
        <span className={`rd-mark ${turn.status === "failed" ? "tone-danger" : "tone-orch"}`}>{running ? <i className="sub-dot" /> : turn.status === "failed" ? "!" : interrupted ? "‖" : "▸"}</span>
        <span className="rd-title">Turn {turn.n}</span>
        {kept && <span className="rd-chip rd-kept" title="It added, changed, cancelled or retried no task and did not finish the run">{kept}</span>}
      </div>
      <div className="rd-sub">
        <Clock t={turn.startedAt} /> → {turn.endedAt != null ? <Clock t={turn.endedAt} /> : running ? "now" : "paused"}
        {" · "}<span className="rd-ran">{took}</span>{r?.cost !== null && turn.cost != null && <> · <span className="rd-cost">{cost(turn.cost)}</span></>}{turn.status === "failed" ? " · failed" : ""}
        {" · "}<button type="button" className="link" data-agent={turn.agent} onClick={() => onOpenAgent(turn.agent)}>Transcript ›</button>
      </div>
      {interrupted && <div className="note rd-interrupted">The turn was interrupted when the run stopped. It continues on Resume.</div>}

      <div className="tool-sub">Why it started</div>
      <div className="rd-why"><Parts parts={why} chips={detail} onSelectTask={onSelectTask} /></div>
      {woke.length > 0 && <Events events={woke} detail={detail} onSelectTask={onSelectTask} />}

      {learned.length > 0 && <><div className="tool-sub">Also learned during the turn</div><Events events={learned} detail={detail} onSelectTask={onSelectTask} /></>}

      <div className="tool-sub">What it did</div>
      <div className="feed rd-did">
        {reads.length > 0 && <div className="feed-row tone-muted rd-reads"><span className="t" /><span className="g">·</span><span className="s dm">looked at <Parts parts={reads} onSelectTask={onSelectTask} /></span></div>}
        {calls.map((op) => { const l = callLine(op); return <Line key={op.i} t={op.t} glyph={l.glyph} tone={l.tone} parts={l.parts} note={l.note} {...links} />; })}
        {notes.map((n) => <Line key={"l" + n.n} t={n.t} glyph={n.kind === "restart" ? "↻" : "▷"} tone={n.kind === "restart" ? "warn" : "muted"} parts={[`its agent ${launchWords(n, r?.settings.agentRetries)}`]} note={n.why} />)}
        {!calls.length && <div className="note rd-nothing">{running ? (reads.length ? "It has changed nothing yet." : "Nothing yet.") : interrupted ? "It had changed nothing when it was interrupted." : "It changed nothing."}</div>}
      </div>

      {then && <><div className="tool-sub">Then</div><div className="rd-why rd-then"><Parts parts={then} chips={detail} onSelectTask={onSelectTask} /></div></>}

      <div className="tool-sub">What it said</div>
      {turn.status === "failed" && <div className="note error rd-error">{turn.error || "The turn failed."}</div>}
      {turn.summary ? <div className="rd-md rd-text"><Markdown text={turn.summary} agent={r?.agent} /></div>
        : turn.status !== "failed" && <div className="note rd-nothing">{running ? "It is still deciding." : interrupted ? "Nothing yet: it was interrupted." : "It ended without a closing message."}</div>}
    </div>
  );
}
