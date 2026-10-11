// Proves that the driver's frame sampler runs on the page: it reads the composer's fit in every frame of a drag of
// the panel's resizer, and from the first frame of a reload, and no frame has a control past the box. That it tells
// a wrong build from a right one is proved on a scratch page outside the repository (the run's J0-sampler), and on
// builds of this toolbar with its fit broken (the run's J4-mutations). A2.2 samples the other changes of the box.
import { check, composerProbe, dragResizer, openPage, paneSize, sampleFrames, seed } from "../shot.mjs";

await check("P0.5 the frame sampler on the page", async ({ url, browser, fail, note }) => {
  const s = (await seed(url, "A2")).find((x) => x.id === "board-started");
  const { ctx, page } = await openPage({ url, browser, sel: s.sel, ...paneSize("panel", 480), wait: ".composer-box" });
  await page.waitForSelector(s.see);
  let sampler = await sampleFrames(page, composerProbe);
  await dragResizer(page, ".board-panel .resizer", -180);
  let r = await sampler.stop();
  const boxes = r.values.map((v) => v.box);
  note(`a drag of the panel from 480 to 300 px: ${r.frames} frames, the box from ${Math.max(...boxes)} to ${Math.min(...boxes)} px, ${r.bad.length} frames not fitted`);
  if (r.values.length < 20 || r.values.length !== r.frames) fail(`the sampler read ${r.values.length} values in ${r.frames} frames of the drag`);
  if (Math.max(...boxes) < 440 || Math.min(...boxes) !== 275) fail(`the box went from ${Math.max(...boxes)} to ${Math.min(...boxes)} px, not from some 455 to 275`);
  if (new Set(boxes).size < 20) fail(`the sampler saw ${new Set(boxes).size} widths of the box: not every step of the drag`);
  if (r.bad.length) fail(`${r.bad.length} frames of the drag have a control past the box, Send out of reach or a sideways scroll, the first ${JSON.stringify(r.bad[0])}`);

  sampler = await sampleFrames(page, composerProbe, { fromLoad: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(s.see);
  await page.waitForFunction(() => window.__frames?.values.length > 2, null, { timeout: 15000 }); // frames with the composer drawn
  r = await sampler.stop();
  note(`a reload: ${r.frames} frames from the page's first on, ${r.values.length} of them with the composer drawn`);
  if (r.frames <= r.values.length || !r.values.length) fail(`after a reload the sampler read ${r.values.length} values in ${r.frames} frames: it did not run from before the composer was drawn`);
  if (r.bad.length) fail(`${r.bad.length} frames of the reload are not fitted, the first ${JSON.stringify(r.bad[0])}`);
  await ctx.close();
});
