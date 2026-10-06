// The stage of a started run: where the user follows it. From the top: the meters and the
// timeline's tools, how the run ended (or why it is halted), the timeline, and a dock for the
// details of the run and of what is selected. An agent's transcript opens beside the stage, in the
// panel where the run's chats show (store.ts openRunAgent, App.tsx).
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import "./run.css";
import { useStore, getState, openRunAgent, closeRunAgent } from "../store.ts";
import { loadRun, runLoadError } from "../conn.ts";
import { Guard } from "../Guard.tsx";
import { deleteRun } from "../Sidebar.tsx";
import { isLive } from "../logic/runtimeline.ts";
import { timelineInput } from "../logic/runwire.ts";
import { clearIn, dockIn, escIn, openingView, selectIn, tabIn, taskCounts, taskTabIn, type DockState, type DockTab, type TaskTab, type ViewState } from "../logic/runview.ts";
import { rowCounts, type RowFilter } from "../logic/runzoom.ts";
import type { TierNames } from "../logic/runlabels.ts";
import { TIERS } from "../types.ts";
import { modelLabel, effortLabel } from "../Composer.tsx";
import { escTaken } from "../Subagents.tsx";
import { NARROW, loadUi, saveUi, useSize } from "./actions.ts";
import { Timeline, type TimelineView } from "./Timeline.tsx";
import { RunHead } from "./RunHead.tsx";
import { RunNow } from "./RunNow.tsx";
import { RunDock } from "./RunDock.tsx";
import { RunTask } from "./RunTask.tsx";
import { RunTurn } from "./RunTurn.tsx";
import { RunNotes } from "./RunNotes.tsx";
import { RunGoal } from "./RunGoal.tsx";
import { RunUsage } from "./RunUsage.tsx";
import { RunResult } from "./RunResult.tsx";
import type { RunDetail, RunView as RunRecord } from "../types.ts";

const AGAIN_MS = 3000; // a refetch that failed while the view shows its last detail is tried again this much later
const FIRST_AGAIN_MS = 1000; // the second attempt for a run whose detail never arrived

export function RunView({ runId }: { runId: string }) {
  const r = useStore((s) => s.runs[runId]);
  const d = useStore((s) => s.runDetail[runId]);
  // The connection drops the detail when an event was lost and after every snapshot, until it has
  // fetched it again: the view goes on showing the last one it had.
  const last = useRef<RunDetail | null>(null);
  if (d) last.current = d; else if (last.current && last.current.run !== runId) last.current = null;
  // How many fetches failed in a row, and what the last one failed with. Behind a detail that
  // shows, the fetch is tried again for as long as it takes; for a run whose detail never arrived
  // it is tried twice, and then the user is asked.
  const [fails, setFails] = useState(0);
  const [why, setWhy] = useState("");
  const [again, setAgain] = useState(0);
  // on mount, and again whenever the detail went away
  useEffect(() => {
    if (d) { setFails(0); return; }
    let gone = false, timer = 0;
    void loadRun(runId).then(() => {
      if (gone || getState().runDetail[runId]) return;
      const n = fails + 1;
      setWhy(runLoadError(runId));
      setFails(n);
      if (last.current) timer = window.setTimeout(() => setAgain((k) => k + 1), AGAIN_MS); // quietly, behind what shows
      else if (n < 2) timer = window.setTimeout(() => setAgain((k) => k + 1), FIRST_AGAIN_MS);
    });
    return () => { gone = true; clearTimeout(timer); };
  }, [runId, !d, again]);
  const detail = d ?? last.current;
  if (!r) return null;
  if (!detail) {
    const retry = () => { setFails(1); setAgain((k) => k + 1); };
    return (
      <div className="run-view run-loading">
        {fails >= 2
          ? (
            <div className="run-unloaded" role="alert">
              <div className="note error">This run could not be loaded: {why || "the server did not answer"}</div>
              <div className="row-gap">
                <button type="button" className="btn sm" onClick={retry}>Retry</button>
                <button type="button" className="btn sm danger" onClick={() => deleteRun(r)}>Delete run…</button>
              </div>
            </div>
          )
          : <div className="typing"><span className="dots"><i /><i /><i /></span> Loading…</div>}
      </div>
    );
  }
  return <Follow key={runId} run={r} detail={detail} stale={!d && fails >= 2} />;
}

/** The view of one run. Everything the user set here (selection, dock, zoom, filter) is its own
 *  state and starts fresh with another run. */
