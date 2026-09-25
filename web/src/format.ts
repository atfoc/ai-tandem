// The one scene formatter. The agent-side library imports it directly and the
// browser page gets it through the esbuild bundle, so a scene reads the same
// whoever printed it. No imports, no DOM, and erasable TypeScript only — types
// and nothing else, so that session scripts run with plain `node script.ts`.

export type FmtElement = {
  id: string; type: string; x: number; y: number; width: number; height: number;
  key?: string; label?: string; isDeleted?: boolean;
  containerId?: string | null; frameId?: string | null; groupIds?: string[];
  startRef?: string; endRef?: string;        // already-resolved display names for arrows
};

export type FmtViewport = { x: number; y: number; width: number; height: number; zoom: number };

const round = (n: number) => Math.round(n);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Six columns at fixed widths, joined with two spaces. Every column is always
 * emitted — an empty one is emitted as padding — so ids and labels line up down
 * the whole scene instead of sliding left whenever a column happens to be empty.
 */
export function formatElement(e: FmtElement, indent = 0): string {
  const key = e.key ? `key=${e.key}` : "";
  const label = e.label ? JSON.stringify(e.label) : "";
  const geo = `(${round(e.x)},${round(e.y)} ${round(e.width)}×${round(e.height)})`;
  const link = e.type === "arrow" ? `${e.startRef ?? "·"} → ${e.endRef ?? "·"}` : "";
  const line = [
    e.type.padEnd(9),
    key.padEnd(14),
    `id=${e.id}`.padEnd(25),
    label.padEnd(16),
    geo,
    link,
  ].join("  ");
  return ("  ".repeat(indent) + line).trimEnd();
}

/**
 * Deterministic order: frames with their children indented under them, then
 * groups, then everything loose. An element that is both in a frame and in a
 * group belongs to the frame and is printed there, once.
 */
export function formatScene(els: FmtElement[]): string {
  const visible = els.filter((e) => !e.isDeleted && !(e.type === "text" && e.containerId));
  const out: string[] = [];

  for (const f of visible.filter((e) => e.type === "frame")) {
    out.push(formatElement(f));
    for (const c of visible.filter((e) => e.frameId === f.id)) out.push(formatElement(c, 1));
  }

  const loose = visible.filter((e) => !e.frameId && e.type !== "frame");
  const groups: string[] = [];
  for (const e of loose) for (const g of e.groupIds ?? []) if (!groups.includes(g)) groups.push(g);

  for (const g of groups) {
    const members = loose.filter((e) => (e.groupIds ?? []).includes(g));
    out.push(`group      ${g.slice(0, 8)}  (${members.length} elements)`);
    for (const m of members) out.push(formatElement(m, 1));
  }

  for (const e of loose) if (!(e.groupIds ?? []).length) out.push(formatElement(e));
  return out.join("\n");
}

export function formatViewport(v: FmtViewport): string {
  return `viewport   (${round(v.x)},${round(v.y)} ${round(v.width)}×${round(v.height)}) zoom ${round2(v.zoom)}`;
}

/** The block a selection change is announced with. */
export function formatSelectionBlock(o: {
  file: string; rev: number; elements: FmtElement[]; viewport: FmtViewport; total?: number;
}): string {
  const total = o.total ?? o.elements.length;
  const shown = o.elements.slice(0, 40);
  const out = [`@excalidraw selection — ${o.file} (rev ${o.rev}, ${total} selected)`];
  for (const e of shown) out.push(formatElement(e));
  if (total > 40) out.push(`… and ${total - 40} more selected — read the scene for the rest`);
  out.push(formatViewport(o.viewport));
  return out.join("\n");
}

/** The block a pointed-at spot is announced with. */
export function formatPointBlock(o: {
  file: string; rev: number; point: [number, number]; near: FmtElement[]; viewport: FmtViewport;
}): string {
  const out = [
    `@excalidraw point — ${o.file} (rev ${o.rev})`,
    `point      (${round(o.point[0])},${round(o.point[1])})`,
  ];
  for (const n of nearest(o.point, o.near)) {
    out.push(`near       ${formatElement(n.el)}  — ${round(n.distance)}px ${n.direction}`);
  }
  out.push(formatViewport(o.viewport));
  return out.join("\n");
}

/**
 * Elements near a point, nearest first. Distance is measured to the bounding
 * box, so a point inside an element is 0px away from it.
 */
export function nearest(
  point: [number, number],
  els: FmtElement[],
  radius = 300,
  limit = 3,
): { el: FmtElement; distance: number; direction: string }[] {
  const [px, py] = point;
  return els
    .map((el) => {
      const dx = gap(px, el.x, el.x + el.width);
      const dy = gap(py, el.y, el.y + el.height);
      return { el, distance: Math.hypot(dx, dy), direction: compass(dx, dy) };
    })
    .filter((n) => n.distance <= radius)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/** Signed distance from `v` to the span [lo, hi]: negative when the span is before v. */
function gap(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - v;
  if (v > hi) return hi - v;
  return 0;
}

/** Where a thing at offset (dx, dy) lies from the point, dropping a minor axis. */
function compass(dx: number, dy: number): string {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const major = Math.max(ax, ay);
  if (major === 0) return "here";
  const horizontal = ax >= major * 0.4 ? (dx < 0 ? "left" : "right") : "";
  const vertical = ay >= major * 0.4 ? (dy < 0 ? "above" : "below") : "";
  return [vertical, horizontal].filter(Boolean).join("-");
}

/**
 * The one line ⌘K and ⌘⇧K put on the clipboard: a handle to a mark the session
 * server holds, with just enough beside it that the user can see what they
 * copied. The block itself stays on the server and the agent reads it back
 * with `getMark`.
 */
export function formatMarkHandle(o: {
  kind: "selection" | "point"; id: string; file: string; rev: number;
  count?: number; point?: [number, number];
}): string {
  const what = o.kind === "selection"
    ? `${o.count ?? 0} element${o.count === 1 ? "" : "s"}`
    : `(${round(o.point?.[0] ?? 0)},${round(o.point?.[1] ?? 0)})`;
  return `@excalidraw ${o.kind} ${o.id} — ${what} in ${o.file} (rev ${o.rev})`;
}
