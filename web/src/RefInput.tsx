// The composer's text box: plain text with reference chips in it (⌘L, ⌘⇧L).
// A contenteditable div whose DOM is owned here, not by React: text nodes and
// line breaks for the text, a non-editable <span> per reference carrying its
// tag. Its value is the message text with the references as inline tags
// (logic/refs.ts), so it goes to the server as is.
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { parseRefs, serializeRef, parseRef, type Ref } from "./logic/refs.ts";

export type RefInputHandle = {
  /** Puts a reference chip at the caret (or where the caret last was, or at the end). */
  insertRef(ref: Ref): void;
  /** Replaces the `n` characters before the caret with `s` (the @ mention being typed). */
  replaceBeforeCaret(n: number, s: string): void;
  /** Replaces everything with `text` (tags become chips). */
  set(text: string): void;
  focus(): void;
};

type Props = {
  placeholder: string;
  /** The new value, and the text of the caret's line before the caret (for @ mentions). */
  onChange(value: string, beforeCaret: string): void;
  onKeyDown(e: React.KeyboardEvent<HTMLDivElement>): void;
};

/** A reference's chip, as a DOM node (the thread draws the same with React, see RefChip). */
function chipNode(ref: Ref): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `ref-chip ${ref.kind}`;
  s.contentEditable = "false";
  s.dataset.ref = serializeRef(ref);
  s.title = chipTitle(ref);
  s.textContent = ref.label;
  return s;
}

export const chipTitle = (ref: Ref) =>
  (ref.kind === "selection" ? `Selection: ${ref.ids.length} element${ref.ids.length === 1 ? "" : "s"}` : `Point ${ref.label}`) +
  (ref.detail ? "\n" + ref.detail.split("; ").join("\n") : "");

const isChip = (n: Node | null): n is HTMLElement => !!n && n.nodeType === Node.ELEMENT_NODE && !!(n as HTMLElement).dataset?.ref;

/** The value of the box: text, "\n" for line breaks and blocks, each chip's tag. */
function valueOf(root: Node): string {
  let out = "";
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? "").replace(/​/g, "");
    else if (isChip(n)) out += n.dataset.ref;
    else if (n.nodeName === "BR") out += "\n";
    else if (n.nodeName === "DIV" || n.nodeName === "P") { if (out && !out.endsWith("\n")) out += "\n"; out += valueOf(n); }
    else out += valueOf(n);
  });
  return out;
}

/** The text of the caret's node before the caret, when the caret is in text. */
function textBeforeCaret(root: HTMLElement): string {
  const sel = getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed) return "";
  const n = sel.anchorNode;
  if (!n || !root.contains(n) || n.nodeType !== Node.TEXT_NODE) return "";
  return (n.textContent ?? "").slice(0, sel.anchorOffset);
}

/** Scrolls the box so the caret is in view (the browser does it for typing, not for chips put in by hand). */
function showCaret(root: HTMLElement) {
  const sel = getSelection();
  if (!sel?.rangeCount || root.scrollHeight <= root.clientHeight) return;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.endContainer)) return;
  const end = r.cloneRange(); end.collapse(false);
  let rect = end.getBoundingClientRect();
  if (!rect.height) { const n = beside(end, true) ?? beside(end, false); if (n?.nodeType === Node.ELEMENT_NODE) rect = (n as Element).getBoundingClientRect(); }
  if (!rect.height) return;
  const box = root.getBoundingClientRect();
  if (rect.bottom > box.bottom) root.scrollTop += rect.bottom - box.bottom + 3;
  else if (rect.top < box.top) root.scrollTop -= box.top - rect.top + 3;
}

/** The node right before (or after) a collapsed caret, skipping empty text. */
function beside(range: Range, back: boolean): Node | null {
  let c = range.startContainer, o = range.startOffset;
  let n: Node | null;
  if (c.nodeType === Node.TEXT_NODE) {
    if (back ? o > 0 : o < (c.textContent ?? "").length) return null; // inside text: the browser handles it
    n = back ? c.previousSibling : c.nextSibling;
  } else n = back ? c.childNodes[o - 1] ?? null : c.childNodes[o] ?? null;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").length) n = back ? n.previousSibling : n.nextSibling;
  return n;
}

