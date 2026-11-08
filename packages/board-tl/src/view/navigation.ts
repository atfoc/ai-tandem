// Miro-like navigation (goal 3.1, 7.3; lifted from the UI spike's nav/select.ts and nav/options.ts).
//
// The select tool: a left drag on empty canvas pans, a Shift (or Ctrl/⌘) drag on empty canvas brushes a selection box, a
// double-click on empty canvas makes a sticky ready to type in.
//
// tldraw is not patched. Its SelectTool is subclassed with two of its child states replaced by subclasses of themselves
// (found by id in `SelectTool.children()`, since the state classes are not exported) and one state added:
// - `pointing_canvas`: the selection is cleared on pointer up (a click), not on pointer down, so a pan keeps it; a drag goes
//   to `panning_canvas`, or to tldraw's own `brushing` when Shift/Ctrl/⌘ was held at pointer down. A pointer down inside
//   an unfilled shape goes to tldraw's `pointing_shape` instead, so a drag there moves the shape (spike-ui-nav.md, item 10).
// - `idle`: a double-click on empty canvas creates a sticky (tldraw's own text-on-double-click is off by option).
// - `panning_canvas`: moves the camera with the pointer, from the point where the pointer went down.
// Locked elements (spike-ui-ctx.md, gap 5; Miro's behaviour): a pointer down on a locked element goes to `pointing_canvas`
// like empty canvas (tldraw's own does that for the element itself; `idle` also routes a down on the selection's body there
// when a locked element is under the pointer), so a drag pans; a click (no drag) selects it, Shift adds it, so the context
// bar can offer Unlock. tldraw draws no resize/rotate handles for a locked element and ignores updates to it anyway.
// The connector tool (`ConnectorTool`, at the end): a click places a connector of the default length (tldraw makes none).
// Everything else (wheel, pinch, Space+drag, middle drag, zoom limits) is tldraw's camera and editor options below.
import {
  ArrowShapeTool,
  SelectTool,
  StateNode,
  Vec,
  createShapeId,
  startEditingShapeWithRichText,
  type TLCameraOptions,
  type TLClickEventInfo,
  type TLPointerEventInfo,
  type TLStateNodeConstructor,
  type TldrawOptions,
} from "tldraw";
import { STICKY_SIZE, STICKY_TYPE } from "../model/palette.ts";

/** Zoom limits about 10%–400% (the first and last steps are the limits); the wheel pans, Ctrl/⌘ + wheel and a trackpad
 *  pinch (which the browser sends as a wheel with ctrlKey) zoom around the pointer. The steps are those of the zoom buttons
 *  and the +/− keys; tldraw skips a step it is already past half of, so coarse steps jumped (85% → 200%). */
export const CAMERA: Partial<TLCameraOptions> = {
  wheelBehavior: "pan",
  zoomSteps: [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4],
  panSpeed: 1,
  zoomSpeed: 1,
  isLocked: false,
};

export const OPTIONS: Partial<TldrawOptions> = {
  // a double-click on empty canvas makes a sticky (Idle below), not tldraw's text
  createTextOnCanvasDoubleClick: false,
  // Space + drag pans over anything (tldraw's own); the middle button always pans (tldraw's own, no option)
  spacebarPanning: true,
  // the right button stays for a context menu of ours later
  rightClickPanning: false,
  maxPages: 1,
};

function child(id: string): TLStateNodeConstructor {
  const c = SelectTool.children().find((k) => k.id === id);
  if (!c) throw new Error(`tldraw's select tool has no "${id}" state (tldraw changed?)`);
  return c;
}

/** The locked element under a page point, if any (the top-most element there, when that one is locked). */
function lockedAt(editor: StateNode["editor"], p: Vec) {
  const hit = editor.getShapeAtPoint(p, { hitInside: true, hitLocked: true, margin: editor.getHitTestMargin(), renderingOnly: true });
  return hit && editor.isShapeOrAncestorLocked(hit) ? editor.getOutermostSelectableShape(hit) : undefined;
}

const PointingCanvasBase = child("pointing_canvas") as unknown as typeof StateNode;
const IdleBase = child("idle") as unknown as typeof StateNode;

class PointingCanvas extends PointingCanvasBase {
  static override id = "pointing_canvas";
  private additive = false;

  override onEnter(info: TLPointerEventInfo) {
    // (tldraw's own clears the selection here; ours waits for the pointer up, so a drag-to-pan keeps the selection)
    this.additive = !!(info.shiftKey || info.accelKey);
    // tldraw treats the inside of an unfilled shape as canvas (a drag there would pan); Miro moves the shape, so a
    // pointer down inside one is handed to tldraw's own pointing_shape (select on down, drag translates, click selects).
    // Frames are not hit inside (hitFrameInside stays false), so a drag on a frame's empty area still pans.
    if (!this.additive && !lockedAt(this.editor, this.editor.inputs.getCurrentPagePoint())) {
      const hollow = this.editor.getShapeAtPoint(this.editor.inputs.getCurrentPagePoint(), { hitInside: true, margin: 0, renderingOnly: true });
      if (hollow && (this.editor.options.selectLockedShapes || !hollow.isLocked)) {
        this.parent.transition("pointing_shape", { ...info, target: "shape", shape: hollow });
      }
    }
  }

  override onPointerMove(info: TLPointerEventInfo) {
    if (!this.editor.inputs.getIsDragging()) return;
    if (this.additive) this.parent.transition("brushing", { ...info, didMarkHistory: false });
    else this.parent.transition("panning_canvas", info);
  }

