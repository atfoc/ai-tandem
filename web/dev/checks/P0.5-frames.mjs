// P0.5 ported (AD-80; package K3): the frame sampler on the page. It reads the composer's fit in every frame of a drag of the panel's
// resizer (the desktop: a mouse), and from the first frame of a reload (at the three viewports), and no frame has a control past the box.
// That it tells a wrong build from a right one is proved on a scratch page outside the repository, and on builds of this toolbar with its fit
// broken; A2.2 samples the other changes of the box. Ports dev/checks/P0.5-frames.mjs: the same state, widths and assertions; the probe is
// composer.mjs'. The widths of the drag are the desktop's (a window and a pane of saved width); at the tablet and the phone the device's own
// width is the pane's, so there is only the reload.
// At the phone (ux-improvements C1) the probe reads the phone's toolbar row, and the primary it waits for after the reload is Talk while the box is empty.
import { check, dragResizer, sampleFrames, seed } from "../shot.mjs";
import { composerProbe, openState } from "./composer.mjs";
import { tidSel } from "./sel.mjs";

export const viewports = ["desktop", "tablet", "phone"];

await check("P0.5 the frame sampler on the page", async ({ url, layout, open, fail, note }) => {
  const s = (await seed(url, "A2")).find((x) => x.id === "board-started");
  const { page } = await openState(open, s, layout, 480);
  let sampler, r;
  if (layout === "desktop") {
    sampler = await sampleFrames(page, composerProbe);
    await dragResizer(page, `${tidSel("board-panel")} ${tidSel("resizer")}`, -180);
    r = await sampler.stop();
    const boxes = r.values.map((v) => v.box);
    note(`a drag of the panel from 480 to 300 px: ${r.frames} frames, the box from ${Math.max(...boxes)} to ${Math.min(...boxes)} px, ${r.bad.length} frames not fitted`);
    if (r.values.length < 20 || r.values.length !== r.frames) fail(`the sampler read ${r.values.length} values in ${r.frames} frames of the drag`);
    if (Math.max(...boxes) < 440 || Math.min(...boxes) !== 275) fail(`the box went from ${Math.max(...boxes)} to ${Math.min(...boxes)} px, not from some 455 to 275`);
    if (new Set(boxes).size < 20) fail(`the sampler saw ${new Set(boxes).size} widths of the box: not every step of the drag`);
    if (r.bad.length) fail(`${r.bad.length} frames of the drag have a control past the box, Send out of reach or a sideways scroll, the first ${JSON.stringify(r.bad[0])}`);
  }

  sampler = await sampleFrames(page, composerProbe, { fromLoad: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(`${tidSel("send")}, ${tidSel("composer-talk")}`).first().waitFor({ state: "attached", timeout: 30000 }); // (the phone's empty box shows Talk, not Send)
  await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 }); // frames with the composer drawn
  r = await sampler.stop();
  note(`a reload: ${r.frames} frames from the page's first on, ${r.values.length} of them with the composer drawn`);
  if (r.frames <= r.values.length || !r.values.length) fail(`after a reload the sampler read ${r.values.length} values in ${r.frames} frames: it did not run from before the composer was drawn`);
  if (r.bad.length) fail(`${r.bad.length} frames of the reload are not fitted, the first ${JSON.stringify(r.bad[0])}`);
}, { viewports, page: false });
