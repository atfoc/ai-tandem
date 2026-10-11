// What a tool card shows, decided from its item (ToolCard.tsx draws it). DOM-free.
//
// A card is of one of five kinds, by the tool's name: a shell command (Bash; Pi's bash and
// powershell), an edit (Edit, MultiEdit; Pi's edit), a write (Write; Pi's write), a delete (Cursor's
// Delete), or any other tool, which keeps the card it had: its name, its input, its result. The
// three agents name an input's fields differently, and all are read: file_path or path, old_string
// and new_string or oldText and newText, one pair or a list of them (`edits`). A call of the first
// four kinds whose input lacks what the kind is read by (no command, no path) is drawn as any
// other tool, so nothing it carries is hidden.
//
// cardRow is the closed row's part, cheap; cardParts is the open card, made only for a card that is
// open, since it makes the diffs. Nothing here throws on an item, whatever it holds: a field of
// another type is a field that is not there.
//
// clipText and clipRows keep a long text and a long change out of the page: its first and its last
// part, and how much lies between them, until the user asks for all of it.

import type { Item } from "../types.ts";
import { tildeBy } from "./chatserver.ts";
import { CELLS, lineDiff, type DiffRow, type LineDiff } from "./linediff.ts";

export type CardKind = "shell" | "edit" | "write" | "delete" | "other";
/** running: no result yet; stopped: its subagent ended before the result (live is false); denied:
 *  the user refused it; done: it has a result, which may be empty. */
export type CardState = "running" | "denied" | "stopped" | "done";

/** One part of an open card, drawn in order.
 *  path: the file, with the lines the change adds and removes, or the lines a written file has.
 *  text: a titled text (the command, the output, the content, an input, a result). lead: a line
 *  before it (the agent's description of a command); lang: the language it is coloured as; failed:
 *  it is the output of a call that failed. An empty text is its title alone.
 *  change: one edit's diff. note: one line that says what is missing. */
export type Part =
  | { part: "path"; path: string; full: string; added?: number; removed?: number; lines?: number }
  | { part: "text"; title: string; text: string; lead?: string; lang?: string; failed?: boolean }
  | { part: "change"; title: string; diff: LineDiff }
  | { part: "note"; text: string };

/** Where the call ran: its chat's folder and its server's home, by which a path is shortened. */
export type Where = { cwd?: string; home?: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const short = (n: string) => n.replace(/^mcp__board__/, "");
const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string) => `${count(n)} ${one}${n === 1 ? "" : "s"}`;

// ---- the input

const CLOSERS = ['"}', "}", '"]}', '"}]}', "]}", "}]}"];

/** A streamed input read before it is whole: closed where it stops, so that what has arrived shows
 *  (a Write's path and the content so far). whole: it needed no closing. null: nothing of it can be
 *  read yet, as one that stops in its first field's name. A field that stops in its name or before
 *  its value is left out, with what follows the last comma. Only its texts are to be relied on: a
 *  number that stops half-way is read as the digits that came. */
export function readPartial(partial: string): { value: unknown; whole: boolean } | null {
  try { return { value: JSON.parse(partial), whole: true }; } catch { /* not whole yet */ }
  let cut = partial;
  const u = /\\u[0-9a-fA-F]{0,3}$/.exec(cut); // an escape that stops half-way
  if (u) cut = cut.slice(0, u.index);
  else { let n = 0; while (n < cut.length && cut[cut.length - 1 - n] === "\\") n++; if (n % 2) cut = cut.slice(0, -1); }
  const close = (text: string, ends: string[]) => {
    for (const end of ends) { try { const v = obj(JSON.parse(text + end)); if (v && Object.keys(v).length) return { value: v as unknown, whole: false }; } catch { /* the next one */ } }
    return null;
  };
  const comma = cut.lastIndexOf(",");
  return close(cut, CLOSERS) ?? (comma > 0 ? close(cut.slice(0, comma), ["}", "]}", "}]}"]) : null);
}

