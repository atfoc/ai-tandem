// What the run bar says about the run itself, and the two things the user can do to it: the
// status with what the orchestrator is at, Stop while it runs, Resume once it is halted (with the
// limit that stalled it set higher).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import "./run.css";
import { useStore, getState, setState } from "../store.ts";
import { ApiError } from "../api.ts";
import { runLoadError } from "../conn.ts";
import { Menu, confirm, reportError, type ConfirmRequest } from "../Dialogs.tsx";
import { isDraft, runWord } from "../logic/run.ts";
import { canResume, moneyLimit, raiseValue, resumeRaise, runDoing, stopConfirm, type Raise } from "../logic/runview.ts";
import { NARROW, TIGHT, refreshRun, resumeRun, stopRun, useFresh, useSize } from "./actions.ts";
import { runWhere } from "../logic/runserver.ts";
import { runActBlock } from "../logic/runrows.ts";
import type { RunView } from "../types.ts";

/** The status mark of the vocabulary: a pulsing dot while it runs, a spinner while it stops. */
function Mark({ status }: { status: RunView["status"] }) {
  if (status === "running") return <i className="sub-dot" />;
  if (status === "stopping") return <span className="spin" />;
  if (status === "stopped") return <span className="g sq">■</span>;
  return <span className="g">{status === "completed" ? "✓" : status === "gave_up" ? "✕" : "!"}</span>;
}

export function RunBarStatus({ runId }: { runId: string }) {
  const r = useStore((s) => s.runs[runId]);
  // What a running run is at, by its detail when that is loaded (a string: the detail changes with every task).
  const doing = useStore((s) => { const v = s.runs[runId]; return v?.status === "running" ? runDoing(v, s.runDetail[runId]) : ""; });
  const loaded = useStore((s) => !!s.runDetail[runId]);
  const connected = useStore((s) => s.connected);
  // A run on another server takes no Stop and no Resume while that server is not connected (the title says so).
  const off = useStore((s) => { const v = s.runs[runId]; return v ? runActBlock(runWhere(s, v)) : ""; });
  const ref = useRef<HTMLSpanElement>(null);
  const followed = !!r && !isDraft(r);
  const stage = useSize(ref, (el) => el.closest<HTMLElement>(".board-stage"), followed).w || 1000;
  // What blocks a resume is a fact the server checks only when it is asked.
  useFresh(runId, followed && !!r.blocked && canResume(r.status));
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setMenu(false); }, [r?.status]);
  // A run whose detail could not be loaded cannot be resumed from here. Why a fetch failed is not
  // in the store: it is read again while there is no detail.
  const [unreadable, setUnreadable] = useState(false);
  useEffect(() => {
    if (loaded || !followed) { setUnreadable(false); return; }
    const look = () => setUnreadable(!!runLoadError(runId));
    look();
    const t = setInterval(look, 500);
    return () => clearInterval(t);
  }, [runId, loaded, followed]);
  // The Stop dialog closes when the run stops running underneath it: its question is no longer one.
  const asking = useRef<ConfirmRequest | null>(null);
  useEffect(() => {
    if (!asking.current || r?.status === "running") return;
    if (getState().confirm === asking.current) setState({ confirm: null });
    asking.current = null;
  }, [r?.status]);
  // Stop and Resume replace each other: after one was pressed the focus goes to the other, not to nothing.
  const acted = useRef(0);
  useEffect(() => {
    if (Date.now() - acted.current > 15000 || (document.activeElement !== document.body && document.activeElement != null)) return;
    ref.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [r?.status, menu]);
  if (!r) return null;
  if (isDraft(r)) return <span className="run-status st-draft">{runWord(r)}</span>;

  const raise = resumeRaise(r), acts = !r.archived && !r.gone; // a run its server no longer has takes neither
  const stop = acts && (r.status === "running" || r.status === "stopping");
  const resume = acts && canResume(r.status) && !unreadable;
  // A narrow stage says less: first what the run is at, then the buttons' words, then the status word.
  const sub = r.status === "running" && stage >= NARROW, words = stage >= TIGHT, word = stage >= 300, mark = word || !(stop || resume);
  const says = r.status === "running" ? `${runWord(r)} · ${doing}` : runWord(r);

  const askStop = () => {
    const c = stopConfirm(r);
    // A run that ended meanwhile answers 409: the dialog closes and the bar shows what the run is now.
    const stop = async () => {
      acted.current = Date.now();
      try { await stopRun(r.id); } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e; await refreshRun(r.id); }
    };
    asking.current = { title: c.title, body: c.body, actions: [{ label: "Stop", tone: "danger", run: stop }] };
    confirm(asking.current);
  };
  const go = async () => {
    acted.current = Date.now();
    if (raise) { setMenu(!menu); return; }
    setBusy(true);
    try { await resumeRun(r.id); } catch (e) { reportError("Couldn't resume the run", e); void refreshRun(r.id); }
    setBusy(false);
  };
  return (
    <span className="run-state" ref={ref}>
      {mark && (
        <span className={`run-status st-${r.status}`} title={word && sub ? undefined : says}>
          <Mark status={r.status} />
          {word && <span className="w">{runWord(r)}</span>}
          {sub && <span className="why">· {doing}</span>}
        </span>
      )}
      {stop && (
        <button className="btn sm run-stop" disabled={r.status === "stopping" || !connected || !!off} onClick={askStop}
          title={!connected ? "Reconnecting to the server…" : off ? off : r.status === "stopping" ? "The run is stopping" : words ? "Stop the run: its agents are interrupted and continue when you resume" : `${says} — Stop`}>
          <span className="g">■</span>{words && " Stop"}
        </button>
      )}
      {resume && (
        <span className="menu-wrap">
          <button className={`btn sm run-resume${menu ? " on" : ""}`} disabled={busy || !connected || !!off} onClick={go}
            title={!connected ? "Reconnecting to the server…" : off ? off : r.blocked || (raise ? "Resume the run with a higher limit" : words ? "Resume the run where it stopped" : `${says} — Resume`)}>
            <span className="g">▶</span>{words && " Resume"}
          </button>
          {menu && raise && <Menu onClose={() => setMenu(false)}><RaiseForm run={r} raise={raise} onDone={() => setMenu(false)} /></Menu>}
        </span>
      )}
    </span>
  );
}

