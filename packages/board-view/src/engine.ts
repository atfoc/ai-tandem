// The board engine on given elements: the requests of the bridge that need no screen (`apply`, `delete`, `restore`, `export`
// with `target: { elements }`), taken out of `endpoint.ts`. The endpoint calls them for a target that is not the live canvas
// (and `applyOn`/`deleteOn` for the live one); the Node endpoint of `packages/board-engine` answers every request with them.
// It imports Excalidraw, apply.ts, export.ts and the bridge's types only: no React, no Board.tsx.
import "./fonts.ts"; // (before Excalidraw's module is evaluated: it wraps FontFace)
import { newElementWith, restoreElements } from "@excalidraw/excalidraw";
import type { ApplyValue, El, EngineOp, EngineValues, ExportValue, FromBoard, RestoreValue } from "@aiwb/board-bridge/messages.ts";
import { applyChanges, RpcError } from "./apply.ts";
import { exportPicture } from "./export.ts";
import { loadFaces } from "./faces.ts";
import { madeFaces } from "./fonts.ts";

/** The elements an operation works on when the board is not the one on screen (board.ts engineFor): the given elements. */
export function elementsEngine(elements: El[]) {
  let current: El[] = elements;
  return {
    getSceneElementsIncludingDeleted: () => current,
    updateScene: ({ elements: next }: { elements?: El[] }) => { if (next) current = next; },
    getAppState: () => ({ selectedElementIds: {} }),
    scrollToContent: () => {},
    elements: () => current,
  };
}

/** A request on given elements: every request but the screen-only `snapshot` (a `"live"` target is refused with `NO_BOARD`). */
export type GivenOp = Exclude<EngineOp, { op: "snapshot" }>;

const noBoard = () => new RpcError("NO_BOARD", "no board is shown");
const noHooks = (rev: number) => ({ pushUndo() {}, onChange() {}, saveNow() {}, rev: () => rev });

/** `apply` on an engine (the live canvas's Excalidraw API, or `elementsEngine`'s): what apply.ts returns. The faces the text of the
 *  request and of the engine's text elements needs are loaded first (faces.ts), so that it is measured with them. */
export async function applyOn(eng: any, m: Extract<GivenOp, { op: "apply" }>) {
  await loadFaces(madeFaces, m.params, eng.getSceneElementsIncludingDeleted());
  return applyChanges(eng, m.params as never, noHooks(m.rev));
}

/** `delete` on an engine: the refs, and with a cascaded arrow its bound label, which would otherwise stay alive. */
export async function deleteOn(eng: any, m: Extract<GivenOp, { op: "delete" }>) {
  await loadFaces(madeFaces, m.refs, eng.getSceneElementsIncludingDeleted()); // (a delete re-measures the text it unbinds)
  const res = applyChanges(eng, { delete: m.refs.map((ref) => ({ ref, cascade: m.cascade })) } as never, noHooks(m.rev));
  const els: El[] = eng.getSceneElementsIncludingDeleted();
  const gone = new Set(els.filter((e) => e.isDeleted).map((e) => e.id));
  const orphans = els.filter((e) => !e.isDeleted && e.containerId && gone.has(e.containerId as string));
  if (orphans.length) eng.updateScene({ elements: els.map((e) => (orphans.includes(e) ? newElementWith(e as never, { isDeleted: true } as never) as unknown as El : e)) });
  return res;
}

/** The four requests on given elements, one function each, as the endpoint answers them for a target that is not `"live"`. */
export const engineOps: { [Op in GivenOp["op"]]: (m: Extract<GivenOp, { op: Op }>) => EngineValues[Op] | Promise<EngineValues[Op]> } = {
  async apply(m): Promise<ApplyValue> {
    if (m.target === "live") throw noBoard();
    const given = elementsEngine(m.target.elements);
    const res = await applyOn(given, m);
    return { ...res, elements: given.elements() };
  },

  async delete(m): Promise<ApplyValue> {
    if (m.target === "live") throw noBoard();
    const given = elementsEngine(m.target.elements);
    const res = await deleteOn(given, m);
    return { ...res, elements: given.elements() };
  },

  restore(m): RestoreValue {
    return { elements: restoreElements(m.elements as never, null) as unknown as El[] };
  },

  async export(m): Promise<ExportValue> {
    if (m.target === "live") throw noBoard();
    return exportPicture({
      elements: m.target.elements, files: m.target.files, viewBackgroundColor: m.target.appState.viewBackgroundColor,
      ids: m.ids, scale: m.scale, background: m.background,
    });
  },
};

/** One request on given elements: its value, or an `RpcError` thrown. */
export async function request(op: GivenOp): Promise<EngineValues[GivenOp["op"]]> {
  const f = (engineOps as Record<string, ((m: GivenOp) => unknown) | undefined>)[op.op];
  if (!f) throw noBoard(); // (`snapshot`, and anything else that needs a screen)
  return (await f(op)) as EngineValues[GivenOp["op"]];
}

/** Runs a request and tells the result as `res`: the value → `ok: true`, an `RpcError` → its code and message, anything else →
 *  `FAILED`. `run` is how the request is carried out (the endpoint's, which knows the live canvas; by default `request`, so a
 *  request that needs a screen is `NO_BOARD`). */
export async function answer(id: number, op: EngineOp, post: (m: FromBoard) => void, run: (op: EngineOp) => unknown = request as never) {
  try {
    const value = await run(op);
    post({ t: "res", id, ok: true, value });
  } catch (e) {
    post({ t: "res", id, ok: false, code: e instanceof RpcError ? e.code : "FAILED", message: (e as Error)?.message ?? String(e) });
  }
}
