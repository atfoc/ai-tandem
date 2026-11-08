// The sticky tool: tldraw's box tool (a click places a note at its default size, a drag sizes it, then back to select).
import { BaseBoxShapeTool } from "tldraw";
import { STICKY_TYPE } from "./StickyShapeUtil.tsx";

export class StickyTool extends BaseBoxShapeTool {
  static override id = STICKY_TYPE;
  static override initial = "idle";
  override shapeType = STICKY_TYPE;
}
