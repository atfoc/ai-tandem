// What the board side reads of a scene without an engine (the old page's board.ts and apply.ts, the parts that need no
// Excalidraw): the error a board tool answers with, an element's key, the scene's version, the elements as the format of
// read_board takes them, the box of some elements, and the prefixes of ids an agent shortened.
import type { FmtElement } from "../format.ts";

/** An element of a scene, loose: the board side reads its id, version, place and links, the engine the rest. */
export type El = Record<string, any> & { id: string; version: number };

/** A board tool's refusal: a code the agent can act on and a sentence (conn.ts answers `<code>: <message>`). */
export class RpcError extends Error {
  code: string; data?: unknown;
  constructor(code: string, msg: string, data?: unknown) { super(msg); this.code = code; this.data = data; }
}

/** The key an agent gave an element (apply.ts keyOf). */
export const keyOf = (e: El | undefined) => e?.customData?.key as string | undefined;

/** The version of a scene: the sum of its elements' versions, deleted ones included (Excalidraw's getSceneVersion). */
export const sceneVersion = (els: readonly El[]) => els.reduce((n, e) => n + (e.version ?? 0), 0);

/** The elements that are not deleted. */
export const live = (els: readonly El[]) => els.filter((e) => !e.isDeleted);

/** Whether an element matches one of the refs (by id or key). */
export const refMatch = (refs: any[]) => (e: El) => refs.some((r: any) => (r?.id && r.id === e.id) || (r?.key && keyOf(e) === r.key));

export function toFmt(els: readonly El[]): FmtElement[] {
  const byId = new Map(els.map((e) => [e.id, e]));
  const labelOf = (e: El): string | undefined => {
    if (e.type === "text") return e.text;
    const bt = e.boundElements?.find((b: any) => b.type === "text");
    return bt ? byId.get(bt.id)?.text : undefined;
  };
  const name = (id?: string) => {
    if (!id) return undefined;
    const t = byId.get(id);
    if (!t) return undefined;
    return keyOf(t) ?? (labelOf(t) ? JSON.stringify(labelOf(t)) : `id=${id}`);
  };
  return els.map((e) => ({
    id: e.id, type: e.type, x: e.x, y: e.y, width: e.width, height: e.height, key: keyOf(e), label: labelOf(e),
    isDeleted: e.isDeleted, containerId: e.containerId, frameId: e.frameId, groupIds: e.groupIds,
    startRef: name(e.startBinding?.elementId), endRef: name(e.endBinding?.elementId),
  }));
}

export type Box = { x: number; y: number; width: number; height: number };

/** The box around some elements (an arrow or a line by its points); null for none. */
export function bbox(els: readonly El[]): Box | null {
  if (!els.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of els) {
    const xs = e.points ? e.points.map((p: number[]) => e.x + p[0]) : [e.x, e.x + e.width];
    const ys = e.points ? e.points.map((p: number[]) => e.y + p[1]) : [e.y, e.y + e.height];
    x0 = Math.min(x0, ...xs); x1 = Math.max(x1, ...xs); y0 = Math.min(y0, ...ys); y1 = Math.max(y1, ...ys);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Agents sometimes shorten ids. Any `{id}` ref in the arguments that is not an
 * exact id but is a unique prefix of one of `ids` (the scene's elements that are not deleted) is expanded to it.
 */
export function expandIds(ids: readonly string[], v: any): any {
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== "object") return x;
    const out: any = {};
    for (const [k, val] of Object.entries(x)) {
      if (k === "id" && typeof val === "string" && !ids.includes(val)) {
        const hits = ids.filter((i) => i.startsWith(val));
        out[k] = hits.length === 1 ? hits[0] : val;
      } else out[k] = walk(val);
    }
    return out;
  };
  return walk(v);
}