/** The call's input: the item's own; else what its streamed text holds so far. arriving: that text
 *  is not whole yet; raw is the text itself then. */
function inputOf(item: Item): { input: unknown; arriving: boolean; raw: string } {
  if (item.input !== undefined && item.input !== null) return { input: item.input, arriving: false, raw: "" };
  const partial = str(item.partial) ?? "";
  if (!partial) return { input: undefined, arriving: false, raw: "" };
  const r = readPartial(partial);
  return r?.whole ? { input: r.value, arriving: false, raw: "" } : { input: r?.value, arriving: true, raw: partial };
}

type Edit = { old: string; next: string; all: boolean };
/** rest: what the input holds besides what the card draws (restOf). */
type Read =
  | { kind: "shell"; command: string; description: string; lang: string; rest: string }
  | { kind: "edit"; path: string; edits: Edit[]; omitted: boolean; rest: string }
  | { kind: "write"; path: string; content: string | undefined; rest: string }
  | { kind: "delete"; path: string; content: string | undefined; omitted: boolean; rest: string }
  | { kind: "other" };

/** The fields a kind's card draws, or reads to draw. */
const FILE_FIELDS = ["file_path", "path", "old_string", "new_string", "oldText", "newText", "edits", "replace_all", "texts_omitted"];
const DRAWN = { shell: ["command", "description"], edit: FILE_FIELDS, write: ["file_path", "path", "content"], delete: FILE_FIELDS };
const REST = { fields: 6, chars: 60 };

/** The other fields of an input, as one line: "timeout: 120000 · run_in_background: true". The
 *  card of before showed the whole input; of a kind's card nothing the input holds is hidden. A
 *  long value is cut, and after six fields the line ends with "…". */
function restOf(i: Obj, drawn: string[]): string {
  const keys = Object.keys(i).filter((k) => !drawn.includes(k) && i[k] !== undefined);
  const one = (k: string) => {
    let v: string;
    try { v = typeof i[k] === "string" ? (i[k] as string) : JSON.stringify(i[k]) ?? ""; } catch { v = ""; }
    v = v.replace(/\s+/g, " ");
    return `${k}: ${v.length > REST.chars ? v.slice(0, REST.chars - 1) + "…" : v}`;
  };
  return [...keys.slice(0, REST.fields).map(one), ...(keys.length > REST.fields ? ["…"] : [])].join(" · ");
}

const SHELL: Record<string, string> = { Bash: "bash", bash: "bash", powershell: "" }; // the language its command is coloured as
const EDIT = new Set(["Edit", "MultiEdit", "edit"]), WRITE = new Set(["Write", "write"]);

/** One edit of an input: Claude's and Cursor's names, or Pi's. A new file has no old text. */
function edit(e: Obj): Edit | null {
  const old = str(e.old_string) ?? str(e.oldText), next = str(e.new_string) ?? str(e.newText);
  return old === undefined && next === undefined ? null : { old: old ?? "", next: next ?? "", all: e.replace_all === true };
}

function read(name: string, input: unknown): Read {
  const i = obj(input);
  if (!i) return { kind: "other" };
  if (Object.hasOwn(SHELL, name)) {
    const command = str(i.command);
    const description = (str(i.description) ?? "").trim();
    // (a description that is no text is not drawn as one: it is told with the rest)
    return command?.trim() ? { kind: "shell", command, description, lang: SHELL[name], rest: restOf(i, typeof i.description === "string" ? DRAWN.shell : ["command"]) } : { kind: "other" };
  }
  const path = str(i.file_path) || str(i.path);
  if (!path) return { kind: "other" };
  const omitted = i.texts_omitted === true; // Cursor's texts were over the server's bound
  if (EDIT.has(name)) {
    const listed = Array.isArray(i.edits) ? i.edits.map((e) => { const o = obj(e); return o && edit(o); }).filter((e) => !!e) : [];
    const one = edit(i);
    return { kind: "edit", path, edits: listed.length ? listed : one ? [one] : [], omitted, rest: restOf(i, DRAWN.edit) };
  }
  if (WRITE.has(name)) return { kind: "write", path, content: str(i.content), rest: restOf(i, str(i.content) === undefined ? ["file_path", "path"] : DRAWN.write) };
  if (name === "Delete") return { kind: "delete", path, content: str(i.old_string), omitted, rest: restOf(i, DRAWN.delete) };
  return { kind: "other" };
}

