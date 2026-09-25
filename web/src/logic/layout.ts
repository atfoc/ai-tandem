// Widths of the resizable panes: the sidebar, and a board's chat panel. DOM-free.

export type Pane = "side" | "panel";
export type Widths = Record<Pane, number>;

export const PANES: Record<Pane, { def: number; min: number; max: number }> = {
  side: { def: 264, min: 200, max: 480 },
  panel: { def: 400, min: 300, max: 760 },
};

/** What is always left for the canvas or the chat page right of the panes. */
export const MIN_STAGE = 320;

export const DEFAULT_WIDTHS: Widths = { side: PANES.side.def, panel: PANES.panel.def };

/**
 * Clamps a pane's width to its min and max, and to `room` (the space the window leaves it,
 * when known). The pane's min wins over a room too small for it.
 */
export function clampWidth(pane: Pane, w: number, room = Infinity): number {
  const { def, min, max } = PANES[pane];
  if (!Number.isFinite(w)) return def;
  return Math.round(Math.max(min, Math.min(max, room, w)));
}

/** Widths saved as JSON; anything missing or unreadable falls back to the default. */
export function parseWidths(saved: string | null): Widths {
  let v: any = null;
  try { v = JSON.parse(saved ?? ""); } catch {}
  const one = (p: Pane) => (typeof v?.[p] === "number" ? clampWidth(p, v[p]) : PANES[p].def);
  return { side: one("side"), panel: one("panel") };
}
