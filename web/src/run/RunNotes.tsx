// The orchestrator's notes in the dock: the latest version, and every earlier one a step away,
// each with what made it (a section that was edited is marked in the text). A version never
// changes, so its text is fetched once.
import { useLayoutEffect, useRef, useState } from "react";
import "./dock.css";
import "./detail.css";
import { useStore } from "../store.ts";
import { Markdown } from "../Markdown.tsx";
import { notesChange, notesLine } from "../logic/runfeed.ts";
import { Clock, Parts, TextError, TextLoading, useDockTop } from "./bits.tsx";
import { useNotes } from "./texts.ts";
import type { RunDetail } from "../types.ts";

export interface RunNotesProps {
  runId: string;
  detail: RunDetail;
  /** The version shown; null: the newest one, whichever that becomes. Left out, the view keeps it itself. */
  at?: number | null;
  onAt?(v: number | null): void;
}

export function RunNotes({ runId, detail, at, onAt }: RunNotesProps) {
  const agent = useStore((s) => s.runs[runId]?.agent);
  const [own, setOwn] = useState<number | null>(null);
  const top = useDockTop();
  const want = at !== undefined ? at : own;
  const versions = detail.notes;
  const newest = versions[versions.length - 1];
  // While the user has not stepped back the newest version shows, also the ones still to come.
  const found = want == null ? -1 : versions.findIndex((n) => n.v === want);
  const i = found < 0 ? versions.length - 1 : found;
  const cur = versions[i];
  const text = useNotes(runId, cur?.v ?? 0);
  const change = cur ? notesChange(detail, cur.v) : null;
  // The section this version changed is marked at its heading, found by its words in the drawn text.
  const body = useRef<HTMLDivElement>(null);
  const heading = change?.heading ?? "";
  useLayoutEffect(() => {
    for (const h of body.current?.querySelectorAll("h1, h2, h3, h4, h5, h6") ?? []) h.classList.toggle("rd-changed", !!heading && h.textContent?.trim() === heading);
  });
  if (!cur || !newest) return <div className="run-notes" ref={top}><div className="note rd-nothing">The orchestrator has written no notes yet. It keeps them between its turns: what is done, what is left and what it decided.</div></div>;
  const go = (k: number) => { const v = versions[k]?.v; if (v == null) return; const next = v === newest.v ? null : v; (onAt ?? setOwn)(next); };
  return (
    <div className="run-notes" ref={top} data-v={cur.v}>
      <div className="rd-head rd-notes-head">
        <span className="rd-title">Notes</span>
        <span className="rd-sub rd-notes-line">
          <Parts parts={notesLine(cur, change)} /> · <Clock t={cur.at} /> · {cur.size.toLocaleString("en-US")} characters
        </span>
        <span className="grow" />
        {cur.v !== newest.v && <button type="button" className="link rd-latest" onClick={() => go(versions.length - 1)}>Latest (v{newest.v})</button>}
        {versions.length > 1 && (
          <span className="sub-nav">
            <button type="button" className="icon-btn sm" title="Earlier version" aria-label="Earlier version" disabled={i === 0} onClick={() => go(i - 1)}>‹</button>
            <span className="rd-step">{i + 1}/{versions.length}</span>
            <button type="button" className="icon-btn sm" title="Later version" aria-label="Later version" disabled={i === versions.length - 1} onClick={() => go(i + 1)}>›</button>
          </span>
        )}
      </div>
      {text.s === "loading" && <TextLoading />}
      {text.s === "error" && <TextError what="the notes" message={text.message} onRetry={text.retry} />}
      {text.s === "none" && <div className="note">This version of the notes is not recorded.</div>}
      {text.s === "ok" && <div className="rd-md rd-text" ref={body}><Markdown text={text.value.text} agent={agent} /></div>}
    </div>
  );
}
