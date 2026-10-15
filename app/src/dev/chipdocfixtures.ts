// What the board would hand to the chip input on the chipdoc gallery: core's own factories (logic/refs.ts) on fixed elements,
// as the composer spike had them (spikes/composer/src/fixtures.ts). The gallery and its checks (web/dev/checks/
// L4b-chipdoc.mjs, app/e2e/verify/composer-chips-gallery.mjs) both use these, so a check knows what the value must be. No React: Node loads it.
import type { FmtElement } from "@aiwb/core/format.ts";
import { pointRef, selectionRef, type Ref } from "@aiwb/core/logic/refs.ts";

const el = (id: string, type: string, label?: string, x = 0, y = 0): FmtElement => ({ id, type, x, y, width: 160, height: 70, label });

export const SELECTIONS: (() => Ref)[] = [
  () => selectionRef([el("a1", "rectangle", "API", 10, 20)])!,
  () => selectionRef([el("b2", "ellipse", "DB", 200, 20), el("c3", "arrow")])!,
  () => selectionRef([el("d4", "rectangle", "Cache", 0, 100), el("e5", "rectangle", "Queue", 0, 200), el("f6", "rectangle")])!,
];
export const POINT = (): Ref => pointRef(120.4, -39.6, [el("a1", "rectangle", "API", 20, 0)]);
/** What the gallery's stand-in insert popup puts in (core logic/insert.ts), and what its stand-in @ list completes. */
export const INSERTED = "a prompt\nof two lines";
export const MENTION = { typed: "@bo", done: "@board " };