function Follow({ run: r, detail, stale }: { run: RunRecord; detail: RunDetail; stale: boolean }) {
  const runId = r.id;
  // While the connection is down nothing here is known to be current: the clocks stop at the
  // moment it went, and the strip says so.
  const connected = useStore((s) => s.connected);
  const [asOf, setAsOf] = useState<number | null>(null);
  useEffect(() => { setAsOf(connected ? null : Date.now()); }, [connected]);
  const root = useRef<HTMLDivElement>(null), dockBody = useRef<HTMLDivElement>(null);
  const narrow = (useSize(root).w || 1000) < NARROW;
  const [v, setV] = useState<ViewState>(() => openingView(detail.status));
  const [rows, setRows] = useState<RowFilter>("all");
  const [ppm, setPpm] = useState<number | null>(null);
  const [follow, setFollow] = useState(() => isLive(detail));
  // A run that goes live again (a resume) is followed again.
  const live = isLive(detail);
  useEffect(() => { if (live) setFollow(true); }, [live]);
  const [legend, setLegend] = useState(false);
  const [dockH, setDockH] = useState<number | null>(() => loadUi().dockH ?? null);
  const [view, setView] = useState<TimelineView | null>(null);

  // The Related filter needs a selected task: without one the filter is All again.
  const selTask = v.sel && "task" in v.sel ? v.sel.task : null;
  useEffect(() => { if (selTask == null) setRows((x) => (x === "related" ? "all" : x)); }, [selTask]);
  const shownRows: RowFilter = rows === "related" && selTask == null ? "all" : rows;

  const selectTask = useCallback((id: string | null) => setV((s) => (id == null ? clearIn(s) : selectIn(s, { task: id }))), []);
  const selectTurn = useCallback((n: number | null) => setV((s) => (n == null ? clearIn(s) : selectIn(s, { turn: n }))), []);
  const pickTask = useCallback((id: string) => selectTask(id), [selectTask]);
  const pickTurn = useCallback((n: number) => selectTurn(n), [selectTurn]);
  // An agent's transcript opens beside the stage; the view stays as it is.
  const openAgent = useCallback((id: string) => openRunAgent(runId, id), [runId]);
  const transcript = useStore((s) => s.runAgent?.run === runId);
  const setTaskTab = useCallback((tab: TaskTab) => setV((s) => taskTabIn(s, tab)), []);
  // The notes version the Notes tab shows (null: the newest), so that a "rewrote the notes · v6" line can lead to it.
  const [notesAt, setNotesAt] = useState<number | null>(null);
  const openNotes = useCallback((n: number) => { setNotesAt(n); setV((s) => tabIn(s, "notes")); }, []);
  const openUsage = useCallback(() => setV((s) => tabIn(s, "usage")), []);
  const openResult = useCallback(() => setV((s) => tabIn(s, "result")), []);
  const onHeight = useCallback((px: number | null, done: boolean) => { setDockH(px); if (done) saveUi({ dockH: px ?? undefined }); }, []);

  // Enter in the timeline: the focus goes to the dock (opened, on the selection's tab when there is one).
  const wantFocus = useRef(false);
  const onEnter = useCallback(() => { wantFocus.current = true; setV((s) => tabIn(s, s.sel ? "entity" : s.tab)); dockBody.current?.focus(); }, []);
  useEffect(() => { if (wantFocus.current && dockBody.current) { wantFocus.current = false; dockBody.current.focus(); } });
  // The focus is never left on nothing: when what had it went away (a tab's ×, a link that led
  // elsewhere, the × of a transcript), the dock's body takes it, and without a dock the timeline.
  useEffect(() => {
    if (document.activeElement !== document.body && document.activeElement != null) return;
    (dockBody.current ?? root.current?.querySelector<HTMLElement>(".tl-scroll"))?.focus({ preventScroll: true });
  }, [transcript, v.sel, v.tab, v.dock]);

  // The timeline's keys work in the whole view: f + − 0 n anywhere, ↑ ↓ outside the dock's body (it
  // scrolls with them); none while the dock covers the timeline, and none typed into a field.
  const tlKeys = useRef<((e: ReactKeyboardEvent) => void) | null>(null);
  const onKeys = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (e.defaultPrevented || v.dock === "max" || t.closest(".tl-scroll, .menu") || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const arrow = e.key === "ArrowUp" || e.key === "ArrowDown";
    if (arrow ? t.closest(".dock-body") != null : !"f+=-−_0n".includes(e.key) || e.key.length !== 1) return;
    tlKeys.current?.(e);
  };

  // Esc steps back: the transcript beside the stage, a maximised dock, the selection, the dock
  // (the app's subagent drawer is above all of them and takes its own first). One listener, added
  // when the view opens (before any menu's), in the capture phase; the layers above the view take
  // theirs first, and Esc typed in a field or in a chat's panel is not the view's.
  const cur = useRef(v);
  cur.current = v;
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || escTaken(e) || document.querySelector(".sub-drawer, .menu")) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t?.closest(".composer-input, .name-input, input, textarea, select, [contenteditable='true']")) return;
      const shown = getState().runAgent?.run === runId; // a transcript's panel has nothing of its own for Esc
      if (!shown && t?.closest(".board-panel")) return;
      const next = escIn(cur.current, shown);
      if (!next) return;
      e.preventDefault(); e.stopPropagation();
      if (next === "transcript") closeRunAgent(); else setV(next);
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, []);

  const statusKey = useMemo(() => ({}), [r, detail.version]); // the next record of the run, or the next version of its detail
  // The wait is the run view's own (it is current between two turns; the detail's turns only say what was declared).
  const base = useMemo(() => timelineInput(detail), [detail]);
  const tl = useMemo(() => ({ ...base, wait: r.wait ?? null }), [base, r.wait]);
  // What each tier runs on, in the catalog's words, for the tooltips of the timeline's attempts.
  const cat = useStore((s) => s.catalogs[r.agent]);
  const tiers = useMemo<TierNames>(() => Object.fromEntries(TIERS.map((k) => {
    const c = r.tiers[k], m = cat?.models.find((x) => x.id === c.model);
    return [k, { model: modelLabel(c, cat), effort: c.effort ? effortLabel(c.effort, m) : null }];
  })), [r.tiers, cat]);
  // The filter's counts, at once (the timeline reports its own a render later).
  const counts = useMemo(() => rowCounts(tl, selTask), [tl, selTask]);
  // The meters' task counts, from the detail the timeline is drawn from.
  const headRun = useMemo(() => ({ ...r, counts: taskCounts(tl.tasks, r.counts) }), [r, tl.tasks]);
  const headView = useMemo(() => (view ? { ...view, counts } : null), [view, counts]);
  const sel = useMemo(() => (v.sel == null ? null : "task" in v.sel ? { task: v.sel.task } : { turn: v.sel.turn }), [v.sel]);

  const task = selTask != null ? detail.tasks.find((t) => t.id === selTask) : undefined;
  const turnN = v.sel && "turn" in v.sel ? v.sel.turn : null;
  const turn = turnN != null ? detail.turns.find((t) => t.n === turnN) : undefined;
  const entity = selTask != null ? selTask : turnN != null ? `Turn ${turnN}` : null;
  let body: ReactNode;
  if (v.dock === "closed") body = null;
  else if (v.tab === "entity") {
    body = task ? <RunTask key={task.id} runId={runId} task={task} detail={detail} tab={v.taskTab} onTab={setTaskTab} onOpenAgent={openAgent} onSelectTask={pickTask} onSelectTurn={pickTurn} />
      : turn ? <RunTurn key={turn.n} runId={runId} turn={turn} detail={detail} onOpenAgent={openAgent} onSelectTask={pickTask} onOpenNotes={openNotes} />
      : <div className="note">{entity} is not in this run.</div>;
  } else if (v.tab === "notes") body = <RunNotes runId={runId} detail={detail} at={notesAt} onAt={setNotesAt} />;
  else if (v.tab === "goal") body = <RunGoal runId={runId} detail={detail} />;
  else if (v.tab === "usage") body = <RunUsage runId={runId} detail={detail} />;
  else body = <RunResult runId={runId} detail={detail} onSelectTurn={pickTurn} />;

  return (
    <div className={`run-follow${narrow ? " narrow" : ""}`} ref={root} data-run={runId} onKeyDown={onKeys}>
      <Guard what="the run's status" resetKey={statusKey}>
        <RunHead run={headRun} stops={detail.stops} view={headView} rows={shownRows} follow={follow} legend={legend} tools={v.dock !== "max"} narrow={narrow}
          onRows={setRows} onZoom={setPpm} onFollow={setFollow} onLegend={setLegend} onUsage={openUsage} />
        <RunNow run={r} detail={detail} asOf={asOf} onResult={openResult} />
      </Guard>
      {stale && connected && <div className="run-stale note" role="status">Not up to date: the run could not be reloaded. Retrying…</div>}
      <div className="run-body">
        <div className="run-tl">
          <Guard what="the timeline" resetKey={detail.version}>
            <Timeline key={runId} run={tl} sel={sel} rows={shownRows} ppm={ppm} follow={follow} legend={legend} tiers={tiers} now={asOf ?? undefined}
              onSelectTask={selectTask} onSelectTurn={selectTurn} onRows={setRows} onZoom={setPpm} onFollow={setFollow} onLegend={setLegend}
              onEnter={onEnter} onView={setView} keys={tlKeys} />
          </Guard>
        </div>
        <RunDock tab={v.tab} state={v.dock} entity={entity} notes={detail.notes[detail.notes.length - 1]?.v ?? 0} result={!!detail.result || !!detail.delivery}
          height={dockH} bodyRef={dockBody}
          onTab={(tab: DockTab) => setV((s) => tabIn(s, tab))} onCloseEntity={() => setV(clearIn)} onState={(state: DockState) => setV((s) => dockIn(s, state))} onHeight={onHeight}>
          <Guard what="these details" resetKey={`${v.tab}|${entity}|${detail.version}`}>{body}</Guard>
        </RunDock>
      </div>
    </div>
  );
}
