// The run timeline: the orchestrator's turns on a lane, one row per task with its waits, attempts
// and marks, the dependency connectors and the now line. It draws what logic/runtimeline.ts lays
// out and is a pure function of its props plus its own scroll position, hover and measured width:
// no store, no connection. The row filter, the zoom, follow and the legend are the parent's state
// (its toolbar drives them too); mount it with a key per run, so that a new run starts fresh.
// Violet is what the orchestrator did: its turns, the block over the rows a turn added, the marks
// where it changed a task, the dotted line while it waits. What a task needs is written in its label.
import { Fragment, memo, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import "./timeline.css";
import { fmtDuration } from "../logic/subagents.ts";
import { K, LEGEND, STATES, addingTurn, directEdges, gapLabels, isLive, relatedSide, laneTailSentence, layoutTimeline, tailSentence,
  type Layout, type TLAxis, type TLEdge, type TLLaneTail, type TLLaneWait, type TLLegendItem, type TLMark, type TLRow, type TLSeg, type TLTail, type TLTurnBar } from "../logic/runtimeline.ts";
import { fitPpm, fitZoom, followAfterScroll, followLeft, followOffset, kindShown, labelWidth, needsShown, relayoutDue, resolveZoom, revealLeft,
  rowCounts, rowFilter, scrollFor, stepIn, timeAt, zoomIn, zoomOut, type RowFilter } from "../logic/runzoom.ts";
import { clockTime, dateTime, lastMoment, rowLabel, runEnd, taskFacts, taskTip, tickText, turnLabel, turnTip,
  type TaskFacts, type TierNames, type TimelineRun, type TimelineTask, type TimelineTurn, type Tip } from "../logic/runlabels.ts";

export type { TimelineRun } from "../logic/runlabels.ts";
export type { RowFilter } from "../logic/runzoom.ts";

/** What the toolbar outside the timeline needs to draw itself. */
export interface TimelineView {
  /** The zoom at which the whole run fits, and the zoom shown (px per minute). */
  fitPpm: number; ppm: number;
  /** The whole run is shown. */
  fit: boolean;
  canZoomIn: boolean; canZoomOut: boolean;
  /** Rows each filter leaves; `related` is null without a selected task. */
  counts: { all: number; open: number; related: number | null };
}

export interface TimelineProps {
  /** The run; a new object when anything in it changed. */
  run: TimelineRun;
  /** The selection: a task or a turn. */
  sel: { task?: string; turn?: number } | null;
  /** The row filter; "related" needs a selected task, else it is "all". */
  rows: RowFilter;
  /** px per minute. null is automatic: the whole run, and for a live run LIVE_PPM once the whole
   *  run would be smaller than that. A zoom at or below fit shows the whole run (ZOOM_FIT: always). */
  ppm: number | null;
  /** Keep now in view (live runs). */
  follow: boolean;
  /** The legend popover is open. */
  legend: boolean;
  /** What each tier runs on (model and effort names), for the tooltip of a task's attempts. */
  tiers?: TierNames | null;
  /** A fixed "now" (tests; the moment the connection was lost). Left out: the component's own
   *  clock while the run is live, the run's end otherwise. */
  now?: number;
  /** Set to the component's key handler, for a parent that passes on keys typed outside it. */
  keys?: { current: ((e: ReactKeyboardEvent) => void) | null };
  /** null: clear (a click on empty chart). */
  onSelectTask(id: string | null): void;
  onSelectTurn(n: number | null): void;
  /** Key `f`. */
  onRows(rows: RowFilter): void;
  /** Keys `0` `+` `−` and ⌘/Ctrl + wheel. */
  onZoom(ppm: number | null): void;
  /** Key `n` (true); false when the user scrolls now out of view or zooms at the pointer, and when
   *  a selection made outside the timeline has its marks out of view (they are scrolled in). */
  onFollow(on: boolean): void;
  /** The legend closes itself: Esc, a click outside it. */
  onLegend(on: boolean): void;
  /** Key Enter: the parent moves focus to the selection's details. */
  onEnter?(): void;
  /** Called when a value of the view changes. */
  onView?(v: TimelineView): void;
}

const HEAD_H = K.RULER + K.LANE + 1; // The sticky header, with its bottom border.
const px = (n: number) => Math.round(n * 10) / 10;

/** A value outside React state: what changes often (the clock, the tooltip) re-renders only the
 *  few components that read it. */
interface Cell<T> { get(): T; set(v: T): void; subscribe(f: () => void): () => void }
function cell<T>(value: T): Cell<T> {
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v) { if (!Object.is(v, value)) { value = v; for (const f of [...subs]) f(); } },
    subscribe(f) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
const useCell = <T,>(c: Cell<T>): T => useSyncExternalStore(c.subscribe, c.get);

/** The tooltip to show: what it describes, the pointer's x and the top and bottom of the row or
 *  bar under it, all from the timeline's top-left corner; for a task also where the chart starts. */
type TipAt = { task?: string; turn?: number; x: number; top: number; bottom: number; chart?: number };
/** What the tooltip needs to make its words when it opens. */
interface TipCtx {
  tasks: Map<string, TimelineTask>; turns: Map<number, TimelineTurn>; facts: Map<string, TaskFacts>;
  rows: Map<string, TLRow>; run: TimelineRun; live: boolean; tz: number; tiers: TierNames | null;
}

export function Timeline(props: TimelineProps) {
  const { run, sel, rows, ppm, follow, legend } = props;
  const selTask = sel?.task ?? null, selTurn = selTask == null ? sel?.turn ?? null : null;
  const live = isLive(run), uid = useId();
  const rootRef = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [boxH, setBoxH] = useState(0); // the scroller's height: when the dock opens over the selected row, the row is brought back
  const [, relayout] = useReducer((n: number) => n + 1, 0);

  // ---- time. `cur` is now; the layout keeps its own, older by less than a quantum (half a pixel),
  // so that a tick of the clock re-renders only the texts that count seconds.
  const own = props.now == null && live;
  const [clock] = useState(() => cell(props.now ?? (live ? Date.now() : runEnd(run))));
  // Its own clock is never behind the run: what the record holds is drawn at once, also when this
  // machine's clock is behind the server's.
  const end = useMemo(() => runEnd(run), [run]), floor = useMemo(() => (own ? lastMoment(run) : 0), [own, run]);
  const cur = props.now ?? (live ? Math.max(clock.get(), floor) : end);
  const laid = useRef({ run, now: cur, ppm: 1 });
  if (laid.current.run !== run || cur < laid.current.now || relayoutDue(laid.current.now, cur, laid.current.ppm)) laid.current = { ...laid.current, run, now: cur };
  const layoutNow = laid.current.now;
  useLayoutEffect(() => { if (!own) clock.set(cur); }, [own, cur, clock]);
  useEffect(() => {
    if (!own) return;
    const tick = () => { clock.set(Math.max(Date.now(), latest.current.floor)); if (relayoutDue(laid.current.now, clock.get(), laid.current.ppm)) relayout(); };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [own, clock]);

  // ---- the layout, for the measured width
  useLayoutEffect(() => {
    const el = scroller.current!;
    // (a timeline that is hidden measures 0: it keeps its last width, its rows and its scroll position)
    const measure = () => { const w = el.clientWidth; if (w) { setWidth(w); setBoxH(el.clientHeight); } };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const labelW = labelWidth(width), chartW = Math.max(0, width - labelW);
  const tz = -new Date(layoutNow).getTimezoneOffset();
  const fit = useMemo(() => fitPpm(run, chartW, layoutNow), [run, chartW, layoutNow]);
  const zoom = resolveZoom(ppm, fit, live);
  laid.current.ppm = zoom.ppm;
  const relatedTo = rows === "related" ? selTask : null;
  const only = useMemo(() => rowFilter(run, rows, relatedTo), [run, rows, relatedTo]);
  const L = useMemo(() => {
    if (!width) return null;
    return layoutTimeline(run, { width: chartW, ppm: zoom.layoutPpm, now: layoutNow, only, selTask, selTurn, tzOffsetMin: tz });
  }, [run, width, chartW, zoom.layoutPpm, layoutNow, only, selTask, selTurn, tz]);

  // A task's facts keep their identity from one run record to the next while they say the same,
  // so that a row whose task did not change is not rendered again.
  const lastFacts = useRef<Map<string, TaskFacts> | null>(null);
  const facts = useMemo(() => {
    const next = taskFacts(run), prev = lastFacts.current;
    if (prev) for (const [id, f] of next) { const p = prev.get(id); if (p && JSON.stringify(p) === JSON.stringify(f)) next.set(id, p); }
    return (lastFacts.current = next);
  }, [run]);
  const tasks = useMemo(() => new Map(run.tasks.map((t) => [t.id, t])), [run]);
  const turns = useMemo(() => new Map(run.turns.map((t) => [t.n, t])), [run]);
  const counts = useMemo(() => rowCounts(run, selTask), [run, selTask]);
  // The turns to stress: the selected one, or the one that added the selected task.
  const selected = selTask != null ? tasks.get(selTask) : undefined;
  const onTurn = selTurn ?? (selected ? addingTurn(selected) : null);

  // ---- what the handlers read: always the latest render's values
  const tiers = props.tiers ?? null;
  const tipCtx: TipCtx = useMemo(() => ({ tasks, turns, facts, rows: new Map((L?.rows ?? []).map((r) => [r.id, r])), run, live, tz, tiers }), [tasks, turns, facts, L, run, live, tz, tiers]);
  const at = { props, L, zoom, fit, live, labelW, chartW, floor };
  const latest = useRef(at);
  useLayoutEffect(() => { latest.current = at; });

  // ---- the toolbar's view of the timeline
  const sent = useRef("");
  useEffect(() => {
    if (!width) return;
    const v: TimelineView = { fitPpm: fit, ppm: zoom.ppm, fit: zoom.fit, canZoomIn: zoom.canZoomIn, canZoomOut: zoom.canZoomOut, counts };
    const key = JSON.stringify(v);
    if (key !== sent.current) { sent.current = key; props.onView?.(v); }
  });

  // ---- the tooltip: after 350 ms on a row or a turn bar, gone when the pointer leaves it
  const [tip] = useState(() => cell<TipAt | null>(null));
  const hover = useRef<{ key: string | null; timer: number; x: number; el: HTMLElement | null }>({ key: null, timer: 0, x: 0, el: null });
  const hideTip = (forget = true) => {
    const h = hover.current;
    clearTimeout(h.timer); tip.set(null);
    if (forget) h.key = null;
  };
  // The row under the pointer for 150 ms: its direct dependency edges are drawn (no layout is made).
  const [edgesOf] = useState(() => cell<string | null>(null));
  const over = useRef<{ id: string | null; timer: number }>({ id: null, timer: 0 });
  const overRow = (id: string | null) => {
    const o = over.current;
    if (id === o.id) return;
    clearTimeout(o.timer); o.id = id; edgesOf.set(null);
    if (id != null) o.timer = window.setTimeout(() => edgesOf.set(id), 150);
  };
  const onMouseMove = (e: ReactMouseEvent) => {
    const h = hover.current, t = e.target as HTMLElement;
    const bar = t.closest<HTMLElement>(".tl-turn"), row = bar ? null : t.closest<HTMLElement>(".tl-row");
    overRow(row?.dataset.id ?? null);
    const key = bar ? "turn " + bar.dataset.turn : row ? "task " + row.dataset.id : null;
    h.x = e.clientX; h.el = bar ?? row;
    if (key === h.key) return;
    hideTip(); h.key = key;
    if (key) h.timer = window.setTimeout(() => {
      const root = rootRef.current, el = h.el;
      if (!root || !el?.isConnected) return;
      // A row's tooltip opens beside the row, over the chart; a turn's under the whole header, so the lane stays readable.
      const o = root.getBoundingClientRect(), r = (el.closest(".tl-head") ?? el).getBoundingClientRect();
      const what = el.dataset.id != null ? { task: el.dataset.id, chart: latest.current.labelW } : { turn: Number(el.dataset.turn) };
      tip.set({ ...what, x: h.x - o.left, top: r.top - o.top, bottom: r.bottom - o.top });
    }, 350);
  };
  useEffect(() => () => { clearTimeout(hover.current.timer); clearTimeout(over.current.timer); }, []);

  // ---- scrolling. Only a scroll the user made can end following: ours are recorded as they are
  // made (`left`), so their scroll events find nothing changed.
  const scroll = useRef({ left: 0, top: 0, offset: null as number | null, offSent: false, wasFollow: false });
  const shown = useRef<{ axis: TLAxis; view: number } | null>(null); // The last layout put on screen.
  const anchor = useRef<{ t: number; x: number } | null>(null);      // The time to keep under the pointer across a zoom.
  // The last zoom at the pointer and where it left the chart: a further step from the same place
  // keeps the same time, so that the rounding of scrollLeft does not add up over the steps.
  const kept = useRef<{ t: number; x: number; left: number } | null>(null);
  const setLeft = (v: number) => {
    const el = scroller.current!;
    el.scrollLeft = v;
    scroll.current.left = el.scrollLeft;
  };
  useLayoutEffect(() => { scroll.current.offSent = false; }, [follow]);
  // After each layout: keep now in view while following; across a zoom keep a time in place (the
  // one under the pointer, else the one at the centre).
  useLayoutEffect(() => {
    if (!L) return;
    const s = scroll.current, prev = shown.current, keep = anchor.current;
    const zoomed = prev != null && Math.abs(prev.axis.ppm - L.axis.ppm) > 1e-6 * L.axis.ppm;
    anchor.current = null;
    if (follow && L.nowX != null && L.width > chartW) {
      if (!s.wasFollow || zoomed || prev?.view !== chartW) s.offset = null;
      setLeft(followLeft(L.nowX, s.offset ?? followOffset(chartW, L.axis.future)));
    } else if (prev && zoomed) {
      const x = keep?.x ?? chartW / 2;
      setLeft(scrollFor(L.axis, keep?.t ?? timeAt(prev.axis, s.left, prev.view / 2), x));
      kept.current = keep && { ...keep, left: s.left };
    }
    s.wasFollow = follow; shown.current = { axis: L.axis, view: chartW };
  }, [L, follow, chartW]);
  const onScroll = () => {
    const el = scroller.current!, s = scroll.current, c = latest.current;
    if (el.scrollTop !== s.top) { s.top = el.scrollTop; hideTip(); }
    if (el.scrollLeft === s.left) return;                       // Vertical only, or our own: a tooltip stays over its row.
    s.left = el.scrollLeft;
    hideTip(); markOff();
    if (!c.props.follow || c.L?.nowX == null || c.L.width <= c.chartW) return;
    const f = followAfterScroll(c.L.nowX, s.left, c.chartW);
    if (f.follow) s.offset = f.offset;
    else if (!s.offSent) { s.offSent = true; c.props.onFollow(false); }
  };

  // Zoomed in, a row whose marks are all left or right of what is in view says on which side
  // they are (`data-off`, a ‹ or › at that edge). Written to the rows as they are: a scroll renders nothing.
  const markOff = () => {
    const el = scroller.current, c = latest.current;
    if (!el || !c.L) return;
    const a = el.scrollLeft, b = a + c.chartW, rows = c.L.rows, wide = c.L.width > c.chartW;
    el.querySelectorAll<HTMLElement>(".tl-row").forEach((node, i) => {
      const r = rows[i];
      const off = !wide || !r ? "" : (r.tail ? c.L!.width : r.endX + 14) < a ? "l" : r.marks[0].x - 6 > b ? "r" : "";
      if ((node.dataset.off ?? "") !== off) { if (off) node.dataset.off = off; else delete node.dataset.off; }
    });
  };
  useLayoutEffect(markOff);

  // ⌘/Ctrl + wheel zooms by one step and keeps the time under the pointer where it is. (A wheel
  // listener that may cancel the event cannot be a React prop.)
  useEffect(() => {
    const el = scroller.current!;
    let sum = 0, last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const c = latest.current, t = performance.now();
      if (!c.L || t - last < 150) return;                       // One step at a time, also for a pinch.
      sum += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      if (Math.abs(sum) < 40) return;
      const next = sum < 0 ? zoomIn(c.zoom.ppm, c.fit) : zoomOut(c.zoom.ppm, c.fit, c.live);
      sum = 0;
      if (next === undefined) return;
      last = t;
      const x = Math.max(0, e.clientX - el.getBoundingClientRect().left - c.labelW), k = kept.current;
      anchor.current = { t: k && k.x === x && Math.abs(el.scrollLeft - k.left) < 1.5 ? k.t : timeAt(c.L.axis, el.scrollLeft, x), x };
      hideTip();
      c.props.onZoom(next);
      if (c.props.follow && c.live) c.props.onFollow(false);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- the legend: a popover under the toolbar's Legend button. Esc, a click outside it or the
  // button close it.
  useEffect(() => {
    if (!legend) return;
    const close = () => latest.current.props.onLegend(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    const onDocClick = (e: MouseEvent) => { if (!(e.target as Element).closest?.(".tl-legend")) close(); };
    document.addEventListener("keydown", onKey, true);
    // (not the click that opened it: that one is still on its way up)
    const t = setTimeout(() => document.addEventListener("click", onDocClick), 0);
    return () => { clearTimeout(t); document.removeEventListener("keydown", onKey, true); document.removeEventListener("click", onDocClick); };
  }, [legend]);

  // ---- bringing the selection into view. A row the user clicked is in view already; any other
  // change of the selection scrolls its row in (and its marks, unless now is being followed). A
  // selected turn brings in the first row it added. The row stays in view when the space changes
  // under it: the dock opens.
  const clicked = useRef<string | null>(null);
  const opened = useRef(false), lastSel = useRef("");
  const ready = L != null;
  useLayoutEffect(() => {
    const el = scroller.current, c = L;
    if (!el || !c) return;
    const key = `${selTask} ${selTurn}`;
    const first = !opened.current, byClick = clicked.current === key, selChanged = lastSel.current !== key;
    opened.current = true; clicked.current = null; lastSel.current = key;
    const row = selTask != null ? c.rows.find((r) => r.id === selTask) : undefined;
    const bar = selTurn != null ? c.turns.find((t) => t.n === selTurn) : undefined;
    const added = bar && c.selFirst != null ? c.rows.find((r) => r.id === c.selFirst) : undefined;
    const viewH = el.clientHeight - HEAD_H;
    const nearest = (r: TLRow | undefined = row) => {
      if (!r) return;
      if (r.y < el.scrollTop) el.scrollTop = r.y;
      else if (r.y + r.h > el.scrollTop + viewH) el.scrollTop = r.y + r.h - viewH;
    };
    // Only the row filter changed: the selected row is somewhere else now, and is kept in view.
    if (!first && !selChanged) { nearest(); return; }
    if (row && first) el.scrollTop = Math.max(0, row.y - (viewH - row.h) / 2);
    else if (row && !byClick) nearest();
    // (also for a click: a turn's bar is in the header, its rows can be anywhere)
    else if (added) nearest(added);
    else if (first && c.nowX != null) {
      // A live run opens with its first open row about 60 px under the header.
      const open = c.rows.find((r) => r.tail);
      if (open) el.scrollTop = Math.max(0, open.y - 60);
    }
    if (byClick || c.width <= chartW) return;
    const left = row ? revealLeft(row.marks[0].x - 10, row.endX + 18, el.scrollLeft, chartW) : bar ? revealLeft(bar.x1, bar.x2, el.scrollLeft, chartW) : null;
    if (left == null || Math.abs(left - el.scrollLeft) < 1) return;
    // While now is followed the next layout would scroll back: what was asked for from outside
    // wins, and following ends (the parent is told, once).
    if (follow && c.nowX != null) { scroll.current.offSent = true; props.onFollow(false); }
    setLeft(left);
  }, [selTask, selTurn, ready, rows, boxH]);
  // ↑ / ↓ from a turn bar: the focus goes with the selection.
  useEffect(() => {
    const el = scroller.current, a = document.activeElement;
    if (selTurn != null && el && a instanceof HTMLElement && a.classList.contains("tl-turn") && el.contains(a)) {
      el.querySelector<HTMLElement>(`.tl-turn[data-turn="${selTurn}"]`)?.focus({ preventScroll: true });
    }
  }, [selTurn]);

  // ---- pointer and keys
  const onClick = (e: ReactMouseEvent) => {
    const t = e.target as HTMLElement, p = props;
    hideTip(false);
    const turn = t.closest<HTMLElement>("[data-turn]"), row = t.closest<HTMLElement>("[data-id]");
    if (turn) { clicked.current = `null ${turn.dataset.turn}`; p.onSelectTurn(Number(turn.dataset.turn)); }
    // (an id in a needs cell selects that task, whose row may be out of view: not "clicked")
    else if (row) { if (row.classList.contains("tl-row")) clicked.current = `${row.dataset.id} null`; p.onSelectTask(row.dataset.id!); }
    else if (selTurn != null) p.onSelectTurn(null);
    else if (selTask != null) p.onSelectTask(null);
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const t = e.target as HTMLElement, p = props;
    if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    let did = true;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const by = e.key === "ArrowDown" ? 1 : -1;
      if (selTurn != null) { const n = stepIn((L?.turns ?? []).map((b) => b.n), selTurn, by); if (n != null && n !== selTurn) p.onSelectTurn(n); }
      else { const id = stepIn((L?.rows ?? []).map((r) => r.id), selTask, by); if (id != null && id !== selTask) p.onSelectTask(id); }
    } else if (e.key === "f") {
      if (rows === "related") p.onRows("all"); else if (counts.related != null) p.onRows("related");
    } else if (e.key === "0") p.onZoom(fitZoom(fit, live));
    else if (e.key === "+" || e.key === "=") { const z = zoomIn(zoom.ppm, fit); if (z !== undefined) p.onZoom(z); }
    else if (e.key === "-" || e.key === "−" || e.key === "_") { const z = zoomOut(zoom.ppm, fit, live); if (z !== undefined) p.onZoom(z); }
    else if (e.key === "n") {
      if (!live) return;
      // Already following: back to where following keeps now.
      if (follow && L?.nowX != null && L.width > chartW) { scroll.current.offset = null; setLeft(followLeft(L.nowX, followOffset(chartW, L.axis.future))); }
      p.onFollow(true);
    } else if (e.key === "Enter" && !t.closest("button")) p.onEnter?.();
    else did = false;
    if (did) { e.preventDefault(); hideTip(); }
  };

  if (props.keys) props.keys.current = onKeyDown;

  const active = selTask != null && tipCtx.rows.has(selTask) ? `${uid}-${selTask}` : undefined;
  const shownRows = L?.rows.length ?? 0, needs = needsShown(labelW);
  return (
    <div className="tl" ref={rootRef}>
      <div className="tl-scroll" ref={scroller} tabIndex={0} role="group" aria-label="Run timeline: the orchestrator's turns and the tasks"
        aria-activedescendant={active} onScroll={onScroll} onClick={onClick} onKeyDown={onKeyDown} onMouseMove={onMouseMove} onMouseLeave={() => { hideTip(); overRow(null); }}>
        {L && (
          <div className="tl-inner" style={{ width: labelW + L.width, "--tl-label": labelW + "px" } as CSSProperties}>
            <div className="tl-head">
              <div className="tl-corner" style={{ width: labelW }}>
                <div className="c-top">{shownRows < run.tasks.length ? `${shownRows} of ` : ""}{run.tasks.length} task{run.tasks.length === 1 ? "" : "s"}{shownRows < run.tasks.length || labelW < 230 ? "" : " · by turn added"}</div>
                <div className="c-lane">Orchestrator <span>{run.turns.length} turn{run.turns.length === 1 ? "" : "s"}</span></div>
              </div>
              <div className="tl-headchart" style={{ width: L.width }}>
                <Ruler L={L} clock={clock} tz={tz} />
                <Lane bars={L.turns} turns={turns} on={onTurn} live={live} tz={tz} tab={selTurn ?? L.turns[L.turns.length - 1]?.n ?? null}
                  achieved={run.status === "completed"} width={L.width} waits={L.waits} tail={L.laneTail} clock={clock} />
              </div>
            </div>
            <div className="tl-rows" role="listbox" aria-label={`${shownRows} task${shownRows === 1 ? "" : "s"}, in the order they were added`}
              style={{ minHeight: L.height }}>
              <Back L={L} left={labelW} on={onTurn} />
              {L.rows.map((r) => (
                <Row key={r.id} row={r} task={tasks.get(r.id)!} facts={facts.get(r.id)} domId={`${uid}-${r.id}`} labelW={labelW} needs={needs} selTask={selTask}
                  nowX={L.nowX} gutOn={r.first && r.turn != null && r.turn === onTurn} clock={clock} tz={tz} />
              ))}
              {!L.rows.length && (
                <div className="tl-empty" style={{ left: labelW, marginLeft: labelW, width: Math.min(460, chartW) }}>
                  <div>
                    {run.tasks.length ? <>No task is open: every task is done, failed or cancelled.</>
                      : live ? <><b>The orchestrator is reading the goal and planning the first tasks.</b><br />Tasks appear here as it adds them. They start when its turn ends.</>
                      : <>This run has no tasks.</>}
                  </div>
                </div>
              )}
              <div className="tl-fill" style={{ width: labelW }} />
              <Edges edges={L.edges} left={labelW} width={L.width} height={L.height} />
              <HoverEdges of={edgesOf} run={run} L={L} skip={selTask} left={labelW} />
            </div>
          </div>
        )}
      </div>
      <TipCard tip={tip} ctx={tipCtx} clock={clock} />
      {legend && <Legend live={live} />}
    </div>
  );
}

/** The clock times, the label of each stop break and the now pill. */
const Ruler = memo(function Ruler({ L, clock, tz }: { L: Layout; clock: Cell<number>; tz: number }) {
  // A label the now pill would cover is left out; its tick line stays.
  const covered = (x: number) => L.nowX != null && x + 36 > L.nowX - 32 && x < L.nowX + 32;
  // A break's pill that would run into the pill before it is shortened; its title says it all.
  const pills = gapLabels(L.axis.gaps);
  return (
    <div className="tl-ruler" aria-hidden="true">
      {L.ticks.map((t) => <div key={t.t} className="tl-tick" style={{ left: px(t.x) }} title={dateTime(t.t, tz)}>{covered(t.x) ? "" : tickText(t.t, tz)}</div>)}
      {pills.map(({ gap: g, x, text }) => text != null && (
        <div key={g.from} className="tl-gaplabel" style={{ left: px(x) }} title={`${g.reason === "app_quit" ? "The app was closed" : "Stopped"} ${dateTime(g.from, tz)}, resumed ${dateTime(g.to, tz)}`}>{text}</div>
      ))}
      {L.nowX != null && <NowTag x={L.nowX} clock={clock} tz={tz} />}
    </div>
  );
});

function NowTag({ x, clock, tz }: { x: number; clock: Cell<number>; tz: number }) {
  const now = useCell(clock);
  return <div className="tl-nowtag" style={{ left: px(x) }} title={dateTime(now, tz)}>now {clockTime(now, tz)}</div>;
}

/** The orchestrator lane: a button per turn, its number, and what it did under it. */
const Lane = memo(function Lane({ bars, turns, on, live, tz, tab, achieved, width, waits, tail, clock }: {
  bars: TLTurnBar[]; turns: Map<number, TimelineTurn>; on: number | null; live: boolean; tz: number; tab: number | null; achieved: boolean; width: number;
  waits: TLLaneWait[]; tail: TLLaneTail | null; clock: Cell<number>;
}) {
  // A number that goes after its bar: there, or before the bar when the chart ends first and the
  // turn before leaves the room, else nowhere.
  const numLeft = (b: TLTurnBar, i: number) => {
    const w = String(b.n).length * K.NUM_W;
    if (b.x2 + 2 + w <= width) return b.x2 + 2;
    return (bars[i - 1]?.x2 ?? 0) + 4 <= b.x1 - 2 - w ? b.x1 - 2 - w : null;
  };
  // ⚠ is a refused call; the ⚑ that completed the run is green, like its end line.
  const tone = (glyph: string) => (glyph === "⚠" ? " refused" : glyph === "⚑" && achieved ? " fin" : "");
  return (
    <div className="tl-lane">
      {/* between two turns: the dotted line of the wait, the awaited ids on it where they fit
          (after the number of a short bar, which takes its room first) */}
      {waits.map((w) => w.x2 - w.x1 - w.numW >= K.WAIT_MIN && (
        <span key={w.after} className={"tl-lwait" + (w.open ? " open" : "")} aria-hidden="true" style={{ left: px(w.x1 + w.numW), width: px(w.x2 - w.x1 - w.numW) }}>{w.label && <b>{w.label}</b>}</span>
      ))}
      {bars.map((b, i) => {
        // (the running turn's number is in the lane tail, which starts where it would stand)
        const turn = turns.get(b.n), after = b.num === "after" && tail?.turn !== b.n ? numLeft(b, i) : null;
        // A turn with no end reads as running in the layout; it runs only while the run is live.
        const cls = `tl-turn st-${b.status}${b.status === "running" && live ? " run" : ""}${b.n === on ? " on" : ""}${b.idle ? " idle" : ""}${b.early ? " early" : ""}`;
        return (
          <Fragment key={b.n}>
            <button type="button" className={cls} data-turn={b.n} tabIndex={b.n === tab ? 0 : -1} style={{ left: px(b.x1), width: px(b.x2 - b.x1) }}
              aria-label={turn ? turnLabel(turn, { live, tz, before: turns.get(b.n - 1) }) : `Turn ${b.n}`} aria-pressed={b.n === on}>{b.status === "failed" ? (b.num === "in" && b.x2 - b.x1 >= String(b.n).length * K.NUM_W + 14 ? `! ${b.n}` : "!") : b.num === "in" ? b.n : ""}</button>
            {after != null && <span className="tl-turnnum" aria-hidden="true" style={{ left: px(after) }}>{b.n}</span>}
            {b.opsMode === "summary" && <span className="tl-opsum" aria-hidden="true" style={{ left: px(b.x1) }}>{b.summary.split(" ").map((s, i) => <span key={i} className={tone(s[0]).trim() || undefined}>{i > 0 && " "}{s}</span>)}</span>}
          </Fragment>
        );
      })}
      {tail && <LaneTail tail={tail} clock={clock} />}
    </div>
  );
});

/** Right of now in the lane: what the orchestrator waits for, or the turn it is in and for how long. */
function LaneTail({ tail, clock }: { tail: TLLaneTail; clock: Cell<number> }) {
  const now = useCell(clock);
  return <span className="tl-lanetail" style={{ left: px(tail.x) }}>{laneTailSentence(tail, now)}</span>;
}

/** Behind the rows: the selected turn's band, the block of each group of rows over the time of the
 *  turn that added them, the grid lines, the stop breaks, the tint right of now and the
 *  now line, or the end line of a run that is not live. */
const Back = memo(function Back({ L, left, on }: { L: Layout; left: number; on: number | null }) {
  return (
    <div className="tl-back" aria-hidden="true" style={{ left, width: L.width }}>
      {L.turns.map((t) => t.n === on && <div key={t.n} className="tl-band on" style={{ left: px(t.x1), width: px(t.x2 - t.x1) }} />)}
      {L.groups.map((g) => <div key={g.turn + " " + g.y1} className={"tl-addband" + (g.turn === on ? " on" : "")} style={{ left: px(g.x1), width: px(Math.max(4, g.x2 - g.x1)), top: g.y1 + 1, height: g.y2 - g.y1 - 1 }} />)}
      {L.ticks.map((t) => <div key={t.t} className="tl-grid" style={{ left: px(t.x) }} />)}
      {L.axis.gaps.map((g) => <div key={g.from} className="tl-gap" style={{ left: px(g.x1), width: px(g.x2 - g.x1) }} />)}
      {L.nowX != null && <><div className="tl-future" style={{ left: px(L.nowX) }} /><div className="tl-nowline" style={{ left: px(L.nowX) }} /></>}
      {L.end && <div className={`tl-endline st-${L.end.status}`} style={{ left: px(L.end.x) }} />}
    </div>
  );
});

/** The state mark of the vocabulary: a glyph, a pulsing dot for a task at work, ‖ for one a halted
 *  run interrupted. */
function Mark({ row }: { row: TLRow }) {
  const v = STATES[row.state];
  if (row.paused) return <span className="tl-mark tone-muted">‖</span>;
  return <span className={`tl-mark tone-${v.tone}`}>{v.pulse ? <i className="sub-dot" /> : v.glyph}</span>;
}

function Seg({ s }: { s: TLSeg }) {
  if (s.k !== "bar") return <div className={`tl-wait k-${s.k}`} style={{ left: px(s.x1), width: px(s.x2 - s.x1) }} />;
  const cls = `tl-bar${s.outcome ? " o-" + s.outcome : ""}${s.open && !s.paused ? " open" : ""}${s.paused ? " paused" : ""}${s.conflicts ? " conf" : ""}`;
  return (
    <>
      <div className={cls} style={{ left: px(s.x1), width: px(s.x2 - s.x1) }}>
        {s.parts.map((p, i) => <span key={i} className={`p k-${p.k}`} style={{ width: px(p.x2 - p.x1) }} />)}
        {s.mergeCap && <span className="mcap" />}
      </div>
      {s.pauses.map((g, i) => <div key={i} className="tl-pause" style={{ left: px(g.x1 + 1), width: px(g.x2 - g.x1 - 2) }} />)}
    </>
  );
}

/** The text right of now on an open row. It alone follows the clock every second. */
function Tail({ tail, clock }: { tail: TLTail; clock: Cell<number> }) {
  const now = useCell(clock);
  return <span className={`tl-tail ${tail.tone}`} style={{ left: px(tail.x) }}>{tailSentence(tail, now)}</span>;
}

/** A mark's classes. The ✕ that ends a cancelled attempt is the orchestrator's (or a chat's) doing,
 *  like ~ and ↻: `k-cancel`. */
const markClass = (m: TLMark) => `k-${m.kind}${m.outcome ? " o-" + m.outcome : ""}${m.kind === "end" && m.outcome === "cancelled" ? " k-cancel" : ""}`;

interface RowProps {
  row: TLRow; task: TimelineTask; facts: TaskFacts | undefined; domId: string; labelW: number; needs: boolean; selTask: string | null; gutOn: boolean;
  /** Where now is, for the dot of a row the orchestrator waits for. */
  nowX: number | null; clock: Cell<number>; tz: number;
}
/** A row as it is drawn: its numbers to the tenth of a pixel (two layouts of the same thing differ
 *  in the last bits of their x). */
const drawn = (row: TLRow) => JSON.stringify(row, (_k, v) => (typeof v === "number" ? px(v) : v));
/** Every layout makes its rows anew: a row is the same when it draws the same. */
const sameRow = (a: RowProps, b: RowProps): boolean =>
  a.task === b.task && a.facts === b.facts && a.domId === b.domId && a.labelW === b.labelW && a.needs === b.needs && a.nowX === b.nowX && a.selTask === b.selTask && a.gutOn === b.gutOn && a.clock === b.clock && a.tz === b.tz
  && (a.row === b.row || drawn(a.row) === drawn(b.row));

/** One task: its label (sticky on the left) and its chart cell. */
const Row = memo(function Row({ row, task, facts, domId, labelW, needs, selTask, gutOn, nowX, clock, tz }: RowProps) {
  const label = useMemo(() => rowLabel(task, facts, { paused: row.paused, tz }), [task, facts, row.paused, tz]);
  const far = row.rel === "up" || row.rel === "down";
  const cls = `tl-row st-${row.state}${row.first ? " first" : ""}${row.sel ? " sel" : ""}${row.dim ? " dim" : ""}${far ? " far" : ""}`;
  const numbered = row.first && row.turn != null;
  return (
    <div className={cls} role="option" id={domId} aria-selected={!!row.sel} aria-label={label} data-id={row.id}>
      <div className="tl-label" aria-hidden="true" style={{ width: labelW }}>
        {numbered ? <span className={"tl-gut" + (gutOn ? " on" : "")} data-turn={row.turn} title={`Added in turn ${row.turn}`}>{row.turn}</span> : <span className="tl-gut" />}
        <Mark row={row} />
        <span className="tl-id">{task.id}</span>
        {kindShown(labelW) && task.kind && <span className="tl-kind">{task.kind}</span>}
        <span className="tl-title" dir="auto">{task.title}</span>
        {row.touched && <span className="tl-touch">{row.touched}</span>}
        {row.waited && <span className="tl-tag">waited for</span>}
        {row.woke && <span className="tl-tag">woke it</span>}
        {row.rel === "dep" && <span className="tl-tag">→ {selTask}</span>}
        {row.rel === "dependent" && <span className="tl-tag">← {selTask}</span>}
        {needs && <span className={`tl-tier${row.tier ? " t-" + row.tier.word : ""}${row.tier?.mixed ? " mixed" : ""}`} title={row.tier?.title}>{row.tier?.word}</span>}
        {needs && (
          <span className="tl-needs" title={row.needs?.title}>
            {row.needs && <><i>←</i>{row.needs.ids.map((d) => <b key={d.id} className={`n-${d.tone}`} data-id={d.id}>{d.id}</b>)}{row.needs.more > 0 && <em className={`n-${row.needs.moreTone ?? "done"}`}>+{row.needs.more}</em>}</>}
          </span>
        )}
      </div>
      <div className="tl-cell" aria-hidden="true">
        {row.segs.map((s, i) => <Seg key={i} s={s} />)}
        {row.marks.map((m, i) => (
          <span key={i} className={`tl-m ${markClass(m)}`} style={{ left: px(m.x) }}>{m.glyph}{m.tier ? <span className="tr">{m.tier}</span> : null}{m.conflicts ? <span className="cf">⚠</span> : null}</span>
        ))}
        {row.awaited && nowX != null && <span className="tl-await" style={{ left: px(nowX) }} />}
        {row.tail && <Tail tail={row.tail} clock={clock} />}
      </div>
    </div>
  );
}, sameRow);

const LEVELS = { base: 0, far: 1, direct: 2 };
/** The dependency connectors, over the rows; the direct ones of a selected task on top. */
const Edges = memo(function Edges({ edges, left, width, height, hover }: { edges: TLEdge[]; left: number; width: number; height: number; hover?: boolean }) {
  const half = (n: number) => Math.round(n * 2) / 2;
  const sorted = useMemo(() => [...edges].sort((a, b) => LEVELS[a.level] - LEVELS[b.level]), [edges]);
  return (
    <svg className={"tl-edges" + (hover ? " hover" : "")} aria-hidden="true" style={{ left }} width={width} height={height}>
      {sorted.map((e) => {
        const cls = `k-${e.kind} lv-${e.level}`, a = e.arrow;
        return (
          <g key={e.from + " " + e.to}>
            <path className={cls} d={e.points.map((p, i) => `${i ? "L" : "M"}${half(p[0])} ${half(p[1])}`).join(" ")} />
            {e.dot && <circle className={`lv-${e.level}`} cx={px(e.dot[0])} cy={e.dot[1]} r={e.level === "direct" ? 2.6 : 2} />}
            {a && <path className={cls} d={`M${px(a[0] - 3)} ${a[1] - 3} L${px(a[0])} ${a[1]} L${px(a[0] - 3)} ${a[1] + 3}`} />}
          </g>
        );
      })}
    </svg>
  );
});

/** The direct edges of the row the pointer rests on, in the style of a selected task's, over the
 *  resting ones. Nothing is dimmed and nothing is laid out again. */
function HoverEdges({ of, run, L, skip, left }: { of: Cell<string | null>; run: TimelineRun; L: Layout; skip: string | null; left: number }) {
  const id = useCell(of);
  const edges = useMemo(() => (id == null || id === skip ? [] : directEdges(run, L.rows, L.axis, id, L.axis.t1)), [id, skip, run, L]);
  return edges.length ? <Edges edges={edges} left={left} width={L.width} height={L.height} hover /> : null;
}

/** The tooltip card. A turn's opens under the header (above when there is no room); a task's
 *  beside its row, over the chart: at the chart's left edge, or right of the pointer when that
 *  would put it under the pointer. A task whose direct edges all go to rows below it has the card
 *  above its row, and one whose edges all go up has it below, when there is room, so the card does
 *  not cover the rows it names. It stays inside the timeline. */
function TipCard({ tip, ctx, clock }: { tip: Cell<TipAt | null>; ctx: TipCtx; clock: Cell<number> }) {
  const at = useCell(tip), ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current, box = el?.parentElement;
    if (!el || !box || !at) return;
    const w = el.offsetWidth, h = el.offsetHeight, bw = box.clientWidth, bh = box.clientHeight;
    const below = at.bottom + 6, above = at.top - 6 - h;
    const beside = at.chart != null && bw - at.chart >= w + 16;      // (a chart too narrow for it: as a turn's)
    const side = beside && at.task != null ? relatedSide(ctx.run, ctx.rows, at.task) : null;
    const clear = side === "below" ? at.top - 4 - h : side === "above" ? at.bottom + 4 : null; // off the rows its edges go to
    const top = clear != null && clear >= HEAD_H + 4 && clear + h <= bh - 4 ? clear
      : beside ? Math.max(HEAD_H + 4, Math.min(at.top - 4, bh - 4 - h)) : below + h <= bh - 4 ? below : above >= 4 ? above : Math.max(4, bh - 4 - h);
    const left = beside && at.x < at.chart! + 8 + w + 12 ? Math.max(at.chart! + 8, at.x + 14) : beside ? at.chart! + 8 : at.x + 12;
    el.style.left = `${Math.max(4, Math.min(left, bw - 4 - w))}px`;
    el.style.top = `${top}px`;
    el.style.visibility = "visible";
  });
  if (!at) return null;
  const o = { now: clock.get(), stops: ctx.run.stops, live: ctx.live, tz: ctx.tz, tiers: ctx.tiers };
  const task = at.task != null ? ctx.tasks.get(at.task) : undefined, turn = at.turn != null ? ctx.turns.get(at.turn) : undefined;
  const t: Tip | null = task ? taskTip(task, ctx.facts.get(task.id), { ...o, paused: ctx.rows.get(task.id)?.paused }) : turn ? turnTip(turn, { ...o, before: ctx.turns.get(turn.n - 1) }) : null;
  if (!t) return null;
  return (
    <div className="tl-tip" ref={ref} aria-hidden="true" style={{ visibility: "hidden" }}>
      <div className="h">{t.head}</div>
      {t.lines.map((line, i) => <div key={i} className="r">{line.map((part, k) => (typeof part === "string" ? part : <b key={k}>{part.b}</b>))}</div>)}
    </div>
  );
}

/** The swatch of a legend entry: the thing itself, drawn with the timeline's own classes. */
function Sample({ it }: { it: TLLegendItem }) {
  const line = (k: string) => <i><span className={`tl-wait k-${k}`} /></i>;
  switch (it.sample) {
    case "turn": return <i><span className="lg-turn" /></i>;
    case "turn-idle": return <i><span className="lg-turn idle" /></i>;
    case "turn-early": return <i><span className="lg-turn early" /></i>;
    case "add": return <i><span className="lg-add" /><span className="lg-dia">{it.glyph}</span></i>;
    case "marks": return <>{(it.glyph ?? "").split(" ").map((g) => <span key={g} className="lg-m">{g}</span>)}</>;
    case "wait": return <i><span className="tl-lwait" /></i>;
    case "await": return <span className="tl-await" />;
    case "queued": case "deps": case "blocked": return line(it.sample);
    case "working": return <i><span className="tl-bar open" /></i>;
    case "merged": return <i><span className="tl-bar"><span className="p" style={{ width: 12 }} /><span className="p k-merge" style={{ width: 6 }} /></span></i>;
    case "failed": return <i><span className="tl-bar o-failed" /></i>;
    case "paused": return <><i><span className="tl-bar paused" /></i><span className="m">{it.glyph}</span></>;
    case "release": return <svg className="dep" width="14" height="12" viewBox="0 0 14 12"><path d="M7 0V8" /><circle cx="7" cy="8" r="2" /></svg>;
    case "warn": return <span className="w">{it.glyph}</span>;
  }
}

/** What the marks mean: a popover under the toolbar's Legend button. */
const Legend = memo(function Legend({ live }: { live: boolean }) {
  return (
    <div className={`tl-legend pop${live ? "" : " still"}`} role="note" aria-label="Legend: what the marks mean">
      {LEGEND.map((g) => (
        <Fragment key={g.head}>
          <div className="lg-h">{g.head}</div>
          {g.lines.map((items, i) => (
            <div key={i} className="lg-l">{items.map((it, k) => <span key={k}>{k > 0 && <span className="lg-sep">·</span>}<Sample it={it} />{it.text}</span>)}</div>
          ))}
        </Fragment>
      ))}
    </div>
  );
});
