// The scene engine: one `apply` call in, one Excalidraw scene update out.
//
// Everything here ran in the prototype and is moved across unchanged in
// behaviour — it is the part the prototype proved out — with one change: new
// elements get the clean, technical defaults (architect roughness, sharp
// corners, sharp non-elbow arrows, the normal font) unless the agent asks for
// another style. Updates never get these defaults. What Excalidraw's public
// API does not do (routing arrows, moving bound text, re-measuring a label,
// keeping `boundElements` in sync) the page does itself, and this is where.
import { convertToExcalidrawElements, newElementWith, CaptureUpdateAction, FONT_FAMILY, ROUNDNESS } from "@excalidraw/excalidraw";

export type El = any;
export type Ref = { id: string } | { key: string };

export type ApplyParams = {
  create?: any[]; update?: any[]; delete?: any[]; select?: Ref[]; focus?: boolean;
};
export type ApplyResult = {
  created: Record<string, string>;
  updated: string[];
  deleted: string[];
  conflicts: { ref: Ref; expectedVersion: number; actualVersion: number | undefined }[];
  rev: number;
};
export type ApplyHooks = {
  pushUndo: (elements: El[], changeId: string | null) => void;
  onChange: (c: { created: number; updated: number; deleted: number; ids: string[] }) => void;
  saveNow: () => void;
  rev: () => number;
};

export class RpcError extends Error {
  code: string; data?: unknown;
  constructor(code: string, msg: string, data?: unknown) { super(msg); this.code = code; this.data = data; }
}

const rid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6);
export const keyOf = (e: El) => e?.customData?.key as string | undefined;
/** A ref is an object with a string `id` or `key`; anything else (a bare "server") is rejected clearly. */
const isRef = (r: any): r is Ref => !!r && typeof r === "object" && !Array.isArray(r) && (typeof r.id === "string" || typeof r.key === "string");
export const matches = (e: El, r: Ref) => !!e && ("id" in r ? e.id === r.id : keyOf(e) === r.key);

// Excalidraw's public API binds an arrow but does not route it between existing
// shapes, so the page computes an edge-to-edge straight route itself.
type Box = { x: number; y: number; width: number; height: number };
export function edgePoint(b: Box, toward: [number, number], gap: number): [number, number] {
  const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
  const dx = toward[0] - cx, dy = toward[1] - cy;
  if (!dx && !dy) return [cx, cy];
  const sx = dx ? (b.width / 2) / Math.abs(dx) : Infinity, sy = dy ? (b.height / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy), len = Math.hypot(dx, dy);
  return [cx + dx * t + (dx / len) * gap, cy + dy * t + (dy / len) * gap];
}
export function route(a: Box | null, b: Box | null, fallback: { x: number; y: number; points: number[][] }) {
  const center = (q: Box) => [q.x + q.width / 2, q.y + q.height / 2] as [number, number];
  const p0: [number, number] = a ? edgePoint(a, b ? center(b) : [fallback.x + fallback.points.at(-1)![0], fallback.y + fallback.points.at(-1)![1]], 6) : [fallback.x, fallback.y];
  const p1: [number, number] = b ? edgePoint(b, a ? center(a) : p0, 6) : [fallback.x + fallback.points.at(-1)![0], fallback.y + fallback.points.at(-1)![1]];
  const w = p1[0] - p0[0], h = p1[1] - p0[1];
  return { x: p0[0], y: p0[1], width: Math.abs(w), height: Math.abs(h), points: [[0, 0], [w, h]] };
}

export function styleOf(u: any) {
  const o: any = {};
  if (u.fontFamily) o.fontFamily = { hand: FONT_FAMILY.Excalifont, normal: FONT_FAMILY.Nunito, code: FONT_FAMILY["Comic Shanns"] }[u.fontFamily as string] ?? u.fontFamily;
  if (u.roundness !== undefined) o.roundness = u.roundness === "round" ? { type: ROUNDNESS.ADAPTIVE_RADIUS } : u.roundness === "sharp" || !u.roundness ? null : u.roundness;
  if (u.roughness !== undefined) o.roughness = { architect: 0, artist: 1, cartoonist: 2 }[u.roughness as string] ?? u.roughness;
  return o;
}

/** The clean look every element an agent creates starts from (section 6). */
const CLEAN_CREATE = { roughness: 0, roundness: null, fontFamily: FONT_FAMILY.Nunito };

// A style change on a container has to cascade to its bound label: the protocol
// says an unchanged or off-centre label after one of these is a bug, not a
// limitation. Every key here is re-measured through convertToExcalidrawElements.
const RELABEL_KEYS = ["width", "height", "fontSize", "fontFamily", "roughness", "strokeColor", "opacity"];

