// A helper of the checks that draw on a board's canvas (SEC.7-board.mjs, AAC.2-board.mjs; not a check: no dash in its name): one more
// rectangle by the pointer of the viewport, in a place of the canvas that is empty at every viewport's width. A mouse presses the tool's key
// (after a click on an empty place, which gives the canvas the keys) and drags; a finger taps the rectangle in the toolbar (the keys do not
// reach a canvas that no mouse clicked) and drags. It first waits for the screen's sign that the view has drawn the board (`board-canvas`
// in the state `ready`): until then the app covers the stage (`canvas-empty`, so no other board's drawing shows) and a press at the
// canvas lands on the cover, so a drawing made at once is lost whole. The canvas of Excalidraw is there (LIVE) a few ms before that.
import { touchDrag, touchNow } from "./sel.mjs";

export const LIVE = ".excalidraw:not(.excalidraw--view-mode) canvas.interactive";
const DRAWN = '[data-testid="board-canvas"][data-state="ready"]';

/** `draw()` draws a rectangle on the canvas of `page`; the nth goes beside the last (three to a row, then the next row). */
export function drawer(page) {
  let drawn = 0;
  return async function draw() {
    await page.waitForSelector(DRAWN, { timeout: 20000 });
    const b = await page.locator(LIVE).boundingBox();
    const x = b.x + b.width * 0.2 + (drawn % 3) * b.width * 0.22, y = b.y + b.height * 0.5 + Math.floor(drawn / 3) * 90;
    drawn++;
    if (await touchNow(page)) {
      const t = await page.locator('[data-testid="toolbar-rectangle"]').boundingBox();
      await page.touchscreen.tap(t.x + t.width / 2, t.y + t.height / 2);
      // (Excalidraw takes a touch within 300 ms of the last one for a double tap, which opens its text editor)
      await new Promise((ok) => setTimeout(ok, 450));
      await touchDrag(page, { x, y }, { x: x + 80, y: y + 60 }, { hold: 0, steps: 8 });
    } else {
      await page.mouse.click(b.x + b.width * 0.3, b.y + b.height * 0.85); // (an empty place of the canvas, which takes the keys)
      await page.keyboard.press("r");
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y + 30, { steps: 4 }); await page.mouse.move(x + 80, y + 60, { steps: 4 }); await page.mouse.up();
    }
  };
}
