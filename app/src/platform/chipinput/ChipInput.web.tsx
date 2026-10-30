// The chip input on web (AD-61): today's RefInput.tsx moved into a primitive. A contenteditable div whose DOM is owned
// here, not by React: text nodes (and "\n") for the text, and a non-editable <span> per reference carrying its tag.
// The value is the message text with the references as inline tags (core logic/refs.ts), so it goes to the server as is.
// ⌘P in the box opens the insert popup, which puts a text in at the caret (core logic/insert.ts). Image files pasted into a
// box that takes them are handed on, and are no part of its value. The contract is types.ts; what both platforms
// do the same is written there, and checked by web/dev/checks/L4-chips.mjs.
//
// What is new against RefInput: the props are the contract's (onKey takes the key as a KeyLike and answers whether it
// took it); the colours are the theme's tokens, set as CSS variables on the box; the box blocks the browser's own typing
// while it is locked or read-only; the caret is reported to onChange also when it only moves (a touch on the text, the
// selection handles of a phone), which is what keeps the @ list in step with the caret (C-RF-26).
//
// Given `editing`, Tab, Shift+Tab and Enter edit like a code editor (core logic/indent.ts): the edit is typed over its span with the
// browser's own commands, so ⌘Z undoes it as one step; a line break is a "\n" in the text, as the browser's Enter puts it (edits.ts).
// Esc, then Tab or Shift+Tab, is the way out of such a box by the keyboard: that Tab is the browser's, and moves the focus.
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import { pastedImages, pastedName } from "@aiwb/core/logic/chatimage.ts";
import { applyEdit, indentUnit, newlineEdit, outdentEdit, tabEdit, type Edit } from "@aiwb/core/logic/indent.ts";
import { insertText, isInsertKey, lines, openInsertPopup, sameBox } from "@aiwb/core/logic/insert.ts";
import { serializeRef, type Ref } from "@aiwb/core/logic/refs.ts";
import { TYPE } from "../../ui/metrics.ts";
import { BASE_SIZE } from "../../ui/Text.tsx";
import { SANS } from "../../ui/fonts.ts";
import { useTokens } from "../../ui/theme.tsx";
import { chipSpacing, chipTitle, piecesOf } from "./chipvalue.ts";
import { boxText, boxValue, hunksOf } from "./edits.ts";
import type { ChipInputHandle, ChipInputProps } from "./types.ts";

export type { ChipInputHandle, ChipInputProps } from "./types.ts";

const CLASS = "aiwb-chipinput", CHIP = "aiwb-chip";

/** The rules the box needs that a style prop cannot say (pseudo-elements, the placeholder). Added to the page once. */
const STYLES = `
.${CLASS} { position: relative; flex: 1 1 auto; min-width: 0; box-sizing: border-box; outline: 0; padding: 3px 0; min-height: var(--cin-min, calc(3 * 1.45em + 6px)); max-height: var(--cin-max, max(calc(6 * 1.45em), 40vh)); overflow-y: auto; overscroll-behavior: contain; white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; color: var(--cin-text); font-family: var(--cin-font); font-size: var(--cin-size); line-height: 1.45; }
.${CLASS}.is-empty::before { content: attr(data-placeholder); position: absolute; left: 0; top: 3px; color: var(--cin-faint); pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.${CLASS}[aria-readonly="true"] { color: var(--cin-muted); cursor: default; caret-color: transparent; }
.${CHIP} { display: inline-flex; align-items: center; gap: 4px; vertical-align: baseline; max-width: 100%; box-sizing: border-box; margin: 0 1px; padding: 0 6px 0 5px; border: 1px solid color-mix(in srgb, var(--cin-accent) 30%, transparent); border-radius: 5px; background: var(--cin-bg); color: var(--cin-accent); font-weight: 600; font-size: 12px; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: default; }
.${CHIP}::before { content: ""; flex: none; width: 8px; height: 8px; box-sizing: border-box; }
.${CHIP}[data-kind="selection"]::before { border: 1.5px dashed currentColor; border-radius: 2px; }
.${CHIP}[data-kind="point"]::before { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px color-mix(in srgb, var(--cin-accent) 25%, transparent); }
`;
function ensureStyles() {
  if (document.querySelector("style[data-aiwb-chipinput]")) return;
  const s = document.createElement("style");
  s.dataset.aiwbChipinput = "";
  s.textContent = STYLES;
  document.head.append(s);
}

