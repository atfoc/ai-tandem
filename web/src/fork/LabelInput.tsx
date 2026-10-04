// The input a message's label is typed into, in the thread and in the tree popup.
import { useRef, useState } from "react";
import "./fork.css";

/** Enter and blur give the value, Esc gives null. */
export function LabelInput({ initial, onDone }: { initial: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const finish = (x: string | null) => { if (!done.current) { done.current = true; onDone(x); } };
  return (
    <input className="fk-label-input" autoFocus value={v} placeholder="Label (empty removes it)" onChange={(e) => setV(e.target.value)}
      onBlur={() => finish(v)} onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") finish(v); if (e.key === "Escape") finish(null); }} />
  );
}
