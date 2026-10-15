// The rows of a thread, in order (the old page's ChatView.tsx's Thread, as data): what the list draws from the first note of a fork to the
// bar at the foot. A pure function of what the store says, so that its arrangement is tested without a screen. A row has a stable key
// (a branch's item is keyed by the branch and its place, so another branch's thread draws its messages anew, B-TH-18).
import type { Item } from "@aiwb/core/types.ts";
import type { Said } from "@aiwb/core/logic/messageimages.ts";
import { prefixMark } from "@aiwb/core/logic/prefix.ts";
import type { WaitLine } from "@aiwb/core/logic/waits.ts";

export type Row =
  | { kind: "forked"; key: "forked" }
  | { kind: "empty"; key: "empty" }
  | { kind: "item"; key: string; item: Item; index: number | undefined; readOnly: boolean }
  | { kind: "mark"; key: "mark"; at: number }
  | { kind: "sending"; key: "sending"; said: Said }
  | { kind: "typing"; key: "typing"; text: string }
  | { kind: "waiting"; key: "waiting"; text: string }
  | { kind: "wait"; key: string; id: string; text: string };

export type RowsIn = {
  /** The chat is a fork of another chat (the note at the top). */
  forked: boolean;
  /** The branch's thread is here (a chat whose list is not loaded draws no empty state). */
  loaded: boolean;
  /** The items shown: the branch's, cut at a pending move's point. A hole (null) is skipped. */
  items: readonly (Item | null | undefined)[];
  /** The history a branch send keeps in the place of the new branch's list, read-only. */
  kept: readonly (Item | null | undefined)[] | null;
  branch: string;
  /** Where the part copied from the source ends (logic/prefix.ts prefixEnd). */
  end: number;
  /** The message that was sent and is not in a list yet. */
  sent: Said | null;
  /** The status line while the branch is busy ("" for none), and what an idle chat waits on. */
  typing: string;
  waiting: string;
  lines: readonly WaitLine[];
};

const KINDS = new Set<string>(["user", "text", "tool", "perm", "note", "subresult"]);

/** Whether an item is drawn at all: the mark that ends a turn is never, an item the client does not know is skipped (B-TH-06), and a
 *  note with no text draws nothing (B-TH-05). Such an item has no row, and the places of the others stay what they are. */
export const drawn = (item: Item | null | undefined): item is Item => !!item && KINDS.has(item.kind) && !(item.kind === "note" && !item.text);

/** The rows, top to bottom. */
export function threadRows(i: RowsIn): Row[] {
  const rows: Row[] = [];
  if (i.forked) rows.push({ kind: "forked", key: "forked" });
  if (i.loaded && !i.items.length && !i.sent) rows.push({ kind: "empty", key: "empty" });
  if (i.kept) {
    i.kept.forEach((item, n) => { if (drawn(item)) rows.push({ kind: "item", key: `kept:${n}`, item, index: undefined, readOnly: true }); });
  } else {
    const mark = i.loaded ? prefixMark(i.end, i.items.length) : null;
    i.items.forEach((item, n) => {
      if (n === mark) rows.push({ kind: "mark", key: "mark", at: i.end });
      if (drawn(item)) rows.push({ kind: "item", key: `${i.branch}:${n}`, item, index: n, readOnly: n < i.end });
    });
    if (mark === i.items.length) rows.push({ kind: "mark", key: "mark", at: i.end });
  }
  if (i.sent) rows.push({ kind: "sending", key: "sending", said: i.sent });
  if (i.typing) rows.push({ kind: "typing", key: "typing", text: i.typing });
  if (i.waiting) rows.push({ kind: "waiting", key: "waiting", text: i.waiting });
  for (const l of i.lines) rows.push({ kind: "wait", key: `wait:${l.id}`, id: l.id, text: l.text });
  return rows;
}

/** Whether the list has nothing to scroll through but the empty state, the note of a fork and the lines at the foot: it is drawn
 *  centred in a plain view then, and is a list from the first item. */
export const isShort = (rows: readonly Row[]): boolean => !rows.some((r) => r.kind === "item" || r.kind === "mark" || r.kind === "sending");
