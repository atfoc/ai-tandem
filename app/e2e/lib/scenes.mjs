// The drawings the control API (serverctl.mjs) puts on a board of the scratch server, `POST /board?scene=<name>`. The elements are
// those of the app's own fixtures (src/dev/boardfixtures.ts), so a board the flow opens is drawn as the board self-test draws.
import { base, scene, text } from "../../src/dev/boardfixtures.ts";

/** `chips`: one filled rectangle labelled "API" (so a tap anywhere inside it selects it, and its chip reads `rectangle “API”`). */
export const CHIPS_RECT = { id: "chips-rect", type: "rectangle", label: "API" };

export function sceneOf(name) {
  if (name === "chips") {
    return scene([
      base(CHIPS_RECT.id, "rectangle", 40, 120, 220, 120, { backgroundColor: "#a5d8ff", boundElements: [{ id: "chips-rect-text", type: "text" }] }),
      text("chips-rect-text", CHIPS_RECT.id, 70, 165, 160, CHIPS_RECT.label),
    ]);
  }
  if (name === "spread") { // three labelled rectangles far apart (ux-board: a board that opens fitted shows all of them with margins)
    const rect = (id, x, y, fill, label) => [
      base(id, "rectangle", x, y, 220, 120, { backgroundColor: fill, boundElements: [{ id: `${id}-text`, type: "text" }] }),
      text(`${id}-text`, id, x + 30, y + 45, 160, label),
    ];
    return scene([...rect("spread-a", 0, 0, "#a5d8ff", "Left"), ...rect("spread-b", 1400, 200, "#b2f2bb", "Right"), ...rect("spread-c", 700, 900, "#ffec99", "Bottom")]);
  }
  throw new Error(`no scene ${name}`);
}
