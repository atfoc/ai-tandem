// The view's connection line (goal 6.6): "Connecting…" before the first load, "Reconnecting…" while the link is not online, and
// a red line when the room rejected the window (tldraw's reason; "…, trying again" until it gives up). Top centre, so it never
// covers tldraw's watermark (bottom right) or our toolbars (bottom).
// (Its CSS is sync.css, imported by the entry, as board.css is.)
import { useSyncExternalStore } from "react";
import type { SyncState } from "./sync.ts";

export type StatusSource = { subscribe(cb: () => void): () => void; getSnapshot(): SyncState };

/** What the line says for a state (null: nothing shown). */
export function statusText(s: SyncState): { text: string; error: boolean } | null {
  if (s.fatal) return { text: `This board refused the window (${s.error ?? "error"}).`, error: true };
  if (s.error) return { text: `The board refused the window (${s.error}); trying again…`, error: true };
  if (!s.loaded) return { text: "Connecting…", error: false };
  if (s.link !== "online") return { text: "Reconnecting…", error: false };
  return null;
}

export function Status({ sync }: { sync: StatusSource }) {
  const s = useSyncExternalStore(sync.subscribe, sync.getSnapshot);
  const t = statusText(s);
  if (!t) return null;
  return (
    <div className={t.error ? "aiwb-status error" : "aiwb-status"} role="status" data-testid="tl-status">
      {t.text}
    </div>
  );
}
