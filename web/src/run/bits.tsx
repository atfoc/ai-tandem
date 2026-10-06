// Small pieces the dock's views share: a task's state mark, a task as a chip that selects it, a
// line of linked parts (a call of a run tool, a row of the feed), a chat on the run as a link, the
// rows of a text that is being loaded, a command to copy.
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import "./detail.css";
import { useStore } from "../store.ts";
import { openChat } from "../Sidebar.tsx";
import { chatTitle } from "../logic/labels.ts";
import { STATES, taskState } from "../logic/runtimeline.ts";
import { clockTime, dateTime } from "../logic/runlabels.ts";
import type { FeedPart } from "../logic/runfeed.ts";
import { money, whenText } from "../logic/runview.ts";
import type { RunDetail, RunGit, Task } from "../types.ts";

/** Whether the run's clock runs. */
export const liveDetail = (d: Pick<RunDetail, "status">): boolean => d.status === "running" || d.status === "stopping";

/** A task's state in the run's vocabulary; a task a halted run interrupted is "paused". */
export function stateOf(task: Task, live: boolean): { glyph: string; word: string; tone: string; pulse: boolean } {
  const st = taskState(task), v = STATES[st];
  if (!live && (st === "setup" || st === "work" || st === "merge")) return { glyph: "‖", word: "paused", tone: "muted", pulse: false };
  return { glyph: v.glyph, word: v.word, tone: v.tone, pulse: !!v.pulse };
}

/** The state mark: a glyph, or the pulsing dot of a task at work. */
export function TaskMark({ task, live }: { task: Task; live: boolean }) {
  const s = stateOf(task, live);
  return <span className={`rd-mark tone-${s.tone}`} title={s.word}>{s.pulse ? <i className="sub-dot" /> : s.glyph}</span>;
}

/** A task as a chip: its state mark and id; a click selects it. An id the run does not have is plain
 *  text. `suffix`: faint words after the id, inside the chip ("full report"). */
export function TaskChip({ id, detail, onSelect, suffix }: { id: string; detail: RunDetail; onSelect: (id: string) => void; suffix?: string }) {
  const task = detail.tasks.find((t) => t.id === id);
  const more = suffix ? <span className="rd-chip-x">· {suffix}</span> : null;
  if (!task) return <span className="rd-chip gone">{id}{more}</span>;
  return (
    <button type="button" className="rd-chip" data-task={id} title={`${id} · ${task.title} · ${stateOf(task, liveDetail(detail)).word}`} onClick={() => onSelect(id)}>
      <TaskMark task={task} live={liveDetail(detail)} />{id}{more}
    </button>
  );
}

/** A clock time, with the day when that is not today; its title is the full date. */
export const Clock = ({ t }: { t: number }) => <span title={dateTime(t)}>{whenText(t, Date.now())}</span>;

/** A cost in dollars; "—" for one that is not known (the agent kind reports none, or not yet). */
export const cost = (usd: number | null | undefined): string => (typeof usd === "number" ? money(usd) : "—");

/** A chat on the run, as who did something: "the chat <its name>", the name a link that opens the
 *  chat in the panel, when the client knows the chat; else "a chat". */
export function ChatRef({ id }: { id: string | null | undefined }) {
  const c = useStore((s) => (id ? s.chats[id] : undefined));
  const items = useStore((s) => (id && !c?.name ? s.items[id]?.items : undefined));
  if (!c) return <>a chat</>;
  return <>the chat <button type="button" className="link lk" data-chat={c.id} title="Open this chat" onClick={() => openChat(c)}>{chatTitle(c, items)}</button></>;
}

/** What the links of a line do; a kind with no handler is plain text. */
export interface PartLinks { onSelectTask?(id: string): void; onSelectTurn?(n: number): void; onOpenNotes?(v: number): void }

/** A line's parts, the tasks, turns, chats and notes versions in it as links. `chips`: the run's
 *  detail, for a sentence whose tasks are chips. */
export function Parts({ parts, chips, onSelectTask, onSelectTurn, onOpenNotes }: { parts: FeedPart[]; chips?: RunDetail } & PartLinks) {
  return (
    <>
      {parts.map((p, i) => {
        if (typeof p === "string") return p;
        if ("em" in p) return <i key={i} dir="auto">{p.em}</i>;
        if ("at" in p) return <Clock key={i} t={p.at} />;
        if ("task" in p && chips && onSelectTask) return <TaskChip key={i} id={p.task} detail={chips} onSelect={onSelectTask} />;
        if ("task" in p) return onSelectTask ? <button key={i} type="button" className="link lk" data-task={p.task} onClick={() => onSelectTask(p.task)}>{p.task}</button> : p.task;
        if ("turn" in p) return onSelectTurn ? <button key={i} type="button" className="link lk" data-turn={p.turn} onClick={() => onSelectTurn(p.turn)}>Turn {p.turn}</button> : `Turn ${p.turn}`;
        if ("chat" in p) return <ChatRef key={i} id={p.chat} />;
        return onOpenNotes ? <button key={i} type="button" className="link lk" data-notes={p.notes} title={`Open version ${p.notes} of the notes`} onClick={() => onOpenNotes(p.notes)}>v{p.notes}</button> : `v${p.notes}`;
      })}
    </>
  );
}

/** A line with a time and a glyph (a row of the feed, of a turn's calls, of a task's history).
 *  `before`: what stands before the sentence (who did it). */
export function Line({ t, glyph, tone, parts, note, full, rule, before, ...links }: {
  t: number | null; glyph: string; tone: string; parts: FeedPart[]; note?: string; full?: string; rule?: boolean; before?: ReactNode;
} & PartLinks) {
  return (
    <div className={`feed-row tone-${tone}${rule ? " turn" : ""}`}>
      <span className="t" title={t == null ? undefined : dateTime(t)}>{t == null ? "" : clockTime(t)}</span>
      <span className="g">{glyph}</span>
      <span className="s">{before}<Parts parts={parts} {...links} />{note && <span className="dm" title={full}> · {note}</span>}</span>
    </div>
  );
}

/** The row of a text that is being loaded, and the row of one that could not be, with Retry. */
export const TextLoading = () => <div className="typing rd-loading"><span className="dots"><i /><i /><i /></span> Loading…</div>;
export const TextError = ({ what, message, onRetry }: { what: string; message?: string; onRetry(): void }) => (
  <div className="note error rd-failed" title={message}>Couldn't load {what}. <button type="button" className="link" onClick={onRetry}>Retry</button></div>
);

/** A command to copy: the app's code block, with exactly `text` on the clipboard (no line end). */
export function CopyCmd({ text, label = "git" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, (e) => console.error(e)); };
  return (
    <div className="md-code rd-cmd">
      <div className="md-code-head"><span>{label}</span><button type="button" className="md-copy" data-copy={text} onClick={copy}>{copied ? "Copied" : "Copy"}</button></div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

/** What a run that started in a folder with uncommitted changes says about them: they were left out. */
export function DirtyNote({ git }: { git: RunGit | undefined }) {
  if (!git?.dirtyAtStart) return null;
  return <div className="note rd-dirty">Uncommitted changes in this folder are not part of the run{git.baseRef ? `; it started from commit ${git.baseRef.slice(0, 7)}` : ""}.</div>;
}

/** For a view of the dock: it shows from its top. The dock's body is one scroller for every view,
 *  and keeps where the view before was scrolled to. Returns the ref of the view's root. */
export function useDockTop(): RefObject<HTMLDivElement | null> {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { const body = root.current?.closest(".dock-body"); if (body) body.scrollTop = 0; }, []);
  return root;
}
