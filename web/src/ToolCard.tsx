// A tool call's card: in a chat's thread, in a subagent's drawer, in the pane of a run's own agent
// (all through ChatView's ItemView). Closed it is one row: the mark, the label, and beside it the
// command's first line or the file's path. Open it shows the call in parts, by its kind. What it
// shows is decided from the item by logic/toolcard.ts (the diffs by logic/linediff.ts); this file
// draws that. Nothing of an open card is made while the card is closed.
import { useMemo, useState, type ReactNode } from "react";
import { useStore, boardName } from "./store.ts";
import { select } from "./Sidebar.tsx";
import { Guard } from "./Guard.tsx";
import { lowlight } from "./highlight.ts";
import { toolVerb, toolDone } from "./logic/labels.ts";
import { listsOf, serverOfChat } from "./logic/serverlists.ts";
import { cardParts, cardRow, clipRows, clipText, hintBeside, leftText, shownParts, type Left, type Part, type Where } from "./logic/toolcard.ts";
import type { DiffRow } from "./logic/linediff.ts";
import type { ChatView, Item } from "./types.ts";

const safeParse = (s?: string) => { try { return s ? JSON.parse(s) : {}; } catch { return s ? { "…": s } : {}; } };
const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** A tool call. live is false in a subagent's thread once it ended: a call with no result was cut.
 *  An item the card cannot draw costs its own card, not the thread. */
export function ToolCard(p: { item: Item; chat: ChatView; live?: boolean }) {
  return <Guard what="this tool call" resetKey={p.item}><Card {...p} /></Guard>;
}

function Card({ item, chat, live = true }: { item: Item; chat: ChatView; live?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = typeof item.name === "string" ? item.name : "";
  const target = useStore((s) => {
    const id = (item.input as any)?.board;
    if (!id || !name.startsWith("mcp__board__")) return undefined;
    const b = s.boards[String(id)];
    return b && !b.archived ? b.id : undefined;
  });
  const home = useStore((s) => listsOf(s, serverOfChat(s, chat))?.home);
  const where = useMemo<Where>(() => ({ cwd: chat.cwd, home }), [chat.cwd, home]);
  const input: any = item.input ?? safeParse(item.partial);
  const running = live && item.result === undefined && !item.denied;
  const cut = !live && item.result === undefined && !item.denied; // its subagent ended mid-call
  const label = item.denied ? `${toolVerb(name, input, boardName)} — denied`
    : cut ? `${toolVerb(name, input, boardName)} — stopped`
    : running ? toolVerb(name, input, boardName) + "…"
    : toolDone(name, item.input, item.result, boardName);
  const row = useMemo(() => cardRow(item, live, where), [item, live, where]);
  const hint = hintBeside(label, row.hint);
  const show = () => {
    if (!target) return;
    select({ board: target, run: null, chat: target === chat.board ? chat.id : null });
  };
  return (
    <div className={`tool ${running ? "running" : ""} ${item.isError || item.denied ? "err" : ""} k-${row.kind}`}>
      <div className="tool-row" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{running ? <span className="spin" /> : cut ? "■" : item.isError || item.denied ? "!" : "✓"}</span>
        <span className="tool-label">{label}</span>
        <span className="tool-hint" title={hint || undefined}>{hint}</span>
        {target && !running && <button className="link" onClick={(e) => { e.stopPropagation(); show(); }}>Show</button>}
        <span className="tool-chev">{open ? "▴" : "▾"}</span>
      </div>
      {open && <Detail item={item} live={live} where={where} />}
    </div>
  );
}

/** The open card: its parts in order. A card of many edits draws the first of them until asked. */
function Detail({ item, live, where }: { item: Item; live: boolean; where: Where }) {
  const [all, setAll] = useState(false);
  const made = useMemo(() => cardParts(item, live, where), [item, live, where]);
  const { parts, left } = shownParts(made, all);
  const last = parts.findLastIndex((p) => p.part === "change"); // the edits not drawn follow the last one that is
  return (
    <div className="tool-detail">
      {parts.map((p, i) => (
        <PartView key={i} part={p}>
          {i === last && left > 0 && <div className="tool-omit"><span>⋯ {plural(left, "more edit")}</span><button type="button" className="link" onClick={() => setAll(true)}>Show all</button></div>}
        </PartView>
      ))}
    </div>
  );
}

function PartView({ part, children }: { part: Part; children?: ReactNode }) {
  switch (part.part) {
    case "path": return (
      <div className="tool-path" title={part.full}>
        <span className="tool-path-name">{part.path}</span>
        {part.added !== undefined && <span className="tool-counts"><span className="tool-add">+{part.added}</span> <span className="tool-del">−{part.removed}</span></span>}
        {part.lines !== undefined && <span className="tool-lines">{plural(part.lines, "line")}</span>}
      </div>
    );
    case "text": return <TextPart part={part} />;
    case "change": return <><ChangePart part={part} />{children}</>;
    case "note": return <div className="tool-note">{part.text}</div>;
  }
}

/** What lies between a long text's first and last part, and the control that shows all of it. */
function Omitted({ left, onAll }: { left: Left; onAll: () => void }) {
  return <div className="tool-omit"><span>⋯ {leftText(left)}</span><button type="button" className="link" onClick={onAll}>Show all</button></div>;
}
const Less = ({ onLess }: { onLess: () => void }) => <div className="tool-omit"><button type="button" className="link" onClick={onLess}>Show less</button></div>;

/** A titled text: the command, the output, a written file's content, an input, a result. A long one
 *  is its first and last part until all of it is asked for. */
function TextPart({ part }: { part: Extract<Part, { part: "text" }> }) {
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipText(part.text), [part.text]);
  const whole = all && !!clip.left;
  return (
    <div className={`tool-part${part.failed ? " failed" : ""}`}>
      <div className="tool-sub">{part.title}{part.failed && <span className="tool-flag"> · failed</span>}</div>
      {part.lead && <div className="tool-lead">{part.lead}</div>}
      {part.text && (
        <div className={`tool-text${whole ? " all" : ""}`}>
          <pre><Code text={whole ? part.text : clip.head} lang={part.lang} /></pre>
          {!whole && clip.left && <Omitted left={clip.left} onAll={() => setAll(true)} />}
          {!whole && clip.tail && <pre><Code text={clip.tail} lang={part.lang} /></pre>}
        </div>
      )}
      {whole && <Less onLess={() => setAll(false)} />}
    </div>
  );
}

