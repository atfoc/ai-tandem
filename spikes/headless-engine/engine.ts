// The board engine on given elements: the requests of the board bridge that need no screen (`apply`, `delete`, `restore`,
// `export` with `target: { elements }`). This is the code of `packages/board-view/src/endpoint.ts`'s `ops` for a target
// that is not the live canvas, taken out unchanged (work package E1 moves it to `packages/board-view/src/engine.ts`, and the
// endpoint calls it for both targets). In a browser it runs in the board view; in Node, behind the stand-in page.
import { newElementWith, restoreElements } from "@excalidraw/excalidraw";
import type { ApplyValue, El, EngineOp, EngineValues, ExportValue, RestoreValue } from "@aiwb/board-bridge/messages.ts";
import { applyChanges, RpcError } from "../../packages/board-view/src/apply.ts";
import { exportPicture } from "../../packages/board-view/src/export.ts";

/** What an operation works on when the board is not the one on screen (board.ts engineFor): the given elements. */
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

/** An op on given elements (the screen-only `snapshot` and the `live` target are the board view's alone). */
export type GivenOp = Exclude<EngineOp, { op: "snapshot" }>;

const NO_HOOKS = (rev: number) => ({ pushUndo() {}, onChange() {}, saveNow() {}, rev: () => rev });

export const ops = {
  apply(m: Extract<GivenOp, { op: "apply" }>): ApplyValue {
    if (m.target === "live") throw new RpcError("NO_BOARD", "no board is shown");
    const given = elementsEngine(m.target.elements);
    const res = applyChanges(given, m.params as never, NO_HOOKS(m.rev));
    return { ...res, elements: given.elements() };
  },
  delete(m: Extract<GivenOp, { op: "delete" }>): ApplyValue {
    if (m.target === "live") throw new RpcError("NO_BOARD", "no board is shown");
    const eng = elementsEngine(m.target.elements);
    const res = applyChanges(eng, { delete: m.refs.map((ref) => ({ ref, cascade: m.cascade })) } as never, NO_HOOKS(m.rev));
    // a cascaded arrow keeps its bound label alive; take it with it
    const els: El[] = eng.getSceneElementsIncludingDeleted();
    const gone = new Set(els.filter((e) => e.isDeleted).map((e) => e.id));
    const orphans = els.filter((e) => !e.isDeleted && e.containerId && gone.has(e.containerId as string));
    if (orphans.length) eng.updateScene({ elements: els.map((e) => (orphans.includes(e) ? newElementWith(e as never, { isDeleted: true } as never) as unknown as El : e)) });
    return { ...res, elements: eng.elements() };
  },
  restore(m: Extract<GivenOp, { op: "restore" }>): RestoreValue {
    return { elements: restoreElements(m.elements as never, null) as unknown as El[] };
  },
  export(m: Extract<GivenOp, { op: "export" }>): Promise<ExportValue> {
    if (m.target === "live") throw new RpcError("NO_BOARD", "no board is shown");
    return exportPicture({
      elements: m.target.elements, files: m.target.files, viewBackgroundColor: m.target.appState.viewBackgroundColor,
      ids: m.ids, scale: m.scale, background: m.background,
    });
  },
};

/** One request in, its value or its refusal out, as the board view answers `req` (`res`). */
export async function request(op: GivenOp): Promise<{ ok: true; value: EngineValues[GivenOp["op"]] } | { ok: false; code: string; message: string }> {
  try {
    const f = (ops as Record<string, (m: GivenOp) => unknown>)[op.op];
    if (!f) throw new RpcError("SCREEN_ONLY", `${op.op} needs a board on a screen`);
    return { ok: true, value: (await f(op)) as never };
  } catch (e) {
    return { ok: false, code: e instanceof RpcError ? e.code : "FAILED", message: (e as Error)?.message ?? String(e) };
  }
}
