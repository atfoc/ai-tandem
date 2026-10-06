// The goal composer: what a run's stage shows until its goal is sent. The chat composer's look
// and parts (RefInput, DraftSaver, Picker, DirPicker, the same classes), bound to a run: the
// agent can be picked here too, the three tiers' models and the settings have a chip each, and Send
// starts the run.
import React, { useEffect, useRef, useState } from "react";
import "./composer.css";
import { useStore, getState, upsertRun, answerRun, unsavedDraft } from "../store.ts";
import { refreshRun, useFresh } from "./actions.ts";
import { api, ApiError } from "../api.ts";
import { RefInput, type RefInputHandle } from "../RefInput.tsx";
import { DirPicker, Picker, tildify } from "../Composer.tsx";
import { DraftSaver, hasDraft } from "../logic/drafts.ts";
import { limitsLabel, startBlock } from "../logic/run.ts";
import { applies, applyResultOf, goalLine, limitText, limitValue, settingsChange, setupValue, withoutGit,
  APPLY_NOTE, APPLY_NOTE_NO_GIT, LIMITS, SETUP_MAX, WAKES, type LimitKey, type SettingKey } from "../logic/rungoal.ts";
import { RunTiers } from "./RunTiers.tsx";
import { AgentGlyph, RunIcon, WarnIcon, agentClass, agentName } from "../icons.tsx";
import { AGENT_ORDER, type AgentKind, type Draft, type RunSettings, type RunView } from "../types.ts";

const UNTIL_START = "can be changed until you start the run";


/** Saves a run's goal draft on the server, and in the store at once (as a chat's, Composer.tsx).
 *  Nothing is saved for a run that started: its goal is sent. */
async function saveDraft(run: string, d: Draft, keepalive: boolean) {
  const r = getState().runs[run];
  if (!r || r.started) return; // deleted, or started
  upsertRun({ ...r, draft: hasDraft(d) ? d : undefined });
  await api.saveRunDraft(run, d, keepalive).catch((e) => { console.warn(`goal draft of ${run} not saved:`, e); throw e; });
}

/** The draft the composer opens with: one the server may not have yet, else the server's. */
const draftToShow = (run: string) => unsavedDraft(run).read() ?? getState().runs[run]?.draft;

