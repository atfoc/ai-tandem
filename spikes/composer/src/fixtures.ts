// What the board would hand over to the composer: the page's own factories (logic/refs.ts) on fixed elements.
// The spike's screen and its checks both use these, so the checks know what the message must be.
import { pointRef, selectionRef } from "../../../web/src/logic/refs.ts";
import type { FmtElement } from "../../../web/src/format.ts";

const el = (id: string, type: string, label?: string, x = 0, y = 0): FmtElement => ({ id, type, x, y, width: 160, height: 70, label });

export const SELECTIONS = [
  () => selectionRef([el("a1", "rectangle", "API", 10, 20)])!,
  () => selectionRef([el("b2", "ellipse", "DB", 200, 20), el("c3", "arrow")])!,
  () => selectionRef([el("d4", "rectangle", "Cache", 0, 100), el("e5", "rectangle", "Queue", 0, 200), el("f6", "rectangle")])!,
];
export const POINT = () => pointRef(120.4, -39.6, [el("a1", "rectangle", "API", 20, 0)]);
