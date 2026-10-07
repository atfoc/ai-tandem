// The goal composer: what a run's stage shows until its goal is sent. The chat composer's look
// and parts (RefInput, DraftSaver, Picker, DirPicker, the same classes), bound to a run: the
// agent can be picked here too, the three tiers' models and the settings have a chip each, and Send
// starts the run. A draft run has a server (an entry of the server list): the server can be picked
// first, and the agents, models and folders offered are that server's.
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./composer.css";
import { useStore, getState, upsertRun, answerRun, setRunStart, unsavedRunDraft } from "../store.ts";
import { refreshRun, startRun, useFresh } from "./actions.ts";
import { api } from "../api.ts";
import { RefInput, type RefInputHandle } from "../RefInput.tsx";
import { DirPicker, Picker, tildify } from "../Composer.tsx";
import { DraftSaver, hasDraft } from "../logic/drafts.ts";
import { limitsLabel, tiersLabel } from "../logic/run.ts";
import { applies, applyResultOf, limitText, limitValue, settingsChange, setupValue, withoutGit,
  APPLY_NOTE, APPLY_NOTE_NO_GIT, LIMITS, SETUP_MAX, WAKES, type LimitKey, type SettingKey } from "../logic/rungoal.ts";
import { RunTiers } from "./RunTiers.tsx";
import { AgentGlyph, RunIcon, WarnIcon, agentClass, agentName } from "../icons.tsx";
import { catalogFor, usableAgents } from "../logic/agentlist.ts";
import { agentChoiceOn } from "../logic/chatserver.ts";
import { runAgentReason, runServerChoice, runStartBlock } from "../logic/runserver.ts";
import { changeFailure, runFixed, runFolderChip, runHasChats, runLine } from "../logic/runcompose.ts";
import { applySetting } from "../logic/runrows.ts";
import { useWhere } from "../ChatChoices.tsx";
import { openServers } from "../Servers.tsx";
import { type AgentKind, type Draft, type RunSettings, type RunView } from "../types.ts";

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
const draftToShow = (run: string) => unsavedRunDraft(run).read() ?? getState().runs[run]?.draft;