/** The form under Resume for a run its turn or cost limit stalled: that one limit, set higher.
 *  The server refuses a value that is not higher; its words show here. */
function RaiseForm({ run, raise, onDone }: { run: RunView; raise: Raise; onDone: () => void }) {
  const [text, setText] = useState(String(raise.value));
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  // In a narrow stage the menu would end outside the window: it is moved left, as the pickers' menus are.
  useLayoutEffect(() => {
    const menu = box.current?.parentElement;
    if (!menu) return;
    const over = menu.getBoundingClientRect().right - (window.innerWidth - 8);
    if (over > 0) menu.style.left = `${-over}px`;
  }, []);
  const send = async () => {
    const v = raiseValue(raise.key, text);
    if (v === null) { setErr(raise.key === "maxTurns" ? "Type a number of turns" : "Type an amount in dollars"); return; }
    setBusy(true); setErr("");
    try { await resumeRun(run.id, raise.key === "maxTurns" ? { maxTurns: v } : { maxCost: v }); onDone(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); setBusy(false); void refreshRun(run.id); }
  };
  const turns = raise.key === "maxTurns";
  return (
    <div className="run-raise" ref={box}>
      <div className="menu-head">Resume with a higher limit</div>
      <label className="run-raise-row">
        Raise the limit to {!turns && "$"}
        <input ref={input} className="menu-search-input" inputMode={turns ? "numeric" : "decimal"} value={text} aria-label={turns ? "Turn limit" : "Cost limit in dollars"}
          onChange={(e) => { setText(e.target.value); setErr(""); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void send(); } }} />
        {turns && " turns"}
      </label>
      <div className="menu-note">{turns ? `The run used all ${raise.was} of its turns: with the same limit it would stall again at once.` : `The run reached its cost limit of ${moneyLimit(raise.was)}: with the same limit it would stall again at once.`}</div>
      {err && <div className="dir-err">{err}</div>}
      <div className="run-raise-foot"><button className="btn sm primary" disabled={busy} onClick={send}>Resume</button></div>
    </div>
  );
}
