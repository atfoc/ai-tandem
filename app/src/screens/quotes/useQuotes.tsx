// The quotes of a chat's composer (the old page's Quotes.tsx useComposerQuotes; package K5): the part `useQuotes` of the composer (screens/composer/
// parts.tsx). While writing: the comment field at the quoted passage (a float on the wide layouts of the web build, a sheet on the phone layout and
// on native), the draft's quotes marked in the thread (web) and a count above the text box that lists them.
//   quote(r)   ⌘L quoted r, or the Quote sheet did: the comment field opens (to edit it when it is in the draft already, else to add it).
//   count      the count of the draft's quotes, which opens their list; null when there are none.
//   float      the comment field, if one is open.
//   kept()     the draft's quotes as a press elsewhere would leave them: with the comment typed in an open field. For the draft saved when the
//              composer or the page goes away.
// readOnly: the composer is (the chat's server is not connected, or no longer has the chat): the draft's quotes stay as they are, listed and
// shown at their passages, and none is added, removed or commented on. A comment being typed as the composer becomes read-only is kept.
import { useCallback, useEffect, useRef, useState } from "react";

import { quoteKey } from "@aiwb/core/logic/quotes.ts";
import { quotePort } from "../../platform/quote";
import type { Reference } from "@aiwb/core/types.ts";

import type { QuotesHook } from "../composer/parts.tsx";
import { registerTaker } from "./bus.ts";
import { CommentSheet } from "./CommentSheet.tsx";
import { QuoteFloat } from "./QuoteFloat";
import { QuoteCount } from "./QuoteCount.tsx";
import { QuotesSheet } from "./QuotesSheet.tsx";
import { usePhone } from "../../ui/useLayout.ts";
import { withFloat, type Editing } from "./model.ts";
import { useSheetPath } from "./path.ts";

export const useQuotes: QuotesHook = ({ chat, quotes, setQuotes, readOnly, width = 0 }) => {
  const sheet = useSheetPath();
  const phone = usePhone();
  const [edit, setEdit] = useState<Editing | null>(null);
  const [list, setList] = useState(false);
  const now = useRef({ quotes, edit, readOnly });
  now.current = { quotes, edit, readOnly };

  /** Opens the comment field at r: to edit it when it is in the draft already, else to add it. */
  const open = (r: Reference) => {
    if (now.current.readOnly) return;
    const q = now.current.quotes.find((q) => quoteKey(q) === quoteKey(r));
    setEdit({ r: q ?? r, edit: !!q, text: q?.comment ?? "" });
  };
  /** Keeps what the field holds (see withFloat). */
  const keep = (f: Editing, enter: boolean) => {
    setQuotes((qs) => withFloat(qs, f, enter));
    setEdit(null);
  };
  const remove = (r: Reference) => setQuotes((qs) => qs.filter((q) => quoteKey(q) !== quoteKey(r)));
  useEffect(() => { if (readOnly && now.current.edit) keep(now.current.edit, false); }, [readOnly]);
  // no quotes left (the last one removed, or the draft cleared): the phone's sheet closes and does not come back with the next quote
  useEffect(() => { if (quotes.length === 0) setList(false); }, [quotes.length]);

  const latest = useRef((r: Reference) => {});
  latest.current = (r) => {
    if (now.current.edit) keep(now.current.edit, false);
    setList(false);
    open(r);
    quotePort.clearSelection(); // the mark shows it; the next selection starts clean
  };
  const quote = useCallback((r: Reference) => latest.current(r), []);
  const kept = useCallback(() => (now.current.edit ? withFloat(now.current.quotes, now.current.edit, false) : now.current.quotes), []);
  // The Quote sheet of the thread hands its quotes to this composer
  useEffect(() => registerTaker(chat, { quote: (r) => latest.current(r), quotes: () => now.current.quotes }), [chat]);

  // The draft's passages, and the one being quoted, stay marked in the thread (web).
  useEffect(() => quotePort.mark(chat, () => now.current.quotes, () => {
    const e = now.current.edit;
    return e && !e.edit ? quotePort.anchor(chat, e.r) : null;
  }), [chat, quotes, edit?.r, edit?.edit]);
  // A press on a marked passage opens its comment field (web).
  useEffect(() => quotePort.onMarkPress(chat, () => now.current.quotes, open), [chat]);

  const n = quotes.length;
  const field = edit && !readOnly ? {
    f: edit, onText: (text: string) => setEdit((e) => (e ? { ...e, text } : e)), onKeep: (enter: boolean) => keep(edit, enter), onCancel: () => setEdit(null),
    onRemove: edit.edit ? () => { remove(edit.r); setEdit(null); } : undefined,
  } : null;
  return {
    quote,
    kept,
    count: n > 0 ? (
      <>
        <QuoteCount quotes={quotes} open={list} width={width} onOpen={() => setList(true)} onClose={() => setList(false)} onRemove={readOnly ? undefined : remove}
          onPick={(q) => {
            setList(false);
            quotePort.show(chat, q, false);
            open(q);
          }} />
        {/* the phone's chip opens the sheet "Quoted in this message" and not the list; a comment typed in it, and a removal, change the draft as the float does */}
        {phone && list ? (
          <QuotesSheet chat={chat} quotes={quotes} readOnly={readOnly} onClose={() => setList(false)}
            onComment={(q, text) => setQuotes((qs) => withFloat(qs, { r: q, edit: true, text }, false))}
            onRemove={remove} />
        ) : null}
      </>
    ) : null,
    float: field ? (sheet ? <CommentSheet {...field} /> : <QuoteFloat chat={chat} {...field} />) : null,
  };
};
