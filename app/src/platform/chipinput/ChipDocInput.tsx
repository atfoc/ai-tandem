// The chip input over a document (AD-61 (a), package K2, from the composer spike's ChipInput.tsx): the state and the handlers
// of the native box, with the field it draws with passed in. ChipInput.native.tsx gives it the native field (a TextInput
// whose children are the runs); the dev gallery `?gallery=chipdoc` (app/src/dev/ChipDocGallery.tsx) gives it the spike's web
// field, so that its logic is checked in Chromium too (web/dev/checks/L4b-chipdoc.mjs). The composer never sees this
// file: it gets ChipInput, whose contract is types.ts.
//
// The truth is a Doc (chipdoc.ts): text and Refs in order. The field shows layout(doc).text, each chip a styled run of
// characters. What the field reports (a new string, a new selection, a key) is applied to the Doc by applyChange and snap,
// and the field is told what the Doc says (its text, and a selection when that moved). The value is serialize(doc).
//
// The two rules of the spike (AD-61), kept:
//  1. the owner is told of a change from the handler that made it (the state and onChange in one render), never from an
//     effect that runs after every key: that went past React's limit on nested updates when a burst of keys wrapped a line;
//  2. a selection the field has just reported is not given back to it (onSel returns early): the `selection` prop changes
//     only when the snapped selection differs from what the field said.
import React, { forwardRef, useImperativeHandle, useMemo, useRef, useState, type ComponentType, type Ref as ReactRef } from "react";

import { openInsertPopup } from "@aiwb/core/logic/insert.ts";
import { serializeRef } from "@aiwb/core/logic/refs.ts";
import type { KeyLike } from "../keys.types.ts";
import {
  applyChange, beforeCaret, copyOf, docOf, insertRef as insertRefAt, insertText, layout, replaceBeforeCaret as replaceAt, snap, toShown, toValue, valueOf,
  type Doc, type Ref, type Span,
} from "./chipdoc.ts";
import type { ChipInputHandle, ChipInputProps } from "./types.ts";

/** A run of the shown string: plain text, or a chip (of the kind of its reference). */
export type Run = { text: string; chip?: Ref["kind"] };

/** What the field is given: it shows `runs` (whose text is `text`) with `selection`, and reports what the platform did. */
export type FieldProps = {
  runs: Run[];
  /** The whole shown string (the web's field is a textarea that holds it as its value). */
  text: string;
  selection: Span;
  /** Changes when the field must be told its text again although the document did not change (an edit that was refused).
   *  React Native sends the runs to the platform's view only when their text or their attributes differ from the last
   *  ones it sent (Fabric's TextInputShadowNode compares them with isContentEqual, not by node), so the native field
   *  toggles an attribute that draws nothing on its parity. */
  rev: number;
  onText(next: string): void;
  onSelection(s: Span): void;
  /** The key the platform reports before the text it changes (react-native's onKeyPress: a character, "Enter", "Backspace"). */
  onKeyPress(key: string): void;
  /** The text of the selection as a copy puts it on the clipboard (tags for chips), or null for the field's own. Web only. */
  copyText(): string | null;
  /** A cut took copyText already: the selection is to be removed. Web only. */
  onCut(): void;
  placeholder: string;
  /** False while the box is locked or read-only: the platform's typing is stopped; its text can still be selected. */
  editable: boolean;
  readOnly: boolean;
  /** No autocorrect, spelling or capitals from the keyboard (the device checks type what they type). */
  plain?: boolean;
  testID: string;
};

/** What the field shows after a change, for the checks (the gallery's readouts, the device runner's collector). */
export type DocState = { text: string; chips: [number, number][]; selection: Span; value: string };

export type ChipDocInputProps = ChipInputProps & {
  /** The field; its `tapSnapDelay` (ms, default 0) is how long the view keeps a caret a tap put inside a chip before it is
   *  moved to the chip's edge (the document has the edge at once): a move sooner breaks the platform's double tap. */
  Field: ComponentType<FieldProps & { ref?: ReactRef<FieldHandle> }> & { tapSnapDelay?: number };
  /** Dev only (the galleries): what the field shows after every change, and the selection it reported before the snap. */
  onState?(s: DocState): void;
  onRaw?(s: Span): void;
  plain?: boolean;
};

/** What the box asks of its field. */
export type FieldHandle = { focus(): void; blur?(): void };

const NONE: Span = { start: 0, end: 0 };
const caretAt = (n: number): Span => ({ start: n, end: n });

