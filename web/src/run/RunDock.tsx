// The dock under a run's timeline: the tabs of the run (Goal, Notes, Usage, Result), one more
// for what is selected (a task or a turn), and the body they show. Closed it is its tab bar
// alone; open it has a height the user drags; maximised it lies over the timeline.
import { useEffect, useRef, type ReactNode, type Ref, type PointerEvent as ReactPointerEvent } from "react";
import "./dock.css";
import { dockHeight, type DockState, type DockTab, type RunTab } from "../logic/runview.ts";
import { useSize } from "./actions.ts";

export interface RunDockProps {
  /** The tab shown, and the dock's state. */
  tab: DockTab;
  state: DockState;
  /** The entity tab: what is selected ("T21", "Turn 5"); null for none. */
  entity: string | null;
  /** The latest notes version (0: none yet), and whether the run has something for the Result tab
   *  (a result, or a delivery to apply). The tab shows whenever it is the open one, too. */
  notes: number;
  result: boolean;
  /** The open dock's height as the user set it, in px; null: 46% of the area it shares with the timeline. */
  height: number | null;
  /** The body element: it takes the focus (tabIndex −1). */
  bodyRef?: Ref<HTMLDivElement>;
  onTab(tab: DockTab): void;
  /** The entity tab's ×: the selection is cleared. */
  onCloseEntity(): void;
  onState(state: DockState): void;
  /** The handle was dragged to `px` (done: released); null: a double-click, back to the default. */
  onHeight(px: number | null, done: boolean): void;
  children: ReactNode;
}

const TABS: [RunTab, string][] = [["goal", "Goal"], ["notes", "Notes"], ["usage", "Usage"], ["result", "Result"]];

export function RunDock({ tab, state, entity, notes, result, height, bodyRef, onTab, onCloseEntity, onState, onHeight, children }: RunDockProps) {
  const root = useRef<HTMLDivElement>(null);
  const area = useSize(root, (el) => el.parentElement).h; // what the dock shares with the timeline
  // Without a height of the user's the dock takes 46% of the area as it is when it first shows, and
  // keeps that: the area changes whenever the strip above the timeline wraps, and the dock must
  // not move with it.
  const auto = useRef<number | null>(null);
  if (height != null) auto.current = null;
  else if (auto.current == null && area && state !== "closed") auto.current = dockHeight(null, area);
  const h = dockHeight(height ?? auto.current, area);
  // The handle on the top edge: the Resizer's pointer logic, turned upright.
  const drag = useRef<{ y: number; h: number; last: number } | null>(null);
  const end = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    document.body.classList.remove("resizing", "resizing-y");
    e.currentTarget.classList.remove("active");
    onHeight(d.last, true);
  };
  // a dock that goes away while it is dragged (another run is opened) leaves no cursor behind
  useEffect(() => () => { if (drag.current) document.body.classList.remove("resizing", "resizing-y"); }, []);
  const shown = state !== "closed";
  return (
    <div ref={root} className={`run-dock ${state}`} style={state === "open" && area ? { height: h } : undefined}>
      {state === "open" && (
        <div className="resizer dock-resizer" role="separator" aria-orientation="horizontal" title="Drag to resize, double-click to reset"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            drag.current = { y: e.clientY, h, last: h };
            e.currentTarget.setPointerCapture(e.pointerId);
            e.currentTarget.classList.add("active");
            document.body.classList.add("resizing", "resizing-y");
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            d.last = dockHeight(d.h + d.y - e.clientY, area);
            onHeight(d.last, false);
          }}
          onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
          onDoubleClick={() => { auto.current = null; onHeight(null, true); }} />
      )}
      <div className="dock-tabs" role="tablist" aria-label="Details of the run">
        {TABS.filter(([k]) => k !== "result" || result || tab === "result").map(([k, label]) => (
          <button key={k} type="button" role="tab" data-tab={k} aria-selected={shown && tab === k} className={`dock-tab${shown && tab === k ? " on" : ""}`} onClick={() => onTab(k)}>
            {label}{k === "notes" && notes > 0 && <span className="v">v{notes}</span>}
          </button>
        ))}
        {entity != null && (
          <>
            <span className="dock-sep" />
            <span className={`dock-tab entity${shown && tab === "entity" ? " on" : ""}`}>
              <button type="button" role="tab" data-tab="entity" aria-selected={shown && tab === "entity"} onClick={() => onTab("entity")}>{entity}</button>
              <button type="button" className="x" title={`Close ${entity} (clears the selection)`} aria-label={`Close ${entity}`} onClick={onCloseEntity}>×</button>
            </span>
          </>
        )}
        <span className="grow" />
        <span className="dock-btns">
        {shown && (
          <button type="button" className="icon-btn sm dock-max" title={state === "max" ? "Restore: show the timeline again" : "Fill the stage"} aria-label={state === "max" ? "Restore the dock" : "Maximise the dock"}
            onClick={() => onState(state === "max" ? "open" : "max")}>{state === "max" ? "⤡" : "⤢"}</button>
        )}
        <button type="button" className="icon-btn sm dock-close" title={shown ? "Close the dock" : "Open the dock"} aria-label={shown ? "Close the dock" : "Open the dock"}
          onClick={() => onState(shown ? "closed" : "open")}>{shown ? "×" : "▴"}</button>
        </span>
      </div>
      {shown && (
        <div className="dock-body" ref={bodyRef} tabIndex={-1} role="tabpanel">
          <div className="dock-col">{children}</div>
        </div>
      )}
    </div>
  );
}