export function RunComposer({ runId }: { runId: string }) {
  const r = useStore((s) => s.runs[runId]);
  const w = useWhere(r); // the run's server, as runWhere reads it
  const [text, setText] = useState(() => draftToShow(runId)?.text ?? "");
  // The start's state is the store's, by run id (startRun, actions.ts): it follows a draft that
  // gets a new id mid-start, for which this composer is made again, and the store drops the
  // sentence when what it is about changed (the folder, what blocks the run, its server, its
  // start mark, a server that is connected again).
  const starting = useStore((s) => !!s.runStarts[runId]?.starting);
  const err = useStore((s) => s.runStarts[runId]?.error ?? "");
  const setErr = (msg: string) => setRunStart(runId, { error: msg });
  const agentReason = useStore((s) => (r ? runAgentReason(w, usableAgents(s, w.server), r) : ""));
  const input = useRef<RefInputHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const current = useRef(text); // the text now
  const drafts = useRef<DraftSaver | null>(null);
  drafts.current ??= new DraftSaver((d, keepalive) => saveDraft(runId, d, keepalive), getState().runs[runId]?.draft, unsavedRunDraft(runId));

  // The draft: put into the box when it appears (on open, after unarchiving), saved as it changes,
  // and saved at once when the composer or the page goes away, as a chat's.
  useEffect(() => {
    const d = draftToShow(runId);
    if (r?.archived || !hasDraft(d)) return;
    input.current?.set(d.text);
  }, [r?.archived]);
  useEffect(() => { drafts.current!.change(text); }, [text]);
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
  const block = runStartBlock(w, r, text, agentReason);
  const submit = async () => {
    const goal = current.current.trim();
    if (block || starting) return;
    drafts.current!.flush(); // the server holds the text as the draft, should the start fail and the page go away
    // The run started with an earlier goal and this composer goes away with the `run` event:
    // the sentence and the text that was not sent are shown apart from it.
    const kept = await startRun(runId, goal);
    if (kept) showGoalKept(kept, goal);
  };
  const tilde = (p: string) => tildify(p, w.server);
  const line = runLine(w, r, err, tilde, agentReason);
  const folder = runFolderChip(w, r, tilde);

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
            <span className={`ctx-chip${folder.missing ? " missing" : ""}`} title={folder.title}>
              <span className="mono">{folder.text}</span>
              {folder.git && <span className="git">git</span>}
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

/** Server, agent, folder, the tiers' models and the settings. Each change is sent at once and the
 *  answer is the run's view: after another server is picked, agent, tiers, folder and settings are
 *  what the server chose for it, and after another agent the three tiers. The agents, the models
 *  and the folders are the run's server's. While the start got no answer (runFixed) every choice
 *  is a chip with the reason. */
function RunToolbar({ r, onError }: { r: RunView; onError: (msg: string) => void }) {
  const w = useWhere(r);
  const cat = useStore((s) => catalogFor(s, w.server, r.agent));
  const usable = useStore((s) => usableAgents(s, w.server));
  const choice = agentChoiceOn(w, usable, r.agent);
  const fixed = runFixed(r);
  const [open, setOpen] = useState(false);
  const failed = (e: unknown) => { if (changeFailure(e).reread) void refreshRun(r.id); };
  const configure = (p: Change) => answerRun(r.id, () => api.configureRun(r.id, p)).then(() => onError(""), (e) => { onError(changeFailure(e).text); failed(e); });
  const glyph = (a: AgentKind) => <span className={`run-agent-glyph agent-${agentClass(a)}`}><AgentGlyph agent={a} size={12} /></span>;
  return (
    <>
      <RunServer r={r} configure={configure} />
      {/* Only the agents the server can run; one it lacks, or none at all, shows with the reason. */}
      {fixed ? <span className="tchip static run-fixed" data-fixed="agent" title={`Agent — ${fixed}`}>{r.agent ? <>{glyph(r.agent)}{agentName(r.agent)}</> : "No agent"}</span>
        : !choice.options.length ? <span className="tchip static missing" title={`Agent — ${choice.reason}`}>No agent</span>
        : <Picker label={r.agent ? agentName(r.agent) : "No agent"} title="Agent" hint={choice.reason || UNTIL_START} icon={r.agent ? glyph(r.agent) : undefined} value={r.agent}
          options={choice.options.map((a) => ({ id: a, label: agentName(a), icon: glyph(a) }))}
          open={open} onOpenChange={setOpen}
          onPick={(id) => configure({ agent: id as AgentKind })} />}
      <DirPicker cwd={r.cwd} missing={r.folderMissing} locked={!!fixed} hint={UNTIL_START} server={w.server}
        onPick={(d) => answerRun(r.id, () => api.configureRun(r.id, { cwd: d })).then(() => onError(""), (e) => { failed(e); throw e; })} />
      {!r.agent ? null
        : fixed ? <span className="tchip static run-fixed" data-fixed="tiers" title={`Models — ${fixed}`}><span className="tchip-pre">Models</span><span className="run-tiers-label">{tiersLabel(r.tiers, (id) => cat?.models.find((m) => m.id === id)?.label)}</span></span>
        : !cat ? <span className="tchip static">Loading models…</span>
        : <RunTiers r={r} cat={cat} hint={UNTIL_START} onChange={(tiers) => configure({ tiers })} />}
      {fixed ? <span className="tchip static run-fixed" data-fixed="settings" title={`Run settings — ${fixed}`}>{limitsLabel(r.settings)}</span>
        : <RunLimits r={r} onError={onError} />}
    </>
  );
}

/** The server choice: every entry of the server list by name, this computer first, one that waits
 *  for the user disabled with its state, and "Servers…", which opens the Servers dialog. A pick is
 *  sent at once. Where the server cannot be changed (runServerChoice's fixed: the start got no
 *  answer, or the run has chats) it is a chip with the reason. */
function RunServer({ r, configure }: { r: RunView; configure: (p: Change) => Promise<unknown> }) {
  const servers = useStore((s) => s.servers);
  const hasChats = useStore((s) => runHasChats(s.chats, r.id));
  const w = useWhere(r);
  const [open, setOpen] = useState(false);
  const { options, fixed } = runServerChoice(servers, r, hasChats);
  if (fixed) return <span className={`tchip static server-chip ${w.connected ? "" : "off"}`} title={`Server — ${fixed}`}>{w.name}</span>;
  return <Picker className="server-pick" label={w.name} title="Server" hint={UNTIL_START} value={w.server}
    options={options.map((o) => ({ id: o.id, label: o.label, note: o.reason, disabled: o.disabled }))}
    more={{ label: "Servers…", onClick: () => openServers() }}
    open={open} onOpenChange={setOpen} onPick={(id) => configure({ server: id })} />;
}

// ---- a start whose text was not sent

/** The notice of a start the server answered 409 goal_kept: the run had started with the goal of
 *  an earlier start, and the stage shows the run by now. It has a root of its own, since the
 *  composer is gone; it shows the server's sentence and the text that was not sent until it is
 *  dismissed. */
function showGoalKept(sentence: string, text: string) {
  document.querySelector(".goal-kept-host")?.remove();
  const host = document.createElement("div");
  host.className = "goal-kept-host";
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => { root.unmount(); host.remove(); };
  root.render(
    <div className="goal-kept" role="alert">
      <div className="goal-kept-said"><WarnIcon /> <span>{sentence}</span></div>
      <pre className="goal-kept-text">{text}</pre>
      <div className="goal-kept-foot">
        <button className="btn sm" onClick={() => void navigator.clipboard?.writeText(text)}>Copy text</button>
        <button className="btn sm" onClick={close}>Dismiss</button>
      </div>
    </div>,
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
  const w = useWhere(r);
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
        if (changeFailure(e).reread) void refreshRun(r.id);
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
            <span className="run-field-name">{applySetting(w)}
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
