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
  throw new Error(`no scene ${name}`);
}
