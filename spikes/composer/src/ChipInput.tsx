// The composer's text input: plain text with board-reference chips in it. The same on every platform; only the
// field it draws with differs (ChipField.tsx native, ChipField.web.tsx for the web).
//
// The truth is a Doc (logic/chipdoc.ts): text and Refs in order. The field shows layout(doc).text, with each chip as
// a styled run of characters. What the field reports (a new string, a new selection) is applied to the Doc by
// applyChange and snap, and the field is then told what the Doc says (its text, and a selection when that moved).
// The message is serialize(doc): the text with each reference as its inline tag, refs.ts's own form.
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { applyChange, beforeCaret, copyOf, docOf, insertRef as insertRefAt, layout, serialize, serializeRef, snap, type Doc, type Ref, type Span } from "./logic/chipdoc";
import { ChipField } from "./ChipField";
import type { Piece } from "./fieldtypes";

export type ChipInputHandle = {
  /** Puts a reference chip at the caret (or where the caret last was, or at the end). */
  insertRef(ref: Ref): void;
  /** Replaces everything with `value` (tags become chips). */
  set(value: string): void;
  focus(): void;
  /** The message text now. */
  value(): string;
};

type Props = {
  placeholder?: string;
  /** The new message text, and the text of the caret's line before the caret (for @ mentions). */
  onChange?(value: string, beforeCaret: string): void;
  onSelection?(s: Span): void;
  /** The selection as the field reported it, before it is snapped (for the checks). */
  onRaw?(s: Span): void;
  /** What the field shows now (string, chips, selection) and the message, after every change: for the checks. */
  onState?(s: { text: string; chips: [number, number][]; selection: Span; value: string }): void;
  /** Turns off the keyboard's own corrections, so that a check types what it types. */
  plain?: boolean;
  maxHeight?: number;
  testID?: string;
};

const piecesOf = (doc: Doc): Piece[] => doc.map((p) => (typeof p === "string" ? { text: p } : { text: layout([p]).text, chip: p.kind }));

export const ChipInput = forwardRef<ChipInputHandle, Props>(function ChipInput({ placeholder, onChange, onSelection, onRaw, onState, plain, maxHeight = 160, testID }, handle) {
  const field = useRef<TextInput>(null);
  const [doc, setDocState] = useState<Doc>([]);
  const [selection, setSelectionState] = useState<Span>({ start: 0, end: 0 });
  // The latest of both, for the events that come between two renders.
  const now = useRef({ doc, selection });
  const put = (d: Doc, s: Span) => {
    now.current = { doc: d, selection: s };
    setDocState(d);
    setSelectionState(s);
    tell(d, s);
  };
  const known = useRef<Ref[]>([]); // every reference this input has held, for a paste of copied chips
  const learn = (d: Doc) => { for (const p of d) if (typeof p !== 'string' && !known.current.some((k) => serializeRef(k) === serializeRef(p))) known.current.push(p); };
  const shown = useMemo(() => layout(doc), [doc]);

  // What the field shows is told to the owner from the handler that changed it, so that both go in one render: told from an
  // effect it was a second render for every key, and a burst of keys (a line wrapping) went past React's limit on nested updates.
  const tell = (d: Doc, s: Span) => {
    const l = layout(d);
    onState?.({ text: l.text, chips: l.chips.map((c) => [c.start, c.end]), selection: s, value: serialize(d) });
  };
  useEffect(() => tell(now.current.doc, now.current.selection), []);

  const changed = (d: Doc, caret: number) => onChange?.(serialize(d), beforeCaret(d, caret));

  const onText = useCallback((next: string) => {
    const { doc: d0, selection: s0 } = now.current;
    const c = applyChange(d0, next, s0, known.current);
    if (c.same) return;
    learn(c.doc);
    put(c.doc, { start: c.caret, end: c.caret });
    changed(c.doc, c.caret);
  }, [onChange]);

  const onSel = useCallback((s: Span) => {
    onRaw?.(s);
    const { doc: d0, selection: s0 } = now.current;
    // the field may report a selection of the text before the last edit (it comes after the string, or before it)
    if (s.end > layout(d0).text.length) return;
    if (s.start === s0.start && s.end === s0.end) return; // the field says what it was told: no update (a field that answers each one with an event would loop)
    const snapped = snap(layout(d0).chips, s0, s);
    now.current = { doc: d0, selection: snapped };
    setSelectionState(snapped); // when it differs from what the field has, the field is moved
    tell(d0, snapped);
    onSelection?.(snapped);
    onChange?.(serialize(d0), beforeCaret(d0, snapped.end));
  }, [onChange, onSelection]);

  useImperativeHandle(handle, () => ({
    insertRef(ref) {
      const { doc: d0, selection: s0 } = now.current;
      const r = insertRefAt(d0, s0, ref);
      learn(r.doc);
      put(r.doc, { start: r.caret, end: r.caret });
      changed(r.doc, r.caret);
      field.current?.focus();
    },
    set(value) {
      const d = docOf(value);
      learn(d);
      const end = layout(d).text.length;
      put(d, { start: end, end });
      changed(d, end);
    },
    focus() { field.current?.focus(); },
    value: () => serialize(now.current.doc),
  }), [onChange]);

  return (
    <ChipField
      ref={field}
      pieces={piecesOf(doc)}
      text={shown.text}
      selection={selection}
      onText={onText}
      onSelection={onSel}
      copyText={() => {
        const s = now.current.selection;
        return s.start === s.end ? null : copyOf(now.current.doc, s);
      }}
      onCut={() => {
        const { doc: d0, selection: s0 } = now.current;
        const t = layout(d0).text;
        const lo = Math.min(s0.start, s0.end), hi = Math.max(s0.start, s0.end);
        onText(t.slice(0, lo) + t.slice(hi));
      }}
      placeholder={placeholder}
      maxHeight={maxHeight}
      plain={plain}
      testID={testID}
    />
  );
});