const nameOf = (item: Item): string => str(item.name) ?? "";

/** The result as a text; undefined while there is none. One that is no text is told as JSON. */
function resultOf(item: Item): string | undefined {
  const r: unknown = item.result;
  if (r === undefined || typeof r === "string") return r;
  try { return JSON.stringify(r) ?? ""; } catch { return ""; }
}

export function cardState(item: Item, live: boolean): CardState {
  if (item.denied) return "denied";
  return item.result === undefined ? (live ? "running" : "stopped") : "done";
}

// ---- the closed row

/** The most of a line the closed row holds. */
const HINT = 160;

/** A path as a card shows it: from the chat's folder when it lies in it, else with the server's
 *  home as "~". */
export function shownPath(path: string, where: Where = {}): string {
  const cwd = where.cwd?.replace(/\/+$/, "");
  if (cwd && path.startsWith(cwd + "/")) return path.slice(cwd.length + 1);
  return tildeBy(where.home, path);
}

/** A command's first line that says something, and "…" when more follows it. */
function firstLine(command: string): string {
  let at = 0;
  for (;;) {
    const end = command.indexOf("\n", at), line = command.slice(at, end < 0 ? command.length : end).trim();
    if (line || end < 0) {
      const more = end >= 0 && /\S/.test(command.slice(end));
      return line.length > HINT ? line.slice(0, HINT - 1) + "…" : more ? line + " …" : line;
    }
    at = end + 1;
  }
}

/** The closed row: the card's kind and state, and the one line beside the label: a command's first
 *  line, or the file's path ("" for any other tool). */
export function cardRow(item: Item, live: boolean, where: Where = {}): { kind: CardKind; state: CardState; hint: string } {
  const r = read(nameOf(item), inputOf(item).input);
  const hint = r.kind === "shell" ? firstLine(r.command) : r.kind === "other" ? "" : shownPath(r.path, where);
  return { kind: r.kind, state: cardState(item, live), hint };
}

/** The line as it stands beside a label: none when the label says all of it already, as "Ran
 *  `ls -la`" says the command (the label writes a command's blanks as one space each, and goes
 *  on with its next lines). */
export function hintBeside(label: string, hint: string): string {
  const said = hint.replace(/ …$/, "").replace(/\s+/g, " ");
  return said && !label.includes(said) ? hint : "";
}

// ---- the open card

const FILE = { running: "Still running: no result yet.", denied: "Denied: the file was not changed.", stopped: "Stopped before it gave a result: the file may not be changed." };
/** What a card says in the place of a result it has not. */
const NO_RESULT: Record<CardKind, Record<Exclude<CardState, "done">, string>> = {
  shell: { running: "Still running: no output yet.", denied: "Denied: the command did not run.", stopped: "Stopped before the command gave its output." },
  edit: FILE, write: FILE, delete: FILE,
  other: { running: "Still running: no result yet.", denied: "Denied: the tool did not run.", stopped: "Stopped before it gave a result." },
};
/** What it says of a result that is empty: [of a call that failed, of one that did not]. */
const EMPTY: Record<CardKind, [string, string]> = {
  shell: ["Ended with no output.", "No output."],
  edit: ["Ended with no result: the file may not be changed.", ""], write: ["Ended with no result: the file may not be changed.", ""], delete: ["Ended with no result: the file may not be changed.", ""],
  other: ["Ended with no result.", "No result."],
};
export const ARRIVING = "The input is still arriving.", CUT_OFF = "The input was cut off: this is what arrived.";
const ROUGH = "too large to compare line by line";