/** The most of a text that is coloured: a longer one is drawn as it is. */
const COLOURED = 20_000;

/** A text coloured as code of a language the highlighter knows; as it is with no language. */
function Code({ text, lang }: { text: string; lang?: string }) {
  const tree = useMemo(() => (lang && text.length <= COLOURED && lowlight.registered(lang) ? lowlight.highlight(lang, text) : null), [text, lang]);
  return tree ? <code className="hljs">{tree.children.map(span)}</code> : <>{text}</>;
}
/** A node of the highlighter's tree: a text, or a span with its classes. */
const span = (n: any, i: number): ReactNode =>
  n.type === "text" ? n.value : n.type === "element" ? <span key={i} className={(n.properties?.className ?? []).join(" ")}>{(n.children ?? []).map(span)}</span> : null;

/** One edit's change: its lines removed and added, with the unchanged ones around them. */
function ChangePart({ part }: { part: Extract<Part, { part: "change" }> }) {
  const [all, setAll] = useState(false);
  const clip = useMemo(() => clipRows(part.diff.rows), [part.diff]);
  const whole = all && !!clip.left;
  const head = whole ? part.diff.rows : clip.head;
  return (
    <div className="tool-part">
      <div className="tool-sub">{part.title}</div>
      <div className={`tool-diff${whole ? " all" : ""}`}>
        {head.map(row)}
        {!whole && clip.left && <Omitted left={clip.left} onAll={() => setAll(true)} />}
        {!whole && clip.tail.map((r, i) => row(r, head.length + i))}
      </div>
      {whole && <Less onLess={() => setAll(false)} />}
    </div>
  );
}
/** (the sign is not selected with the line: a copied change is its lines) */
const row = (r: DiffRow, i: number) => (r.kind === "skip"
  ? <div key={i} className="diff-row skip">⋯ {plural(r.count, "unchanged line")}</div>
  : <div key={i} className={`diff-row ${r.kind}`}><span className="diff-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}</span><span className="diff-text">{r.text}</span></div>);