/** What react-native's key press gives, as the keys port's object: no modifiers, and nothing to prevent (the field has
 *  taken the key already; a key the owner handled is undone by the box, see `pending`). */
export const keyOf = (key: string): KeyLike => {
  let prevented = false;
  return {
    key, code: key === "Enter" ? "Enter" : key === "Backspace" ? "Backspace" : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
    metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false,
    preventDefault() { prevented = true; }, stopPropagation() {}, get defaultPrevented() { return prevented; },
  };
};

/** Whether the change from `cur` to `next` is what the key `key` does at `sel` (and nothing more): the change a handled key
 *  made, which the box takes back. */
function isKeysChange(key: string, cur: string, next: string, sel: Span): boolean {
  const lo = Math.min(sel.start, sel.end), hi = Math.max(sel.start, sel.end);
  if (key === "Backspace") return next.length < cur.length && cur.startsWith(next.slice(0, Math.max(0, lo - 1))) && cur.endsWith(next.slice(next.length - (cur.length - hi)));
  const typed = key === "Enter" ? "\n" : key.length === 1 || [...key].length === 1 ? key : null;
  return typed !== null && next === cur.slice(0, lo) + typed + cur.slice(hi);
}

export const ChipDocInput = forwardRef<ChipInputHandle, ChipDocInputProps>(function ChipDocInput(props, handle) {
  const { Field, placeholder, locked = false, readOnly = false, testID = "composer-input", plain } = props;
  const field = useRef<FieldHandle>(null);
  const [doc, setDoc] = useState<Doc>([]);
  const [selection, setSelection] = useState<Span>(NONE);
  const [rev, setRev] = useState(0);
  // The latest of both, and of the props, for the events that come between two renders.
  const now = useRef({ doc, selection });
  const own = useRef(props);
  own.current = props;
  const known = useRef<Ref[]>([]); // every reference this box has held, for a paste of chips copied out of it
  const reported = useRef<[string, string] | null>(null); // what onChange was last given
  // a key the owner handled, with the field's text and selection when it came: the change it makes is taken back
  const pending = useRef<{ key: string; text: string; selection: Span } | null>(null);
  const marked = useRef<{ at: Span; doc: Doc } | null>(null); // where the insert popup was opened
  const shown = useMemo(() => layout(doc), [doc]);

  const learn = (d: Doc) => {
    for (const p of d) if (typeof p !== "string" && !known.current.some((k) => serializeRef(k) === serializeRef(p))) known.current.push(p);
  };

  /** The owner is told from the handler that made the change (rule 1); the same value and text before the caret twice is
   *  said once. */
  const tell = (d: Doc, s: Span) => {
    const value = valueOf(d), before = s.start === s.end ? beforeCaret(d, s.end) : "";
    if (own.current.onState) { const l = layout(d); own.current.onState({ text: l.text, chips: l.chips.map((c) => [c.start, c.end]), selection: s, value }); }
    const was = reported.current;
    if (was && was[0] === value && was[1] === before) return;
    reported.current = [value, before];
    own.current.onChange(value, before);
  };

  const put = (d: Doc, s: Span) => {
    learn(d);
    now.current = { doc: d, selection: s };
    setDoc(d);
    setSelection(s);
    tell(d, s);
  };

  /** The field shows something the document does not (a refused edit): it is told the document's text again. */
  const restore = () => {
    setRev((r) => r + 1);
    setSelection({ ...now.current.selection }); // a new object: the field's caret is put back too
  };

  const onText = (next: string) => {
    const { doc: d0, selection: s0 } = now.current;
    const key = pending.current;
    pending.current = null;
    const cur = layout(d0).text;
    // (the owner may have changed the box while it handled the key, e.g. sent and emptied it: the field's change is measured
    // from what the field had when the key came (native: the field took the key first) or from what it has now (web: the
    // owner's change reached the textarea before the browser acted on the key))
    const keys = key && (isKeysChange(key.key, key.text, next, key.selection) || isKeysChange(key.key, cur, next, s0));
    if (own.current.locked || own.current.readOnly || keys) {
      if (next !== cur) restore();
      return;
    }
    const c = applyChange(d0, next, s0, known.current);
    if (c.same) return;
    put(c.doc, caretAt(c.caret)); // (an edit not taken as it came, half a chip, gives other runs: the field is told them)
  };

  const onSel = (s: Span) => {
    own.current.onRaw?.(s);
    const { doc: d0, selection: s0 } = now.current;
    // the field may report a selection of the text before the last edit (it comes after the string, or before it)
    if (Math.max(s.start, s.end) > layout(d0).text.length) return;
    if (s.start === s0.start && s.end === s0.end) return; // the field says what it was told: no update (rule 2)
    const snapped = snap(layout(d0).chips, s0, s);
    now.current = { doc: d0, selection: snapped };
    tell(d0, snapped);
    // A tap inside a chip (a caret that is not an arrow's one step): moving the view at once made the second tap of a double
    // tap a tap of its own, so the view is moved after the double tap's time, unless a selection (the double tap's word) came
    // meanwhile. The document has the edge already: an insertion goes there.
    const wait = Field.tapSnapDelay ?? 0, tapped = s.start === s.end && Math.abs(s.start - s0.end) !== 1 && snapped.start !== s.start;
    // (meanwhile the prop is what the view has: React Native puts a differing prop back on the view at every render)
    if (wait && tapped) { setSelection(s); setTimeout(() => { if (now.current.selection === snapped) setSelection(snapped); }, wait); return; }
    setSelection(snapped); // when it differs from what the field has, the field is moved
  };

  const onKeyPress = (key: string) => {
    if (own.current.locked || own.current.readOnly) return;
    const { doc: d0, selection: s0 } = now.current;
    pending.current = null;
    if (own.current.onKey(keyOf(key))) pending.current = { key, text: layout(d0).text, selection: s0 };
  };

  useImperativeHandle(handle, () => ({
    caret() {
      const { doc: d, selection: s } = now.current;
      return { start: toValue(d, Math.min(s.start, s.end)), end: toValue(d, Math.max(s.start, s.end)) };
    },
    insertRef(ref: Ref, at?: { start: number; end: number } | null) {
      if (own.current.locked || own.current.readOnly) return;
      const { doc: d0, selection: s0 } = now.current;
      const r = insertRefAt(d0, at ? { start: toShown(d0, at.start), end: toShown(d0, at.end) } : s0, ref);
      put(r.doc, caretAt(r.caret));
      field.current?.focus();
    },
    replaceBeforeCaret(n: number, s: string) {
      if (own.current.locked || own.current.readOnly) return;
      const { doc: d0, selection: s0 } = now.current;
      const r = replaceAt(d0, s0, n, s);
      if (r) put(r.doc, caretAt(r.caret));
    },
    set(text: string) {
      const d = docOf(text), end = layout(d).text.length;
      marked.current = null;
      put(d, caretAt(end));
    },
    select(at: { start: number; end: number }) {
      const d = now.current.doc;
      put(d, { start: toShown(d, at.start), end: toShown(d, at.end) });
    },
    openInsert(at?: { start: number; end: number } | null) {
      if (own.current.locked || own.current.readOnly) return;
      const d = now.current.doc;
      marked.current = { at: at ? { start: toShown(d, at.start), end: toShown(d, at.end) } : now.current.selection, doc: d };
      openInsertPopup({
        insert(text: string) {
          const m = marked.current, { doc: d0 } = now.current;
          marked.current = null;
          // a box filled anew meanwhile (set) has no such place left: the text goes to its end
          const at = m && m.doc === d0 ? m.at : caretAt(layout(d0).text.length);
          const r = insertText(d0, at, text);
          put(r.doc, caretAt(r.caret));
          field.current?.focus();
        },
        cancel() {
          const m = marked.current;
          marked.current = null;
          if (m && m.doc === now.current.doc) setSelection({ ...m.at });
          field.current?.focus();
        },
      });
    },
    focus() { field.current?.focus(); },
  }), []);

  return (
    <Field
      ref={field}
      runs={doc.map((p) => (typeof p === "string" ? { text: p } : { text: layout([p]).text, chip: p.kind }))}
      text={shown.text}
      selection={selection}
      rev={rev}
      onText={onText}
      onSelection={onSel}
      onKeyPress={onKeyPress}
      copyText={() => {
        const s = now.current.selection;
        return s.start === s.end ? null : copyOf(now.current.doc, s);
      }}
      onCut={() => {
        if (own.current.locked || own.current.readOnly) return;
        const { doc: d0, selection: s0 } = now.current;
        const t = layout(d0).text, lo = Math.min(s0.start, s0.end), hi = Math.max(s0.start, s0.end);
        onText(t.slice(0, lo) + t.slice(hi));
      }}
      placeholder={placeholder}
      editable={!locked && !readOnly}
      readOnly={readOnly}
      plain={plain}
      testID={testID}
    />
  );
});
