// The mic marks (architecture VC-23): which user messages this app sent by voice, kept on this device only. At send the engine notes
// `{chat, branch, before, text}`; when the message arrives in the branch's items, the first user item at `before` or later with that text
// is marked. The marks are the item indexes per chat and branch, at most 500 (the oldest dropped), and go to the kv as one JSON text
// (`aiwb.voice.spoken`). All functions are pure; the state is never changed in place, and a call that changes nothing returns the state
// it was given, so a store can tell by identity.

export const MARKS_KEY = "aiwb.voice.spoken";
export const MARKS_CAP = 500;
/** A sent turn whose message never arrives (the send failed) is forgotten after this many newer ones. */
export const PENDING_CAP = 20;

const MAIN = "main";

export type Mark = { chat: string; branch: string; index: number };
export type Pending = { chat: string; branch: string; before: number; text: string };
/** What is looked at of an item of a branch's list. */
export type MarkItem = { kind: string; text?: string };

export type Marks = {
  /** Oldest first. */
  marks: readonly Mark[];
  pending: readonly Pending[];
  /** `<chat>:<branch>:<index>` of every mark, for `isMarked`. */
  index: ReadonlySet<string>;
};

const keyOf = (chat: string, branch: string, index: number): string => `${chat}:${branch || MAIN}:${index}`;

function make(marks: readonly Mark[], pending: readonly Pending[]): Marks {
  return { marks, pending, index: new Set(marks.map((m) => keyOf(m.chat, m.branch, m.index))) };
}

export const emptyMarks = (): Marks => make([], []);

/** A turn sent by voice: `before` is the count of the branch's items when it was sent, `text` the text sent. */
export function noteSent(m: Marks, sent: Pending): Marks {
  const pending = [...m.pending, { ...sent, branch: sent.branch || MAIN }].slice(-PENDING_CAP);
  return make(m.marks, pending);
}

/** The branch's items, after a change: marks the message of each turn noted for this chat and branch that has arrived. */
export function matchArrived(m: Marks, chat: string, branch: string, items: readonly MarkItem[]): Marks {
  const b = branch || MAIN;
  let marks = m.marks;
  let index = m.index;
  const pending: Pending[] = [];
  for (const p of m.pending) {
    if (p.chat !== chat || p.branch !== b) { pending.push(p); continue; }
    let at = -1;
    for (let i = Math.max(0, p.before); i < items.length; i++) {
      const it = items[i];
      if (it.kind === "user" && (it.text ?? "").trim() === p.text.trim() && !index.has(keyOf(chat, b, i))) { at = i; break; }
    }
    if (at < 0) { pending.push(p); continue; }
    marks = [...marks, { chat, branch: b, index: at }];
    index = new Set(index).add(keyOf(chat, b, at));
  }
  if (pending.length === m.pending.length) return m;
  return make(marks.slice(-MARKS_CAP), pending);
}

export const isMarked = (m: Marks, chat: string, branch: string, index: number): boolean => m.index.has(keyOf(chat, branch, index));

/** Drops the marks and the noted turns of every chat that is not in `chatKeys` (the ids of the chats that exist). */
export function prune(m: Marks, chatKeys: Iterable<string>): Marks {
  const live = new Set(chatKeys);
  const marks = m.marks.filter((x) => live.has(x.chat));
  const pending = m.pending.filter((x) => live.has(x.chat));
  return marks.length === m.marks.length && pending.length === m.pending.length ? m : make(marks, pending);
}

/** The text for the kv: the marks only (a noted turn that has not arrived is not kept across a restart). */
export const serialiseMarks = (m: Marks): string => JSON.stringify(m.marks.map((x) => [x.chat, x.branch, x.index]));

/** The marks from the kv text; text that does not parse, and entries that are not a mark, are nothing. */
export function parseMarks(text: string | null): Marks {
  if (text === null) return emptyMarks();
  let v: unknown;
  try { v = JSON.parse(text); } catch { return emptyMarks(); }
  if (!Array.isArray(v)) return emptyMarks();
  const marks: Mark[] = [];
  const seen = new Set<string>();
  for (const e of v) {
    if (!Array.isArray(e) || typeof e[0] !== "string" || typeof e[1] !== "string") continue;
    const i = e[2];
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0) continue;
    const k = keyOf(e[0], e[1], i);
    if (seen.has(k)) continue;
    seen.add(k);
    marks.push({ chat: e[0], branch: e[1] || MAIN, index: i });
  }
  return make(marks.slice(-MARKS_CAP), []);
}
