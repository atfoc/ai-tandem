// The phone's composer box with its references taken out of the text (B2, b2-design §2): the ordinary ChipInput holds the plain text, and
// the references stand beside it as chips in the context row (RefChips). The composer sees the value it always saw: the text with each
// reference as its inline tag (core logic/refs.ts), put back together by refbox.ts at the offsets kept here; the handle is ChipInput's,
// and every offset it gives or takes is an offset in the plain text, so callers that get one from this same handle agree.
import React, { forwardRef, useImperativeHandle, useRef } from "react";

import type { Ref } from "@aiwb/core/logic/refs.ts";

import { ChipInput } from "../../platform/chipinput/ChipInput";
import type { ChipInputHandle, ChipInputProps } from "../../platform/chipinput/types.ts";
import { joinRefs, shiftRefs, splitRefs, type Placed } from "./refbox.ts";

export type RefBoxHandle = ChipInputHandle & {
  /** Takes the `i`-th reference (in the order of `onRefs`) out of the message. */
  removeRef(i: number): void;
};

export type RefBoxProps = ChipInputProps & {
  /** The references now, in the order of the value; called when the list changes. */
  onRefs(refs: Ref[]): void;
};

export const RefBox = forwardRef<RefBoxHandle, RefBoxProps>(function RefBox(props, ref) {
  const inner = useRef<ChipInputHandle>(null);
  const plain = useRef(""); // the plain text the inner box last reported (or was given)
  const refs = useRef<Placed[]>([]);
  const now = useRef(props);
  now.current = props;

  const report = (before: string) => now.current.onChange(joinRefs(plain.current, refs.current), before);
  const setRefs = (next: Placed[]) => {
    refs.current = next;
    now.current.onRefs(next.map((p) => p.ref));
  };

  useImperativeHandle(ref, () => ({
    caret: () => inner.current?.caret() ?? null,
    select: (at) => inner.current?.select(at),
    openInsert: (at) => inner.current?.openInsert(at),
    replaceBeforeCaret: (n, s) => inner.current?.replaceBeforeCaret(n, s),
    focus: (atEnd) => inner.current?.focus(atEnd),
    set(value: string) {
      const split = splitRefs(value);
      plain.current = split.text;
      setRefs(split.refs);
      inner.current?.set(split.text); // (reports through onInner: no shift, the value joined back)
      report(""); // (and once more here: a box given the plain text it already holds may report nothing, while the references changed)
    },
    insertRef(r: Ref, at?: { start: number; end: number } | null) {
      const p = now.current;
      if (p.locked || p.readOnly || !inner.current) return;
      const text = plain.current;
      const where = Math.min(Math.max(at ? at.start : inner.current.caret()?.start ?? text.length, 0), text.length);
      const list = refs.current.slice();
      let i = list.length;
      while (i > 0 && list[i - 1].at > where) i--;
      list.splice(i, 0, { ref: r, at: where });
      setRefs(list);
      inner.current.select({ start: where, end: where });
      inner.current.focus();
      report("");
    },
    removeRef(i: number) {
      const p = now.current;
      if (p.locked || p.readOnly || i < 0 || i >= refs.current.length) return;
      setRefs(refs.current.filter((_, k) => k !== i));
      report("");
    },
  }), []);

  const onInner = (value: string, before: string) => {
    if (value !== plain.current) {
      refs.current = shiftRefs(refs.current, plain.current, value, inner.current?.caret()?.end);
      plain.current = value;
    }
    report(before);
  };

  return <ChipInput {...props} ref={inner} onChange={onInner} />;
});