/** A reference's chip, as a DOM node. */
function chipNode(ref: Ref): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = CHIP;
  s.contentEditable = "false";
  s.dataset.testid = "ref-chip";
  s.dataset.kind = ref.kind;
  s.dataset.ref = serializeRef(ref);
  s.title = chipTitle(ref);
  s.textContent = ref.label;
  return s;
}

const isChip = (n: Node | null): n is HTMLElement => !!n && n.nodeType === Node.ELEMENT_NODE && !!(n as HTMLElement).dataset?.ref;

/** What nodes read as: text, "\n" for line breaks and blocks, each chip's tag. For a part of the box (a caret's offset, a copy). */
function textOf(root: Node): string {
  let out = "";
  root.childNodes.forEach((n) => {
    if (n.nodeType === Node.TEXT_NODE) out += (n.textContent ?? "").replace(/​/g, "");
    else if (isChip(n)) out += n.dataset.ref;
    else if (n.nodeName === "BR") out += "\n";
    else if (n.nodeName === "DIV" || n.nodeName === "P") { if (out && !out.endsWith("\n")) out += "\n"; out += textOf(n); }
    else out += textOf(n);
  });
  return out;
}

/** The value of the box: what it reads as, less the break the browser adds to draw an empty last line (edits.ts). */
const valueOf = (root: Node): string => boxValue(textOf(root));

/** What a box is made of for `text`: text nodes, and a chip for each tag (and the break that draws an empty last line). */
const nodesOf = (text: string) => piecesOf(boxText(text)).map((p) => ("tag" in p ? chipNode(p.ref) : document.createTextNode(p.text)));

/** How much of the box's value is before a point in it. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(root); r.setEnd(node, offset);
  const holder = document.createElement("div");
  holder.append(r.cloneContents());
  return textOf(holder).length;
}

/** The end of the box's value, as a caret: before the break that only draws an empty last line (edits.ts), not after it, where a
 *  chip or a text put in would leave that break in the value. */
const endOf = (root: HTMLElement): Range => caretAt(root, valueOf(root).length);