export function applyChanges(api: any, p: ApplyParams, hooks: ApplyHooks): ApplyResult {
  const current: El[] = api.getSceneElementsIncludingDeleted();
  const byId = new Map<string, El>(current.map((e) => [e.id, e]));
  // ifVersion is checked against the scene as it was before this call, not
  // against versions this same call already bumped (e.g. by binding an arrow)
  const before = new Map<string, number>(current.map((e) => [e.id, e.version]));
  const live = () => [...byId.values()].filter((e) => !e.isDeleted);
  const keyToId = new Map<string, string>();
  for (const e of live()) if (keyOf(e)) keyToId.set(keyOf(e)!, e.id);

  const creates: any[] = [];
  const updates: any[] = [...(p.update ?? [])];
  // keys assigned (or renamed) by an update can be referred to in the same call
  for (const u of updates) if (u.customData?.key && isRef(u.ref) && "id" in u.ref) keyToId.set(u.customData.key, u.ref.id);
  const result: ApplyResult = { created: {}, updated: [], deleted: [], conflicts: [], rev: 0 };

  // upsert: an existing key turns a create into an update
  (p.create ?? []).forEach((c: any, i: number) => {
    if (c.key && keyToId.has(c.key)) {
      const ex = byId.get(keyToId.get(c.key)!)!;
      if (ex.type !== c.type) throw new RpcError("BAD_PARAMS", `key ${c.key} is a ${ex.type}, not a ${c.type}`, { path: `create[${i}].type` });
      const { type, key, start, end, label, ...rest } = c;
      updates.push({ ref: { key }, ...rest, ...(label ? { label: label.text } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) });
    } else {
      creates.push({ ...c, _id: rid(), _i: i });
      if (c.key) keyToId.set(c.key, creates[creates.length - 1]._id);
    }
  });
  const newIds = new Set(creates.map((c) => c._id));
  const resolveId = (r: Ref, where: string): string => {
    if (!isRef(r)) throw new RpcError("BAD_REF", `${where}: a ref is {"key": "..."} or {"id": "..."}, not ${JSON.stringify(r)}`, { ref: r, path: where });
    const id = "id" in r ? r.id : keyToId.get(r.key);
    if (!id || (!newIds.has(id) && (!byId.get(id) || byId.get(id).isDeleted))) throw new RpcError("BAD_REF", `no live element for ${JSON.stringify(r)}`, { ref: r, path: where });
    return id;
  };
  // validate everything before changing anything (atomic on validation errors)
  updates.forEach((u, i) => { resolveId(u.ref, `update[${i}].ref`); if (u.moveBy && (u.x !== undefined || u.y !== undefined)) throw new RpcError("BAD_PARAMS", "moveBy with x/y", { path: `update[${i}]` }); });
  (p.delete ?? []).forEach((d: any, i: number) => resolveId(d.ref, `delete[${i}].ref`));

  // ---- creates → skeletons → convertToExcalidrawElements
  const skel: any[] = [];
  const skelBox = (id: string) => { const c = creates.find((c) => c._id === id); return c && { x: c.x ?? 0, y: c.y ?? 0, width: c.width ?? 100, height: c.height ?? 100 }; };
  const existingNeeded = new Set<string>();
  const toSkeleton = (c: any): any => {
    const { key, _id, _i, children, groupWith, start, end, label, ...rest } = c;
    // clean defaults first, then the agent's own style (mapped by styleOf over the raw values)
    const s: any = { ...CLEAN_CREATE, ...rest, ...styleOf(rest), id: _id ?? rid() };
    if (s.x === undefined) s.x = 0; // arrows bound at both ends get their position from the binding
    if (s.y === undefined) s.y = 0;
    if (label) s.label = { fontFamily: s.fontFamily, ...(typeof label === "string" ? { text: label } : label) };
    if (s.type !== "text") delete s.fontFamily; // only text carries a font; a label got it above
    if (s.type === "arrow" || s.type === "line") s.elbowed = false;
    for (const [side, v] of [["start", start], ["end", end]] as const) {
      if (!v) continue;
      if (v && typeof v === "object" && "create" in v) s[side] = toSkeleton(v.create);
      else { const id = resolveId(v, `${side}`); s[side] = { id }; if (!newIds.has(id)) existingNeeded.add(id); }
    }
    if ((s.type === "arrow" || s.type === "line") && !s.points && s.start && s.end) {
      const box = (x: any) => x.id && !x.type ? (byId.get(x.id) ?? skelBox(x.id)) : x;
      Object.assign(s, route(box(s.start), box(s.end), { x: s.x, y: s.y, points: [[0, 0], [100, 0]] }));
      delete s.width; delete s.height;
    }
    if (children) s.children = children.map((r: Ref) => resolveId(r, "children"));
    return s;
  };
  for (const c of creates) skel.push(toSkeleton(c));
  const newEls: El[] = [];
  if (skel.length) {
    const existingSkel = [...existingNeeded].map((id) => ({ ...byId.get(id) }));
    const out: El[] = convertToExcalidrawElements([...existingSkel, ...skel] as any, { regenerateIds: false });
    for (const e of out) {
      if (existingNeeded.has(e.id)) {
        // only take the new arrow bindings from the regenerated copy
        const old = byId.get(e.id);
        const extra = (e.boundElements ?? []).filter((b: any) => b.type === "arrow" && !(old.boundElements ?? []).some((o: any) => o.id === b.id));
        byId.set(e.id, newElementWith(old, { boundElements: [...(old.boundElements ?? []), ...extra] }));
        continue;
      }
      newEls.push(e);
    }
    for (const c of creates) {
      const e = newEls.find((x) => x.id === c._id);
      if (!e) continue;
      if (c.key) e.customData = { ...(e.customData ?? {}), key: c.key };
      result.created[c.key ?? `#${c._i}`] = e.id;
      if (c.groupWith) {
        const g = rid(); e.groupIds = [...e.groupIds, g];
        for (const r of c.groupWith) { const id = resolveId(r, "groupWith"); const t = byId.get(id) ?? newEls.find((x) => x.id === id); if (byId.has(id)) byId.set(id, newElementWith(t, { groupIds: [...t.groupIds, g] })); else t.groupIds = [...t.groupIds, g]; }
      }
    }
    for (const e of newEls) byId.set(e.id, e);
  }

  // ---- updates
  const touched = new Set<string>();
  const rerouted = new Set<string>();
  for (const u of updates) {
    const id = resolveId(u.ref, "update");
    let e = byId.get(id);
    if (u.ifVersion !== undefined && before.has(id) && before.get(id) !== u.ifVersion) { result.conflicts.push({ ref: u.ref, expectedVersion: u.ifVersion, actualVersion: before.get(id) }); continue; }
    const { ref, ifVersion, moveBy, label, text, start, end, customData, x, y, ...rest } = u;
    let patch: any = { ...rest, ...styleOf(rest) };
    let dx = 0, dy = 0;
    if (moveBy) { dx = moveBy[0]; dy = moveBy[1]; }
    if (x !== undefined) dx = x - e.x;
    if (y !== undefined) dy = y - e.y;
    patch.x = e.x + dx; patch.y = e.y + dy;
    if (customData) patch.customData = { ...(e.customData ?? {}), ...customData };
    e = newElementWith(e, patch);
    byId.set(id, e);
    // bound text follows its container
    const bt = e.boundElements?.find((b: any) => b.type === "text");
    if (bt && (dx || dy)) { const t = byId.get(bt.id); byId.set(bt.id, newElementWith(t, { x: t.x + dx, y: t.y + dy })); }
    if (text !== undefined && e.type === "text") byId.set(id, remeasureText(e, text));
    const needsRelabel = label !== undefined || (bt && RELABEL_KEYS.some((k) => rest[k] !== undefined));
    if (needsRelabel) relabel(id, label === undefined ? byId.get(bt.id)?.text : label);
    if (start !== undefined || end !== undefined) rebind(id, start, end);
    touched.add(id);
    result.updated.push(id);
  }

  // ---- deletes
  for (const d of p.delete ?? []) {
    const id = resolveId(d.ref, "delete");
    const e = byId.get(id);
    // an element created by this same call has no `before` version to compare
    // against, and is never in conflict with itself
    if (d.ifVersion !== undefined && before.has(id) && before.get(id) !== d.ifVersion) { result.conflicts.push({ ref: d.ref, expectedVersion: d.ifVersion, actualVersion: before.get(id) }); continue; }
    byId.set(id, newElementWith(e, { isDeleted: true }));
    result.deleted.push(id);
    for (const b of e.boundElements ?? []) {
      const t = byId.get(b.id); if (!t) continue;
      if (b.type === "text") byId.set(b.id, newElementWith(t, { isDeleted: true }));
      else if (d.cascade) { byId.set(b.id, newElementWith(t, { isDeleted: true })); result.deleted.push(b.id); }
      else byId.set(b.id, newElementWith(t, { startBinding: t.startBinding?.elementId === id ? null : t.startBinding, endBinding: t.endBinding?.elementId === id ? null : t.endBinding }));
    }
    if (e.type === "frame") for (const c of byId.values()) if (c.frameId === id) byId.set(c.id, newElementWith(c, { frameId: null }));
  }

  // ---- keep arrows attached to anything that moved or resized
  for (const id of touched) for (const b of byId.get(id).boundElements ?? []) if (b.type === "arrow" && !rerouted.has(b.id)) { reroute(b.id); rerouted.add(b.id); }

  const elements = [...byId.values()];
  hooks.pushUndo(current, null);
  api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY }); // one undo step
  if (p.select) api.updateScene({ appState: { selectedElementIds: Object.fromEntries(p.select.map((r: Ref) => [resolveId(r, "select"), true])) } });
  if (p.focus) api.scrollToContent(elements.filter((e) => result.updated.includes(e.id) || Object.values(result.created).includes(e.id)), { animate: false });
  hooks.saveNow();
  result.rev = hooks.rev();
  const ids = [...Object.values(result.created), ...result.updated];
  if (ids.length || result.deleted.length) {
    hooks.onChange({ created: Object.keys(result.created).length, updated: result.updated.length, deleted: result.deleted.length, ids });
  }
  return result;

  // --- helpers that re-run Excalidraw's own conversion for text measuring and binding
  function relabel(containerId: string, newText: string | null) {
    const c = byId.get(containerId);
    const oldBt = c.boundElements?.find((b: any) => b.type === "text");
    const oldT = oldBt && byId.get(oldBt.id);
    if (oldT) byId.set(oldT.id, newElementWith(oldT, { isDeleted: true }));
    let bound = (c.boundElements ?? []).filter((b: any) => b.type !== "text");
    let patch: any = {};
    if (newText) {
      // the container has already been patched, so its style is the new style:
      // the label is measured and drawn with it, never with the old one
      const style: any = {};
      for (const k of ["fontFamily", "roughness", "strokeColor", "opacity"]) if (c[k] !== undefined) style[k] = c[k];
      const label: any = { text: newText, fontSize: c.fontSize ?? oldT?.fontSize, fontFamily: c.fontFamily ?? oldT?.fontFamily, strokeColor: c.strokeColor ?? oldT?.strokeColor };
      if (c.type === "arrow") {
        const [a, t] = convertToExcalidrawElements([{ type: "arrow", id: c.id, x: c.x, y: c.y, points: c.points, ...style, label }] as any, { regenerateIds: false });
        byId.set(t.id, t); bound = [...bound, { id: t.id, type: "text" }];
      } else {
        const [nc, t] = convertToExcalidrawElements([{ type: c.type, id: c.id, x: c.x, y: c.y, width: c.width, height: c.height, ...style, label: { ...label, textAlign: oldT?.textAlign, verticalAlign: oldT?.verticalAlign } }] as any, { regenerateIds: false });
        byId.set(t.id, t); bound = [...bound, { id: t.id, type: "text" }];
        patch = { width: nc.width, height: nc.height }; // the label may have grown the container
      }
    }
    byId.set(containerId, newElementWith(byId.get(containerId), { ...patch, boundElements: bound }));
  }
  function remeasureText(e: El, t: string) {
    const [n] = convertToExcalidrawElements([{ type: "text", x: e.x, y: e.y, text: t, fontSize: e.fontSize, fontFamily: e.fontFamily }] as any);
    return newElementWith(e, { text: t, originalText: t, width: n.width, height: n.height });
  }
  function rebind(arrowId: string, start: Ref | null | undefined, end: Ref | null | undefined) {
    const a = byId.get(arrowId);
    const unbindFrom = (b: any) => { if (!b) return; const t = byId.get(b.elementId); if (t) byId.set(t.id, newElementWith(t, { boundElements: (t.boundElements ?? []).filter((x: any) => x.id !== arrowId) })); };
    const patch: any = {};
    if (start !== undefined) { unbindFrom(a.startBinding); patch.startBinding = start ? { elementId: resolveId(start, "start"), focus: 0, gap: 1 } : null; }
    if (end !== undefined) { unbindFrom(a.endBinding); patch.endBinding = end ? { elementId: resolveId(end, "end"), focus: 0, gap: 1 } : null; }
    byId.set(arrowId, newElementWith(a, patch));
    for (const b of [patch.startBinding, patch.endBinding]) if (b) { const t = byId.get(b.elementId); if (!(t.boundElements ?? []).some((x: any) => x.id === arrowId)) byId.set(t.id, newElementWith(t, { boundElements: [...(t.boundElements ?? []), { id: arrowId, type: "arrow" }] })); }
    reroute(arrowId); rerouted.add(arrowId);
  }
  function reroute(arrowId: string) {
    const a = byId.get(arrowId);
    if (!a || a.isDeleted) return;
    const sEl = a.startBinding && byId.get(a.startBinding.elementId);
    const tEl = a.endBinding && byId.get(a.endBinding.elementId);
    if (!sEl && !tEl) return;
    const r = route(sEl ?? null, tEl ?? null, a);
    byId.set(arrowId, newElementWith(a, r as any));
    const lbl = a.boundElements?.find((b: any) => b.type === "text");
    if (lbl) { const tl = byId.get(lbl.id); const mx = r.x + r.points[1][0] / 2, my = r.y + r.points[1][1] / 2; byId.set(tl.id, newElementWith(tl, { x: mx - tl.width / 2, y: my - tl.height / 2 })); }
  }
}