export const RefInput = forwardRef<RefInputHandle, Props>(function RefInput({ placeholder, onChange, onKeyDown }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<Range | null>(null); // the caret, kept while focus is on the canvas
  const empty = useRef(true);

  const changed = () => {
    const el = box.current;
    if (!el) return;
    keep();
    const v = valueOf(el);
    const isEmpty = !v.trim();
    if (isEmpty !== empty.current) { empty.current = isEmpty; el.classList.toggle("is-empty", isEmpty); }
    onChange(v, textBeforeCaret(el));
    showCaret(el);
  };

  const place = (r: Range) => {
    const sel = getSelection();
    sel?.removeAllRanges(); sel?.addRange(r);
    last.current = r.cloneRange();
  };

  /** Remembers the caret while it is in the box (selectionchange comes late and coalesced, so also on input and blur). */
  const keep = () => {
    const sel = getSelection(), el = box.current;
    if (el && sel?.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) last.current = sel.getRangeAt(0).cloneRange();
  };
  useEffect(() => {
    document.addEventListener("selectionchange", keep);
    return () => document.removeEventListener("selectionchange", keep);
  }, []);

  useImperativeHandle(ref, () => ({
    insertRef(r: Ref) {
      const el = box.current;
      if (!el) return;
      const sel = getSelection();
      const now = sel?.rangeCount && el.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).cloneRange() : null;
      el.focus();
      let range = now ?? (last.current && el.contains(last.current.startContainer) ? last.current.cloneRange() : null);
      if (!range) { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
      range.deleteContents();
      const before = document.createRange(); before.selectNodeContents(el); before.setEnd(range.startContainer, range.startOffset);
      const after = document.createRange(); after.selectNodeContents(el); after.setStart(range.startContainer, range.startOffset);
      const prev = before.toString(), next = after.toString();
      const frag = document.createDocumentFragment();
      if (prev && !/\s$/.test(prev)) frag.append(" ");
      const chip = chipNode(r);
      frag.append(chip);
      const tail = !next || !/^\s/.test(next) ? document.createTextNode(" ") : null;
      if (tail) frag.append(tail);
      range.insertNode(frag);
      const caret = document.createRange();
      if (tail) caret.setStart(tail, 1); else caret.setStartAfter(chip);
      caret.collapse(true);
      place(caret);
      changed();
    },
    replaceBeforeCaret(n: number, s: string) {
      const el = box.current, sel = getSelection();
      if (!el || !sel?.rangeCount) return;
      const node = sel.anchorNode, off = sel.anchorOffset;
      if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node) || off < n) return;
      const r = document.createRange(); r.setStart(node, off - n); r.setEnd(node, off);
      place(r);
      document.execCommand("insertText", false, s); // keeps the browser's undo
      changed();
    },
    set(text: string) {
      const el = box.current;
      if (!el) return;
      el.replaceChildren(...parseRefs(text).map((s) => (typeof s === "string" ? document.createTextNode(s) : chipNode(s))));
      last.current = null;
      changed();
    },
    focus() { box.current?.focus(); },
  }), [onChange]);

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Backspace / Delete next to a chip remove the whole chip.
    if ((e.key === "Backspace" || e.key === "Delete") && !e.metaKey && !e.altKey && !e.ctrlKey) {
      const sel = getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const n = beside(sel.getRangeAt(0), e.key === "Backspace");
        if (isChip(n)) {
          e.preventDefault();
          const parent = n.parentNode!, i = Array.prototype.indexOf.call(parent.childNodes, n);
          n.remove();
          const r = document.createRange();
          const prev = parent.childNodes[i - 1], next = parent.childNodes[i];
          if (prev?.nodeType === Node.TEXT_NODE) r.setStart(prev, (prev.textContent ?? "").length);
          else if (next?.nodeType === Node.TEXT_NODE) r.setStart(next, 0);
          else r.setStart(parent, i);
          r.collapse(true);
          place(r);
          changed();
          return;
        }
      }
    }
    onKeyDown(e);
  };

  return (
    <div
      ref={box}
      className="composer-input is-empty"
      contentEditable="plaintext-only"
      role="textbox"
      aria-multiline="true"
      data-placeholder={placeholder}
      spellCheck
      suppressContentEditableWarning
      onInput={changed}
      onKeyDown={onKey}
      onKeyUp={(e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") changed(); }}
      onMouseUp={changed}
      onBlur={keep}
      onCopy={(e) => copyValue(e)}
      onCut={(e) => { if (copyValue(e)) { document.execCommand("delete"); changed(); } }}
      onPaste={(e) => {
        const t = e.clipboardData.getData("text/plain");
        if (!t) return;
        e.preventDefault();
        pasteValue(t, box.current);
        changed();
      }}
    />
  );
});

/** Copying a part with chips keeps them: the clipboard gets the tags. */
function copyValue(e: React.ClipboardEvent): boolean {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return false;
  const holder = document.createElement("div");
  holder.append(sel.getRangeAt(0).cloneContents());
  if (!holder.querySelector("[data-ref]")) return false;
  e.preventDefault();
  e.clipboardData.setData("text/plain", valueOf(holder));
  return true;
}

/** Pasting text with tags in it gives chips again; plain text goes in as text. */
function pasteValue(t: string, el: HTMLDivElement | null) {
  const segs = parseRefs(t);
  if (!el || segs.every((s) => typeof s === "string")) { document.execCommand("insertText", false, t); return; }
  for (const s of segs) {
    if (typeof s === "string") { document.execCommand("insertText", false, s); continue; }
    const sel = getSelection();
    if (!sel?.rangeCount) continue;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const chip = chipNode(s);
    r.insertNode(chip);
    r.setStartAfter(chip); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }
}

/** A reference in a sent message: the same chip, drawn by React. */
export function RefChip({ tag, onClick }: { tag: string; onClick?: () => void }) {
  const r = parseRef(tag);
  if (!r) return <>{tag}</>;
  return <button type="button" className={`ref-chip ${r.kind}`} title={chipTitle(r)} onClick={onClick}>{r.label}</button>;
}