/** The point `offset` into the value of a box made of nodesOf, as a caret (past its value: the end of what it holds). */
function caretAt(root: HTMLElement, offset: number): Range {
  const r = document.createRange();
  r.selectNodeContents(root); r.collapse(false);
  let left = offset;
  for (const n of root.childNodes) {
    if (isChip(n)) { if (left === 0) { r.setStartBefore(n); break; } left -= (n.dataset.ref ?? "").length; if (left <= 0) { r.setStartAfter(n); break; } }
    else if (n.nodeName === "BR") { if (left === 0) { r.setStartBefore(n); break; } left -= 1; }
    else if (left <= (n.textContent ?? "").length) { r.setStart(n, left); break; }
    else left -= (n.textContent ?? "").length;
  }
  r.collapse(true);
  return r;
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

/** The chip a node is in or is, if any. */
function chipOf(root: HTMLElement, n: Node | null): HTMLElement | null {
  for (let e = n; e && e !== root; e = e.parentNode) if (isChip(e)) return e;
  return null;
}

/** The node right before (or after) a collapsed caret, skipping empty text. */
function beside(range: Range, back: boolean): Node | null {
  const c = range.startContainer, o = range.startOffset;
  let n: Node | null;
  if (c.nodeType === Node.TEXT_NODE) {
    if (back ? o > 0 : o < (c.textContent ?? "").length) return null; // inside text: the browser handles it
    n = back ? c.previousSibling : c.nextSibling;
  } else n = back ? c.childNodes[o - 1] ?? null : c.childNodes[o] ?? null;
  while (n && n.nodeType === Node.TEXT_NODE && !(n.textContent ?? "").length) n = back ? n.previousSibling : n.nextSibling;
  return n;
}

/** Copying a part with chips keeps them: the clipboard gets the tags. */
function copyValue(e: React.ClipboardEvent): boolean {
  const sel = getSelection();
  if (!sel?.rangeCount || sel.isCollapsed) return false;
  const holder = document.createElement("div");
  holder.append(sel.getRangeAt(0).cloneContents());
  if (!holder.querySelector("[data-ref]")) return false;
  e.preventDefault();
  e.clipboardData.setData("text/plain", textOf(holder));
  return true;
}

/** Types `text` over the selection as the browser's own keys would, so its undo keeps it: the text with insertText, each line break
 *  with insertLineBreak (a "\n" in the text node, what Enter and Shift+Enter put in; insertText would split the line into <div>s). The
 *  browser takes the commands typed one after the other as one step of its undo. */
function typeText(text: string) {
  if (!text) { document.execCommand("delete"); return; }
  text.split("\n").forEach((s, i) => {
    if (i) document.execCommand("insertLineBreak");
    if (s) document.execCommand("insertText", false, s);
  });
}

/** Pasting text with tags in it gives chips again; plain text goes in as text. */
function pasteValue(t: string, el: HTMLDivElement | null) {
  const pieces = piecesOf(t);
  if (!el || pieces.every((p) => !("tag" in p))) { document.execCommand("insertText", false, t); return; }
  for (const p of pieces) {
    if (!("tag" in p)) { document.execCommand("insertText", false, p.text); continue; }
    const sel = getSelection();
    if (!sel?.rangeCount) continue;
    const r = sel.getRangeAt(0);
    r.deleteContents();
    const chip = chipNode(p.ref);
    r.insertNode(chip);
    r.setStartAfter(chip); r.collapse(true);
    sel.removeAllRanges(); sel.addRange(r);
  }
}

export const ChipInput = forwardRef<ChipInputHandle, ChipInputProps>(function ChipInput(props, ref) {
  const { placeholder, locked = false, readOnly = false, testID = "composer-input", size } = props;
  const t = useTokens();
  const box = useRef<HTMLDivElement>(null);
  const last = useRef<Range | null>(null); // the caret, kept while focus is elsewhere
  const mark = useRef<Range | null>(null); // the caret or the selection the open insert popup was opened at
  const empty = useRef(true);
  const reported = useRef<[string, string] | null>(null); // what onChange was last given
  const moved = useRef<() => void>(() => {}); // what is done when the caret or the selection moved
  const escaped = useRef(false); // Esc was the last key: the next Tab or Shift+Tab is the browser's (the focus leaves the box)
  const now = useRef(props); // the latest props, for the handlers that live longer than a render
  now.current = props;

  useEffect(ensureStyles, []);

  const report = (el: HTMLElement) => {
    const v = valueOf(el), before = textBeforeCaret(el);
    reported.current = [v, before];
    now.current.onChange(v, before);
  };

  const changed = () => {
    const el = box.current;
    if (!el) return;
    keep();
    const isEmpty = !valueOf(el).trim();
    if (isEmpty !== empty.current) { empty.current = isEmpty; el.classList.toggle("is-empty", isEmpty); }
    report(el);
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

  // A caret that only moved (an arrow key, Home, End, a press, the selection handles of a phone) is reported when what
  // onChange would say is not what it said: the @ list follows the caret, and a caret right after a chip is not in text.
  useEffect(() => {
    const onMoved = () => {
      const el = box.current, sel = getSelection();
      if (!el || !sel?.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) { keep(); return; }
      // A chip is one unit: a caret is never inside it, and a selection that reaches into a chip takes it whole.
      const r = sel.getRangeAt(0), from = chipOf(el, r.startContainer), to = chipOf(el, r.endContainer);
      if (from || to) {
        const fixed = r.cloneRange();
        if (r.collapsed) {
          // (the browser puts a caret that is pressed into a chip, or that a key took there, at the chip's text: on which side is by its offset)
          const len = (from!.textContent ?? "").length, near = r.startContainer === from ? r.startOffset === 0 : r.startOffset * 2 < len;
          if (near) fixed.setStartBefore(from!); else fixed.setStartAfter(from!);
          fixed.collapse(true);
        } else {
          if (from) fixed.setStartBefore(from);
          if (to) fixed.setEndAfter(to);
        }
        place(fixed);
        return;
      }
      keep();
      const was = reported.current;
      if (was && was[0] === valueOf(el) && was[1] === textBeforeCaret(el)) return;
      report(el);
    };
    moved.current = onMoved;
    document.addEventListener("selectionchange", onMoved);
    return () => document.removeEventListener("selectionchange", onMoved);
  }, []);

  // While the box is locked or read-only nothing is typed, pasted or dropped into it, and nothing is deleted from it.
  useEffect(() => {
    const el = box.current;
    if (!(locked || readOnly) || !el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("beforeinput", stop, true);
    return () => el.removeEventListener("beforeinput", stop, true);
  }, [locked, readOnly]);

  /** The caret or the selection in the box now, else where the caret last was, else the end of what the box holds. */
  const where = (el: HTMLElement): Range => {
    const sel = getSelection();
    if (sel?.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) return sel.getRangeAt(0).cloneRange();
    if (last.current && el.contains(last.current.startContainer)) return last.current.cloneRange();
    return endOf(el);
  };

  /** A span of the value (the box may hold less than it did) as a range of the box. */
  const spanOf = (el: HTMLElement, at: { start: number; end: number }): Range => {
    const to = caretAt(el, Math.max(at.start, at.end)), range = caretAt(el, Math.min(at.start, at.end));
    range.setEnd(to.startContainer, to.startOffset);
    return range;
  };

  /** The insert popup (core logic/insert.ts) is opened with what puts a text into the box, or leaves the box as it is. It
   *  takes the focus, and the box's selection goes with the focus: where the caret or the selection is, is kept
   *  here. A box filled anew meanwhile (set) has no such place left: the text then goes to its end. */
  const openInsert = (at?: { start: number; end: number } | null) => {
    const el = box.current;
    if (!el || now.current.locked || now.current.readOnly) return;
    mark.current = at ? spanOf(el, at) : where(el);
    const back = (): { el: HTMLDivElement; at: Range } | null => {
      const el = box.current, at = mark.current;
      mark.current = null;
      if (!el) return null;
      el.focus(); // (alone, it puts the caret at the start of the box)
      return { el, at: at && el.contains(at.startContainer) ? at : endOf(el) };
    };
    openInsertPopup({
      insert(text: string) {
        const b = back();
        if (!b) return;
        const want = insertText(valueOf(b.el), { start: offsetOf(b.el, b.at.startContainer, b.at.startOffset), end: offsetOf(b.el, b.at.endContainer, b.at.endOffset) }, text);
        place(b.at);
        document.execCommand("insertText", false, lines(text)); // keeps the browser's undo
        // What the browser did not do as told (a selection that ends inside a chip) is done here: the box is made anew.
        if (!sameBox(valueOf(b.el), want.value)) { b.el.replaceChildren(...nodesOf(want.value)); place(caretAt(b.el, want.caret)); }
        changed();
      },
      cancel() {
        const b = back();
        if (b) place(b.at);
      },
    });
  };

  /** Makes a code-editor edit (core logic/indent.ts) in the box: each of its replaces (edits.ts hunksOf: none touches a chip it keeps)
   *  typed over its span, the selection put where the edit says, the change reported. One step of the browser's undo, but for an
   *  indent of several lines with chips in them (a step per line there). What the browser did not do as told (a box with blocks in
   *  it, from a paste of lines) is done here: the box is made anew. */
  const applyBoxEdit = (el: HTMLDivElement, edit: Edit) => {
    const value = valueOf(el), want = applyEdit(value, edit);
    if (!el.querySelector("div, p")) for (const h of hunksOf(value, edit)) { place(spanOf(el, h)); typeText(h.text); }
    if (valueOf(el) !== want.value) el.replaceChildren(...nodesOf(want.value));
    place(spanOf(el, want.selection));
    changed();
  };

  /** Tab, Shift+Tab, Enter and Shift+Enter as a code editor has them, when the box is given `editing` (types.ts). True: the key was
   *  taken (Shift+Tab with nothing to outdent too, so the focus stays in the box). */
  const editKey = (key: KeyboardEvent): boolean => {
    const ed = now.current.editing, el = box.current, sel = getSelection();
    if (!ed || !el || now.current.locked || now.current.readOnly || key.ctrlKey || key.metaKey || key.altKey) return false;
    if (key.key !== "Tab" && key.key !== "Enter") return false;
    if (!sel?.rangeCount || !el.contains(sel.getRangeAt(0).startContainer)) return false;
    const r = sel.getRangeAt(0), value = valueOf(el);
    const at = { start: offsetOf(el, r.startContainer, r.startOffset), end: offsetOf(el, r.endContainer, r.endOffset) };
    const edit = key.key === "Enter" ? newlineEdit(value, at) : key.shiftKey ? outdentEdit(value, at, ed.tabWidth) : tabEdit(value, at, indentUnit(ed));
    if (edit) applyBoxEdit(el, edit);
    return true;
  };

  useImperativeHandle(ref, () => ({
    caret() {
      const el = box.current;
      if (!el) return null;
      const sel = getSelection();
      const r = sel?.rangeCount && el.contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0) : last.current && el.contains(last.current.startContainer) ? last.current : null;
      if (!r) return null;
      // (a caret after the break that draws an empty last line is at the value's end)
      const n = valueOf(el).length;
      return { start: Math.min(n, offsetOf(el, r.startContainer, r.startOffset)), end: Math.min(n, offsetOf(el, r.endContainer, r.endOffset)) };
    },
    insertRef(r: Ref, at?: { start: number; end: number } | null) {
      const el = box.current;
      if (!el || now.current.locked || now.current.readOnly) return;
      const range = at ? spanOf(el, at) : where(el);
      el.focus();
      range.deleteContents();
      // (what is before and after it in the value: the break that only draws an empty last line is not "after")
      const value = valueOf(el), cut = Math.min(value.length, offsetOf(el, range.startContainer, range.startOffset));
      const gap = chipSpacing(value.slice(0, cut), value.slice(cut));
      const frag = document.createDocumentFragment();
      if (gap.before) frag.append(" ");
      const chip = chipNode(r);
      frag.append(chip);
      const tail = gap.after ? document.createTextNode(" ") : null;
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
      if (!el || now.current.locked || now.current.readOnly || !sel?.rangeCount) return;
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
      el.replaceChildren(...nodesOf(text));
      last.current = mark.current = null;
      // (a selection left in the box while the focus is elsewhere is now at its start, where nobody put it: the box has no place then, so
      // what goes in without a place goes to the value's end, `where`)
      const sel = getSelection();
      if (document.activeElement !== el && sel?.rangeCount && el.contains(sel.getRangeAt(0).startContainer)) sel.removeAllRanges();
      changed();
    },
    openInsert,
    select(at: { start: number; end: number }) {
      const el = box.current;
      if (el) place(spanOf(el, at));
    },
    focus(atEnd?: boolean) {
      const el = box.current;
      if (!el) return;
      el.focus();
      if (atEnd) place(endOf(el));
    },
  }), []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const key = e.nativeEvent;
    e.stopPropagation(); // the page's own shortcuts (and Excalidraw's) are not the box's
    moved.current(); // (a caret a key or a press took into a chip is put beside it before this key acts on it)
    if (key.isComposing || key.keyCode === 229) return; // an input method is composing: Enter, Esc and the arrows are its
    // The way out by the keyboard of a box that takes Tab: after Esc, the next Tab or Shift+Tab moves the focus as the browser does. Any
    // other key (a modifier alone is none: Shift is pressed before its Tab), a press in the box or the focus leaving it ends that.
    const out = escaped.current;
    if (!["Shift", "Control", "Alt", "Meta"].includes(key.key)) escaped.current = key.key === "Escape";
    if (out && key.key === "Tab") return;
    // ⌘P opens the insert popup, and the page is not printed.
    if (isInsertKey(key, navigator.platform)) {
      e.preventDefault();
      openInsert();
      return;
    }
    // Backspace / Delete next to a chip remove the whole chip.
    if (!locked && !readOnly && (key.key === "Backspace" || key.key === "Delete") && !key.metaKey && !key.altKey && !key.ctrlKey) {
      const sel = getSelection();
      if (sel?.rangeCount && sel.isCollapsed) {
        const n = beside(sel.getRangeAt(0), key.key === "Backspace");
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
    if (now.current.onKey(key)) { key.preventDefault(); return; }
    if (editKey(key)) key.preventDefault();
  };

  const style = {
    "--cin-text": t.text, "--cin-muted": t.muted, "--cin-faint": t.faint, "--cin-accent": t.accent, "--cin-bg": t.bg,
    "--cin-font": SANS, "--cin-size": `${size === "phone" ? TYPE.control : BASE_SIZE}px`,
    // (the phone's box: one line high when empty, six at most, then it scrolls; the lines and the 3 px above and below as in the default box)
    // (a tab character is as wide as the editing settings say; the box is white-space: pre-wrap, so tabs and indents show)
    ...(props.editing ? { tabSize: props.editing.tabWidth, MozTabSize: props.editing.tabWidth } : null),
    ...(size === "phone" ? { "--cin-min": "calc(1.45em + 6px)", "--cin-max": "calc(6 * 1.45em + 6px)" } : null),
  } as React.CSSProperties;

  return (
    <div
      ref={box}
      className={`${CLASS} is-empty`}
      style={style}
      data-testid={testID}
      contentEditable={readOnly ? "false" : "plaintext-only"}
      role="textbox"
      aria-multiline="true"
      aria-readonly={readOnly || undefined}
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      spellCheck
      suppressContentEditableWarning
      onPointerDown={() => { escaped.current = false; }}
      onPointerUp={() => moved.current()}
      onInput={changed}
      onKeyDown={onKeyDown}
      onBlur={() => { escaped.current = false; keep(); }}
      onCopy={(e) => { copyValue(e); }}
      onCut={(e) => { if (copyValue(e) && !locked && !readOnly) { document.execCommand("delete"); changed(); } }}
      onPaste={(e) => {
        const text = e.clipboardData.getData("text/plain");
        // (images are the composer's even while the box is read-only: it refuses them with the reason, C-IM-23; a text is no one's then)
        if (props.onImages) {
          const types = [...e.clipboardData.types];
          const images = pastedImages({ plain: !!text, rich: types.includes("text/html") || types.includes("text/rtf"), files: [...e.clipboardData.files] });
          if (images.length) { e.preventDefault(); props.onImages(images.map((f) => ({ file: f, name: pastedName(f.name) }))); return; }
        }
        if (locked || readOnly) { e.preventDefault(); return; }
        if (!text) return;
        e.preventDefault();
        pasteValue(text, box.current);
        changed();
      }}
    />
  );
});