const lineCount = (text: string): number => {
  let n = 0;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) n++;
  return text && !text.endsWith("\n") ? n + 1 : n;
};

/** The open card's parts, by kind:
 *    shell   "Command" (the whole command, with the agent's description before it), then "Output"
 *    edit    the path with the lines added and removed, then a change per edit
 *    write   the path with the content's line count, then "Content"
 *    delete  the path, then the deleted text as removed lines
 *    other   the tool's name with its input as JSON, then "Result"
 *  After them, for the first four, one line of what else the input holds (a command's timeout).
 *  Then a note for each thing that is missing: an input that is still arriving or was cut off, a
 *  change or a deleted text that the item does not carry, a result that is not there yet, was
 *  refused, never came or is empty. A file card tells its result only when the call failed: the
 *  agents' own say nothing but that the file was changed.
 *  Any other tool's input that is still arriving is the text that came, as it is: closed where it
 *  stops, it would show a number half-way as a whole one. */
export function cardParts(item: Item, live: boolean, where: Where = {}): Part[] {
  const name = nameOf(item), { input, arriving, raw } = inputOf(item);
  const r = read(name, input), state = cardState(item, live), failed = !!item.isError, out = resultOf(item);
  const parts: Part[] = [];
  const note = (text: string) => { if (text) parts.push({ part: "note", text }); };
  const file = (path: string, more: { added?: number; removed?: number; lines?: number } = {}) => parts.push({ part: "path", path: shownPath(path, where), full: path, ...more });
  const unfinished = () => { if (arriving) note(state === "running" ? ARRIVING : CUT_OFF); };

  switch (r.kind) {
    case "shell":
      parts.push({ part: "text", title: "Command", text: r.command, ...(r.description ? { lead: r.description } : {}), ...(r.lang ? { lang: r.lang } : {}) });
      break;
    case "edit": {
      let cells = CELLS; // one bound for the card: an edit gets what the ones before it left
      const diffs = r.edits.map((e) => { const d = lineDiff(e.old, e.next, { cells }); cells -= d.cells; return d; });
      const sum = (k: "added" | "removed") => diffs.reduce((n, d) => n + d[k], 0);
      file(r.path, diffs.length ? { added: sum("added"), removed: sum("removed") } : {});
      diffs.forEach((diff, n) => {
        const title = [diffs.length > 1 ? `Edit ${n + 1} of ${diffs.length}` : "Change", r.edits[n].all ? "every occurrence" : "", diff.exact ? "" : ROUGH].filter(Boolean).join(" · ");
        if (diff.rows.length) parts.push({ part: "change", title, diff });
        else note(`${title}: no line differs.`);
      });
      if (!diffs.length && !arriving) note(r.omitted ? "The change was too large to keep: its texts were left out." : "The change was not recorded.");
      break;
    }
    case "write":
      file(r.path, r.content ? { lines: lineCount(r.content) } : {});
      if (r.content) parts.push({ part: "text", title: "Content", text: r.content });
      else if (!arriving) note(r.content === "" ? "The file is empty." : "The content was not recorded.");
      break;
    case "delete": {
      const diff = r.content ? lineDiff(r.content, "") : null;
      file(r.path, diff ? { added: 0, removed: diff.removed } : {});
      if (diff?.rows.length) parts.push({ part: "change", title: "Deleted", diff });
      else note(r.omitted ? "The deleted text was too large to keep." : "The deleted text was not recorded.");
      break;
    }
    case "other": {
      let text = raw;
      if (!raw && input !== undefined) { try { text = JSON.stringify(input, null, 2) ?? ""; } catch { text = ""; } }
      parts.push({ part: "text", title: short(name) || "tool", text });
      if (!raw && input === undefined) note("The input was not recorded.");
      break;
    }
  }
  if (r.kind !== "other" && !arriving) note(r.rest);
  unfinished();

  if (state !== "done") note(NO_RESULT[r.kind][state]);
  else if (!out) note(EMPTY[r.kind][failed ? 0 : 1]);
  else if (r.kind === "shell") parts.push({ part: "text", title: "Output", text: out, failed });
  else if (r.kind === "other" || failed) parts.push({ part: "text", title: "Result", text: out, failed });
  return parts;
}

