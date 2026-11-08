// Miro-like navigation in the select tool (goal 3.1, 7.3): a left drag on empty canvas pans, a Shift (or Ctrl/⌘) drag on
// empty canvas brushes a selection box, a double-click on empty canvas makes a sticky ready to type in.
//
// tldraw is not patched. Its SelectTool is subclassed with two of its child states replaced by subclasses of themselves
// (found by id in `SelectTool.children()`, since the state classes are not exported) and one state added:
// - `pointing_canvas`: the selection is cleared on pointer up (a click), not on pointer down, so a pan keeps it; a drag goes
//   to `panning_canvas`, or to tldraw's own `brushing` when Shift/Ctrl/⌘ was held at pointer down. A pointer down inside
//   an unfilled shape goes to tldraw's `pointing_shape` instead, so a drag there moves the shape (spike-ui-nav.md, item 10).
// - `idle`: a double-click on empty canvas creates a sticky (tldraw's own text-on-double-click is off by option).
// - `panning_canvas`: moves the camera with the pointer, from the point where the pointer went down.
// Everything else (wheel, pinch, Space+drag, middle drag, zoom limits) is tldraw's camera options and editor options
// (src/nav/options.ts).
import { SelectTool, StateNode, Vec, createShapeId, startEditingShapeWithRichText, type TLPointerEventInfo, type TLClickEventInfo, type TLStateNodeConstructor } from "tldraw";
import { STICKY_TYPE, STICKY_SIZE } from "../sticky/StickyShapeUtil.tsx";

function child(id: string): TLStateNodeConstructor {
  const c = SelectTool.children().find((k) => k.id === id);
  if (!c) throw new Error(`tldraw's select tool has no "${id}" state (tldraw changed?)`);
  return c;
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
    if (!this.additive) {
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

  override onDoubleClick(info: TLClickEventInfo) {
    if (info.phase === "down" && info.target === "canvas" && !this.editor.getIsReadonly()) {
      const p = this.editor.inputs.getCurrentPagePoint();
      const hit = this.editor.getShapeAtPoint(p, { hitInside: true, margin: this.editor.getHitTestMargin() });
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