  override onPointerUp(info: TLPointerEventInfo) {
    // a click on a locked element selects it (Shift/Ctrl/⌘: adds or removes it); it never moves (a drag panned instead)
    const locked = lockedAt(this.editor, this.editor.inputs.getCurrentPagePoint());
    if (locked) {
      const ids = this.editor.getSelectedShapeIds();
      this.editor.markHistoryStoppingPoint("selecting locked shape");
      if (!this.additive) this.editor.setSelectedShapes([locked.id]);
      else this.editor.setSelectedShapes(ids.includes(locked.id) ? ids.filter((i) => i !== locked.id) : [...ids, locked.id]);
      this.parent.transition("idle", info);
      return;
    }
    if (!this.additive && this.editor.getSelectedShapeIds().length > 0) {
      this.editor.markHistoryStoppingPoint("selecting none");
      this.editor.selectNone();
    }
    // tldraw's own: selects a hollow shape under the pointer, then back to idle
    (PointingCanvasBase.prototype as any).onPointerUp.call(this, info);
  }
}

class PanningCanvas extends StateNode {
  static override id = "panning_canvas";
  private origin = new Vec();
  private start = new Vec();

  override onEnter() {
    const cam = this.editor.getCamera();
    this.start = new Vec(cam.x, cam.y);
    this.origin = this.editor.inputs.getOriginScreenPoint().clone();
    this.editor.setCursor({ type: "grabbing", rotation: 0 });
    this.pan();
  }

  private pan() {
    const z = this.editor.getZoomLevel();
    const d = Vec.Sub(this.editor.inputs.getCurrentScreenPoint(), this.origin).div(z);
    this.editor.setCamera({ x: this.start.x + d.x, y: this.start.y + d.y, z }, { immediate: true });
  }

  override onPointerMove() { this.pan(); }
  override onPointerUp() { this.done(); }
  override onCancel() { this.done(); }
  override onComplete() { this.done(); }
  override onInterrupt() { this.done(); }
  override onExit() { this.editor.setCursor({ type: "default", rotation: 0 }); }
  private done() { this.parent.transition("idle"); }
}

class Idle extends IdleBase {
  static override id = "idle";

  override onPointerDown(info: TLPointerEventInfo) {
    // a down on the body of a selection (not a handle) or on a shape, with a locked element on top under the pointer, is a
    // down on canvas: a drag pans, a click selects the locked element (PointingCanvas)
    if ((info.target === "selection" && !info.handle) || info.target === "shape" || info.target === "canvas") {
      if (lockedAt(this.editor, this.editor.inputs.getCurrentPagePoint())) {
        this.parent.transition("pointing_canvas", { ...info, target: "canvas" });
        return;
      }
    }
    (IdleBase.prototype as any).onPointerDown.call(this, info);
  }

  override onDoubleClick(info: TLClickEventInfo) {
    // On the second pointer *up*, not down: two fingers landing < 40 px apart (the start of a pinch-out) are a "double
    // click" for tldraw's ClickManager at the second finger's down, but a pinch never delivers that pointer up
    // (spike-ui-nav.md, item 9). A double click/tap ends with an up, which comes here once pointing_canvas went back to idle.
    if (info.phase === "up" && info.target === "canvas" && !this.editor.getIsReadonly() && !this.editor.inputs.getIsPinching()) {
      const p = this.editor.inputs.getCurrentPagePoint();
      const hit = this.editor.getShapeAtPoint(p, { hitInside: true, hitLocked: true, margin: this.editor.getHitTestMargin() });
      if (!hit) {
        this.editor.markHistoryStoppingPoint("creating sticky");
        const id = createShapeId();
        this.editor.createShape({ id, type: STICKY_TYPE, x: p.x - STICKY_SIZE / 2, y: p.y - STICKY_SIZE / 2 });
        startEditingShapeWithRichText(this.editor, id, { info });
        return;
      }
    }
    (IdleBase.prototype as any).onDoubleClick.call(this, info);
  }
}

export class MiroSelectTool extends SelectTool {
  static override children(): TLStateNodeConstructor[] {
    return [
      ...SelectTool.children().map((c) => (c.id === "pointing_canvas" ? PointingCanvas : c.id === "idle" ? Idle : c)),
      PanningCanvas,
    ] as TLStateNodeConstructor[];
  }
}

/** The connector's default length, for a click with the connector tool. */
export const CONNECTOR_LENGTH = 200;

const ArrowPointingBase = ArrowShapeTool.children().find((k) => k.id === "pointing") as unknown as typeof StateNode | undefined;
if (!ArrowPointingBase) throw new Error('tldraw\'s arrow tool has no "pointing" state (tldraw changed?)');

class ConnectorPointing extends ArrowPointingBase {
  static override id = "pointing";
  override onPointerUp() {
    // tldraw's own makes nothing on a click (no drag); goal 3.3 wants an element at its default size: a straight connector
    // from the click to the right, selected, and back to select (unless the tool is locked)
    (ArrowPointingBase!.prototype as any).onPointerUp.call(this);
    if (this.editor.getIsReadonly()) return;
    const p = this.editor.inputs.getCurrentPagePoint();
    const id = createShapeId();
    this.editor.markHistoryStoppingPoint("creating connector");
    this.editor.createShape({ id, type: "arrow", x: p.x, y: p.y, props: { start: { x: 0, y: 0 }, end: { x: CONNECTOR_LENGTH, y: 0 } } });
    this.editor.select(id);
    if (!this.editor.getInstanceState().isToolLocked) this.editor.setCurrentTool("select");
  }
}

/** The connector tool: tldraw's arrow tool, with a click placing a connector of the default length. */
export class ConnectorTool extends ArrowShapeTool {
  static override children(): TLStateNodeConstructor[] {
    return ArrowShapeTool.children().map((c) => (c.id === "pointing" ? ConnectorPointing : c)) as TLStateNodeConstructor[];
  }
}