export function RunComposer({ runId }: { runId: string }) {
  const r = useStore((s) => s.runs[runId]);
  const [text, setText] = useState(() => draftToShow(runId)?.text ?? "");
  const [err, setErr] = useState("");
  const [starting, setStarting] = useState(false);
  const input = useRef<RefInputHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef(text); // the text now
  const drafts = useRef<DraftSaver | null>(null);
  drafts.current ??= new DraftSaver((d, keepalive) => saveDraft(runId, d, keepalive), getState().runs[runId]?.draft, unsavedDraft(runId));

  // The draft: put into the box when it appears (on open, after unarchiving), saved as it changes,
  // and saved at once when the composer or the page goes away, as a chat's.
  useEffect(() => {
    const d = draftToShow(runId);
    if (r?.archived || !hasDraft(d)) return;
    input.current?.set(d.text);
  }, [r?.archived]);
  useEffect(() => { drafts.current!.change(text); }, [text]);
  // What the server said about a start is old once the run's folder or what blocks it changed.
  useEffect(() => { setErr(""); }, [r?.blocked, r?.folderMissing, r?.cwd]);
  // The server checks the folder and what blocks a start only when it is asked.
  useFresh(runId, true);
  useEffect(() => {
    const d = drafts.current!;
    const hide = () => { d.change(current.current); d.flush(true); };
    window.addEventListener("pagehide", hide);
    return () => { window.removeEventListener("pagehide", hide); d.change(current.current); d.flush(); };
  }, []);
  // While the start is on its way nothing can be typed, pasted or dropped into the box.
  useEffect(() => {
    const el = box.current;
    if (!starting || !el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("beforeinput", stop, true);
    return () => el.removeEventListener("beforeinput", stop, true);
  }, [starting]);

  if (!r) return null;
  const block = startBlock(r, text);
  // Not optimistic: the stage changes when the server has recorded the start. The text stays in
  // the box all along, so a start that fails has nothing to put back.
  const submit = async () => {
    const goal = current.current.trim();
    if (block || starting) return;
    setStarting(true); setErr("");
    drafts.current!.flush(); // the server holds the text as the draft, should the start fail and the page go away
    try {
      await answerRun(runId, async () => {
        const started = await api.startRun(runId, goal);
        unsavedDraft(runId).write(null);
        return started; // it has `started`: the stage changes to the follow view
      });
    } catch (e: any) {
      // a body the server would not take, with no sentence of its own
      setErr(e instanceof ApiError && e.status === 413 && !e.said ? "The goal is too long for the server to take." : e?.message || String(e));
      setStarting(false);
      if (e instanceof ApiError && e.status === 409) void refreshRun(runId); // it started, was archived, or its folder changed
    }
  };
  const line = goalLine(r, err, tildify);

  return (
    <div className="run-new run-goal">
      <div className="run-new-body">
        <div className="empty-thread">
          <div className="big-glyph run"><RunIcon size={26} /></div>
          <div className="empty-title">{r.name}</div>
          <p>Describe a goal. An orchestrator agent splits it into tasks, other agents carry them out in parallel, and their work is brought together. You follow it here.</p>
          {!r.archived && <p className="config-hint">Pick the agent, folder and models below. They lock when the run starts.</p>}
        </div>
      </div>
      {r.archived ? (
        <div className="composer">
          <div className="archived-bar">
            Archived — unarchive to start it
            <button className="btn sm" onClick={() => api.unarchive("runs", r.id).then(() => setErr(""), (e) => setErr(e.message))}>Unarchive</button>
          </div>
          {err && <div className="composer-err">{err}</div>}
        </div>
      ) : (
        <div className={`composer run-composer${starting ? " starting" : ""}`}>
          <div className="context-row">
            <span className={`ctx-chip${r.folderMissing ? " missing" : ""}`} title="The folder the run's agents work in">
              <span className="mono">{tildify(r.cwd) || "No folder"}</span>
              {r.git && !r.folderMissing && <span className="git">git</span>}
            </span>
          </div>
          <div className="composer-box with-tools" ref={box}>
            <RefInput
              ref={input}
              placeholder="What should this run achieve?"
              onChange={(v) => { setText(v); current.current = v; }}
              onKeyDown={(e) => {
                e.stopPropagation(); // as the chat composer: no shortcut of the page gets the keys typed here
                if (starting) return;
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
              }}
            />
            <div className="composer-tools">
              <RunToolbar r={r} onError={setErr} />
              <span className="grow" />
              <button className="send" title={starting ? "Starting…" : block || "Start the run (Enter)"} disabled={!!block || starting} onClick={() => void submit()}>
                {starting ? <span className="spin" /> : "↑"}
              </button>
            </div>
          </div>
          {line && (line.tone === "error"
            ? <div className="composer-err">{line.text}</div>
            : <div className="run-note"><WarnIcon /> <span>{line.text}</span></div>)}
        </div>
      )}
    </div>
  );
}

// ---- toolbar

type Change = Parameters<typeof api.configureRun>[1];

/** Agent, folder, the tiers' models and the settings. Each change is sent at once and the answer
 *  is the run's view: after another agent is picked, the three tiers are what the server chose. */
function RunToolbar({ r, onError }: { r: RunView; onError: (msg: string) => void }) {
  const cat = useStore((s) => s.catalogs[r.agent]);
  const [open, setOpen] = useState(false);
  const failed = (e: any) => { if (e instanceof ApiError && e.status === 409) void refreshRun(r.id); };
  const configure = (p: Change) => answerRun(r.id, () => api.configureRun(r.id, p)).then(() => onError(""), (e) => { onError(e.message); failed(e); });
  const glyph = (a: AgentKind) => <span className={`run-agent-glyph agent-${agentClass(a)}`}><AgentGlyph agent={a} size={12} /></span>;
  return (
    <>
      <Picker label={agentName(r.agent)} title="Agent" hint={UNTIL_START} icon={glyph(r.agent)} value={r.agent}
        options={AGENT_ORDER.map((a) => ({ id: a, label: agentName(a), icon: glyph(a) }))}
        open={open} onOpenChange={setOpen}
        onPick={(id) => configure({ agent: id as AgentKind })} />
      <DirPicker cwd={r.cwd} missing={r.folderMissing} locked={false} hint={UNTIL_START}
        onPick={(d) => answerRun(r.id, () => api.configureRun(r.id, { cwd: d })).then(() => onError(""), (e) => { failed(e); throw e; })} />
      {!cat ? <span className="tchip static">Loading models…</span>
        : <RunTiers r={r} cat={cat} hint={UNTIL_START} onChange={(tiers) => configure({ tiers })} />}
      <RunLimits r={r} onError={onError} />
    </>
  );
}

// ---- settings

type FieldKey = SettingKey;
type Fields = Pick<RunSettings, FieldKey>;

/** The run's settings: a chip that opens a small form with the limits, the setup command, when
 *  the orchestrator is woken and whether the result is applied. A field is saved when it is left
 *  (blur, Enter, a click outside), a menu or checkbox when it changes; Esc closes the form and
 *  leaves the field as it was. */
function RunLimits({ r, onError }: { r: RunView; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState("");
  const [rev, setRev] = useState(0); // counts refused saves: the fields are made again from what is saved
  const [, setAsked] = useState(0); // counts saves asked: the menu and the checkbox show what was asked at once
  const [wake, setWake] = useState(false); // the "Wake it" menu is open
  const waking = useRef(wake);
  waking.current = wake;
  const shown = useRef(open);
  shown.current = open;
  const dropped = useRef(false); // Esc closed the form: the field that had the focus is not saved
  const pop = useRef<HTMLDivElement>(null);
  // What the form asked to save and has no answer for yet, by key: a field left again before the
  // answer is compared with this, not with the view, which is a save behind.
  const asked = useRef<Partial<Record<FieldKey, { value: number | string; n: number }>>>({});
  const seq = useRef(0);
  const s = r.settings;
  const held = (): Fields => ({ ...s, ...Object.fromEntries(Object.entries(asked.current).map(([k, a]) => [k, a.value])) });
  const noGit = withoutGit(r);
  useEffect(() => {
    if (!open) { setWake(false); return; }
    // Esc closes the form, before anything else sees it (as the composer's context popover does);
    // its open menu takes its own Esc first.
    dropped.current = false;
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !waking.current) { e.preventDefault(); e.stopPropagation(); dropped.current = true; setOpen(false); } };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [open]);
  // Anchored at the chip's left edge: moved left by what its right edge passes the window's (less
  // a 12px margin), never past the window's left edge, as a picker's menu is.
  React.useLayoutEffect(() => {
    const el = pop.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const over = Math.min(b.right - (window.innerWidth - 12), b.left);
    if (over > 0) el.style.left = `${-over}px`;
  }, [open]);

  const save = (key: FieldKey, value: number | string) => {
    const change = dropped.current ? null : settingsChange(held(), key, value);
    if (!change) return;
    const n = ++seq.current;
    asked.current[key] = { value, n };
    setAsked(n);
    const answered = () => { if (asked.current[key]?.n === n) delete asked.current[key]; };
    answerRun(r.id, () => api.configureRun(r.id, { settings: change })).then(
      () => { answered(); setErr(""); onError(""); },
      (e) => {
        answered();
        setRev((n) => n + 1);
        if (shown.current) setErr(e.message); else onError(e.message); // the form went away: the line under the box says it
        if (e instanceof ApiError && e.status === 409) void refreshRun(r.id);
      },
    );
  };
  // A click outside leaves the field first: the form goes away before the browser moves the focus.
  const close = () => {
    const at = document.activeElement;
    if (at instanceof HTMLElement && pop.current?.contains(at)) at.blur();
    setOpen(false);
  };
  const num = (label: string, key: LimitKey, o: { note?: string; pre?: string; none?: string } = {}) => (
    <label className="run-field">
      <span className="run-field-name">{label}{o.note && <span className="menu-note">{o.note}</span>}</span>
      {o.pre && <span className="run-field-pre">{o.pre}</span>}
      <SavedInput className="dir-input run-num" type="number" data-limit={key}
        min={LIMITS[key].min} max={LIMITS[key].max} step={LIMITS[key].whole ? 1 : "any"}
        saved={limitText(key, held()[key])} refused={rev} placeholder={o.none}
        onLeave={(el) => {
          const cur = held()[key];
          const v = el.validity.badInput ? cur : limitValue(key, el.value, cur); // what is not a number changes nothing
          el.value = limitText(key, v);
          save(key, v);
        }} />
    </label>
  );
  return (
    <div className="menu-wrap">
      <button className="tchip" aria-expanded={open} aria-haspopup="dialog" onClick={() => (open ? close() : setOpen(true))} title={`Run settings — ${UNTIL_START}`}>
        {limitsLabel(s)}<span className="caret">▾</span>
      </button>
      {open && (
        <div ref={pop} className="menu up usage-pop run-limits" role="dialog" aria-label="Run settings" onMouseDown={(e) => e.stopPropagation()}>
          <div className="menu-head">Limits</div>
          {num("Tasks at once", "maxParallel")}
          {num("Orchestrator turns", "maxTurns", { note: "The run stalls after this many; you can raise it and resume" })}
          {num("Cost", "maxCost", { pre: "$", none: "none", note: r.agent === "cursor" ? `${agentName(r.agent)} reports no cost: this limit cannot apply` : "The run stops starting work past this" })}
          <div className="menu-head">Setup command</div>
          <SavedInput className="dir-input" type="text" data-limit="setup" spellCheck={false} autoComplete="off" maxLength={SETUP_MAX}
            saved={noGit ? "" : held().setup ?? ""} refused={rev} placeholder={noGit ? "Not used without git" : "e.g. npm ci"} disabled={noGit}
            onLeave={(el) => {
              const v = setupValue(el.value);
              el.value = v;
              save("setup", v);
            }} />
          <div className="run-field-foot">Runs in each task's own checkout, in the folder the run was started in, before its agent starts. Files it creates are part of the result unless git ignores them.</div>
          <div className="menu-head">Orchestrator</div>
          <div className="run-field sel" data-limit="wake">
            <span className="run-field-name">Wake it</span>
            <Picker label={WAKES.find(([id]) => id === held().wake)?.[1] ?? held().wake} title="Wake the orchestrator" hint={UNTIL_START} value={held().wake}
              options={WAKES.map(([id, label]) => ({ id, label }))}
              open={wake} onOpenChange={setWake} onPick={(id) => save("wake", id)} />
          </div>
          <div className="menu-head">Result</div>
          <label className={`run-field check${noGit ? " off" : ""}`}>
            <input type="checkbox" className="switch" data-limit="applyResult" checked={applies(held())} disabled={noGit}
              onChange={(e) => save("applyResult", applyResultOf(e.currentTarget.checked))} />
            <span className="run-field-name">Apply the result to my folder when the run ends
              <span className="menu-note">{noGit ? APPLY_NOTE_NO_GIT : APPLY_NOTE}</span></span>
          </label>
          {err && <div className="dir-err">{err}</div>}
        </div>
      )}
      {open && <div className="menu-backdrop" onMouseDown={close} />}
    </div>
  );
}

/** A field of the form. It shows what is saved until something is typed into it, is left with
 *  Enter as with Tab, and is set again when what is saved changes or a save was refused,
 *  but never while it has the focus: the answer of an earlier save must not overwrite typing. */
function SavedInput({ saved, refused, onLeave, ...props }: {
  saved: string; refused: number; onLeave: (el: HTMLInputElement) => void;
} & React.InputHTMLAttributes<HTMLInputElement> & { "data-limit": string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && document.activeElement !== el) el.value = saved;
  }, [saved, refused]);
  return (
    <input ref={ref} defaultValue={saved} {...props}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") e.currentTarget.blur(); }}
      onBlur={(e) => onLeave(e.currentTarget)} />
  );
}
