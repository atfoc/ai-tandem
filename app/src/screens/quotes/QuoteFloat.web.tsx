// The comment field at a quoted passage (the old page's Quotes.tsx QuoteFloat; C-QT-05 to C-QT-09), on the wide layouts of the web build: as wide as the
// composer's box and lined up with it, below the passage or above it when there is no room below, never over the composer, following the passage as
// the thread scrolls or the window is resized. Enter keeps it; Esc (an overlay's place on the stack, ui/useEscLayer) drops what was typed; a press elsewhere keeps a typed comment.
// The passage is the DOM range the quote port finds again each time (the list is virtual: the message may come into the page after the float).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { View } from "react-native";

import { preview } from "@aiwb/core/logic/quotes.ts";
import type { Reference } from "@aiwb/core/types.ts";

import { quotePort } from "../../platform/quote";
import { Button } from "../../ui/Button.tsx";
import { Text } from "../../ui/Text.tsx";
import { useTokens } from "../../ui/theme.tsx";
import { useEscLayer } from "../../ui/useEscLayer";
import { quoteKey } from "@aiwb/core/logic/quotes.ts";
import type { Editing } from "./model.ts";

type Props = {
  chat: string;
  f: Editing;
  onText(t: string): void;
  onKeep(enter: boolean): void;
  onCancel(): void;
  onRemove?: () => void;
};

/** The composer's box of the chat, whose width and place the float takes. */
const boxOf = (chat: string) => document.querySelector<HTMLElement>(`[data-testid="composer"][data-chat="${CSS.escape(chat)}"] [data-testid="composer-box"]`);

export function QuoteFloat({ chat, f, onText, onKeep, onCancel, onRemove }: Props) {
  const t = useTokens();
  const el = useRef<HTMLDivElement>(null);
  const [, redraw] = useState(0);
  const [h, setH] = useState(120);
  const keepNow = useRef(onKeep);
  keepNow.current = onKeep;
  // Esc wherever the focus is, in the order of the overlays: a list or a menu opened over the float is above it and closes first, and so does
  // anything that opened later; what is under the float (the subagent drawer) waits for the next Esc.
  useEscLayer(true, onCancel);
  useEffect(() => {
    const move = () => redraw((x) => x + 1);
    const down = (e: MouseEvent) => { if (!el.current?.contains(e.target as Node)) keepNow.current(false); };
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    document.addEventListener("mousedown", down, true);
    const ro = new ResizeObserver(move); // the panel is resized, the composer grows
    const box = boxOf(chat);
    if (box) ro.observe(box);
    // the passage's message comes into the page (the list scrolls to it): the float goes to it
    const mo = new MutationObserver(move);
    const thread = document.querySelector(`[data-testid="thread"][data-chat="${CSS.escape(chat)}"]`);
    if (thread) mo.observe(thread, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
      document.removeEventListener("mousedown", down, true);
    };
  }, [chat]);
  useLayoutEffect(() => { if (el.current && el.current.offsetHeight !== h) setH(el.current.offsetHeight); });

  const range = quotePort.anchor(chat, f.r) as Range | null;
  const rects = range?.getClientRects();
  const first = rects?.[0] ?? range?.getBoundingClientRect(), last = rects?.[rects.length - 1] ?? first;
  const to = boxOf(chat)?.getBoundingClientRect();
  const floor = (to ? to.top : window.innerHeight) - 8;
  let top = last ? last.bottom + 8 : floor - h;
  if (first && top + h > floor) top = first.top - h - 8;
  top = Math.max(8, Math.min(top, floor - h));

  return createPortal(
    <div ref={el} data-testid="qfloat" data-edit={f.edit} style={{
      position: "fixed", zIndex: 900, boxSizing: "border-box", top, left: to?.left ?? 8, width: to?.width ?? 360,
      background: t.bg, border: `1px solid ${t.line2}`, borderRadius: 10, padding: "8px 8px 6px 10px", boxShadow: t.shadowLg,
    }}>
      <div data-testid="qfloat-quote" title={f.r.quote} style={{ fontSize: 12, color: t.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginBottom: 6 }}>
        <span style={{ fontFamily: "Georgia, serif", fontSize: 14, lineHeight: 1, color: t.accent }}>❝</span> {preview(f.r.quote, 200)}
      </div>
      <Comment value={f.text} focus={quoteKey(f.r)} placeholder={f.edit ? "Comment" : "Comment on this…"} onChange={onText} onEnter={() => onKeep(true)} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 7 }}>
        {onRemove ? <Button testID="qfloat-remove" tone="ghost" size="sm" label="Remove" onPress={onRemove} /> : null}
        <View style={{ flex: 1, alignItems: "flex-end" }}>
          <Text testID="qfloat-hint" size={11} tone="faint"><Kbd>↵</Kbd> {f.edit ? "save" : "add"} · <Kbd>esc</Kbd> cancel</Text>
        </View>
        <Button testID="qfloat-save" tone="primary" size="sm" label={f.edit ? "Save" : "Add"} onPress={() => onKeep(true)} />
      </View>
    </div>,
    document.body,
  );
}

const Kbd = ({ children }: { children: string }) => (
  <Text size={10} tone="muted" style={{ paddingHorizontal: 3, borderWidth: 1, borderRadius: 3, borderColor: "transparent" }} mono>{children}</Text>
);

/** The float's comment field: grows with its text; Enter is onEnter, Shift+Enter a new line. It takes the focus whenever the quote changes. */
function Comment({ value, focus, placeholder, onChange, onEnter }: {
  value: string; focus: string; placeholder: string; onChange(v: string): void; onEnter(): void;
}) {
  const t = useTokens();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = el.scrollHeight + "px";
  }, [value]);
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focus]);
  return (
    <textarea ref={ref} data-testid="qfloat-comment" rows={1} value={value} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      style={{
        display: "block", width: "100%", boxSizing: "border-box", resize: "none", border: 0, outline: 0, background: "transparent", color: t.text,
        font: "inherit", fontSize: 13, lineHeight: 1.45, padding: "3px 0", minHeight: "calc(3 * 1.45em + 6px)", maxHeight: "max(calc(6 * 1.45em), 30vh)", overflowY: "auto",
      }}
      onKeyDown={(e) => {
        e.stopPropagation(); // keep Excalidraw's shortcuts out
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter(); }
      }} />
  );
}