// ---- what is kept out of the page

/** How many edits an open card draws before it is asked for all. */
export const EDITS = 12;

/** The parts drawn: all of them, or the first EDITS changes and what is not a change. left: how
 *  many changes are not drawn. */
export function shownParts(parts: Part[], all: boolean): { parts: Part[]; left: number } {
  let seen = 0;
  const shown = all ? parts : parts.filter((p) => p.part !== "change" || ++seen <= EDITS);
  return { parts: shown, left: parts.length - shown.length };
}

type Bound = { lines: number; chars: number };
// A text of at most WHOLE is drawn whole; a longer one as its first HEAD and its last TAIL: of an
// output the end says most (the failure, the summary), so it gets more than the start.
const WHOLE: Bound = { lines: 24, chars: 2400 }, HEAD: Bound = { lines: 8, chars: 800 }, TAIL: Bound = { lines: 12, chars: 1200 };

/** What is left out, in words: by lines when whole lines are, else by characters (one long line). */
export type Left = { lines: number; chars: number };
export const leftText = (left: Left): string => `${left.lines > 0 ? plural(left.lines, "line") : plural(left.chars, "character")} left out`;

/** A long text as its first and last part. left: what lies between them; null for a text that is
 *  short enough to be drawn whole (it is the head, and the tail is ""). */
export function clipText(text: string): { head: string; tail: string; left: Left | null } {
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (t.length <= WHOLE.chars && lineCount(t) <= WHOLE.lines) return { head: t, tail: "", left: null };
  let cut = -1; // the head ends before the line break that ends its last line, or where its characters run out
  for (let n = 0; n < HEAD.lines; n++) { const at = t.indexOf("\n", cut + 1); if (at < 0 || at > HEAD.chars) { cut = HEAD.chars; break; } cut = at; }
  let from = t.length + 1; // the tail starts after the line break before its first line, or where its characters run out
  for (let n = 0; n < TAIL.lines; n++) { const at = t.lastIndexOf("\n", from - 2); if (at < cut || at < t.length - TAIL.chars) { from = Math.max(cut, t.length - TAIL.chars); break; } from = at + 1; }
  const between = t.slice(cut, from);
  let breaks = 0;
  for (let at = between.indexOf("\n"); at >= 0; at = between.indexOf("\n", at + 1)) breaks++;
  return { head: t.slice(0, cut), tail: t.slice(from), left: { lines: Math.max(0, breaks - 1), chars: between.length } };
}

// A change of at most ROWS rows is drawn whole; a longer one as its first and its last rows. A line
// over ROW_CHARS is cut in either.
const ROWS = 30, HEAD_ROWS = 18, TAIL_ROWS = 8, ROW_CHARS = 400;

/** A long change as its first and last rows, each line cut to ROW_CHARS. left: the rows between
 *  them (lines) and the characters cut from lines that are drawn; null for a change drawn whole. */
export function clipRows(rows: DiffRow[]): { head: DiffRow[]; tail: DiffRow[]; left: Left | null } {
  let chars = 0;
  const cut = (r: DiffRow): DiffRow => {
    if (r.kind === "skip" || r.text.length <= ROW_CHARS) return r;
    chars += r.text.length - ROW_CHARS;
    return { kind: r.kind, text: r.text.slice(0, ROW_CHARS) + "…" };
  };
  const whole = rows.length <= ROWS;
  const head = (whole ? rows : rows.slice(0, HEAD_ROWS)).map(cut), tail = whole ? [] : rows.slice(-TAIL_ROWS).map(cut);
  const lines = rows.length - head.length - tail.length;
  return { head, tail, left: lines || chars ? { lines, chars } : null };
}
