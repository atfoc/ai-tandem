// PROTOTYPE ONLY (branch fork-chat-feature): the variants of chat forking being compared, which one
// is shown, and the floating switch between them. ⌃⌥V cycles; the page is not reloaded, so the
// chat, the scroll and the composer stay as they are. The switch also starts the demo over and
// makes new demo chats.
import React, { useEffect, useSyncExternalStore } from "react";
import { safeGet, safeSet } from "./store.ts";
import { newDemoChat, resetDemo } from "./forkDemo.ts";
import { select } from "./Sidebar.tsx";

export const VARIANTS = [
  { n: 1, name: "Tree navigator" },
] as const;

const KEY = "aiwb.proto.forkvariant";
const listeners = new Set<() => void>();
let current = Math.max(1, Math.min(VARIANTS.length, Number(safeGet(KEY)) || VARIANTS.length));

export function setVariant(n: number) {
  current = ((n - 1 + VARIANTS.length) % VARIANTS.length) + 1;
  safeSet(KEY, String(current));
  listeners.forEach((l) => l());
}

/** The variant shown now, by number. */
export const useVariant = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => current);

export function VariantSwitch() {
  const v = useVariant();
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.code === "KeyV") { e.preventDefault(); e.stopPropagation(); setVariant(v + (e.shiftKey ? -1 : 1)); }
    };
    window.addEventListener("keydown", k, true);
    return () => window.removeEventListener("keydown", k, true);
  }, [v]);
  const cur = VARIANTS[v - 1];
  return (
    <div className="proto-switch" title="Prototype: chat forking. ⌃⌥V next, ⌃⌥⇧V previous">
      <span className="proto-tag">Forking</span>
      <button onClick={() => setVariant(v - 1)} disabled={VARIANTS.length < 2}>‹</button>
      <span className="proto-cur"><b>{cur.n}</b> {cur.name}</span>
      <button onClick={() => setVariant(v + 1)} disabled={VARIANTS.length < 2}>›</button>
      <kbd>⌃⌥V</kbd>
      <span className="proto-sep" />
      <button className="proto-act" title="New demo chat" onClick={() => select({ board: null, chat: newDemoChat() })}>+</button>
      <button className="proto-act" title="Start the demo chats over" onClick={() => { resetDemo(); select({ board: null, chat: "demo-ratelimit" }); }}>↺</button>
    </div>
  );
}
