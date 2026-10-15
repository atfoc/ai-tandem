// Proves that an agent's board tools run through the page of the app, as the server relays them (the `rpc` knob of the mock): apply
// on a board that is not on screen (the engine view does it) and on the board on screen, get_image (a PNG with the bounds of what it drew),
// delete_elements, show_board. The scenario is dev/agenttools.mjs; this file opens the page and names the testIDs of a flash. At the desktop and at the phone: the board is
// the same component in both, and a tool call must not care whether the board's screen is under a chat or beside it.
import { agentTools } from "../agenttools.mjs";
import { check } from "../shot.mjs";
import { tidSel } from "./sel.mjs";

export const viewports = ["desktop", "phone"];

await check("L6 an agent's board tools run through the page", async ({ url, open, fail, note, viewport }) => {
  await agentTools({
    url, fail, note: (line) => note(line),
    open: async (sel) => {
      const { ctx, page } = await open({ sel });
      return { page, close: () => ctx.close() };
    },
    sel: { flash: tidSel("flash"), flashLabel: tidSel("flash-label"), presence: tidSel("presence") },
    canvasOf: async (page) => (await page.locator(`${tidSel("board-canvas", { board: "b_ui", state: "ready" })} .excalidraw:not(.excalidraw--view-mode) canvas.interactive`).count()) > 0,
  });
  void viewport;
}, { viewports, page: false });
