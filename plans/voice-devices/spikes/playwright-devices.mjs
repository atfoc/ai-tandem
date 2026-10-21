// Spike (vd-architecture): what the browser checks' Chromium (Playwright, launched with shot.mjs's BROWSER_ARGS) gives a page for audio
// devices: the list before and after the microphone permission, labels, AudioContext.setSinkId on a fake output, and whether getUserMedia
// answers. Run: node plans/voice-devices/spikes/playwright-devices.mjs <path to playwright's index.mjs>
import http from "node:http";
const { chromium } = await import(process.argv[2]);
const server = http.createServer((_q, s) => { s.setHeader("content-type", "text/html"); s.end("<!doctype html><title>spike</title>"); }).listen(0, "127.0.0.1");
await new Promise((ok) => server.once("listening", ok));
const url = `http://127.0.0.1:${server.address().port}/`;
// NO_FAKE_UI=1 leaves out --use-fake-ui-for-media-stream: the permission is then only what the context grants (a real browser before the prompt).
const args = [...(process.env.NO_FAKE_UI ? [] : ["--use-fake-ui-for-media-stream"]), "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"];
const probe = (page) => page.evaluate(async () => {
  const T = (p, ms = 6000) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(Object.assign(new Error("timeout"), { name: "Timeout" })), ms))]);
  const sum = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind !== "videoinput").map((d) => `${d.kind}:${d.label || "(no label)"}:${d.deviceId ? (d.deviceId === "default" ? "default" : "id") : "(no id)"}`);
  const r = { chrome: navigator.userAgent.match(/Chrome\/[0-9.]+/)?.[0], list: await sum() };
  const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audiooutput" && d.deviceId && d.deviceId !== "default");
  const ctx = new AudioContext();
  try { await T(ctx.setSinkId(outs[0]?.deviceId ?? "nope")); r.setSinkId = outs[0] ? "ok" : "no output listed"; } catch (e) { r.setSinkId = e.name; }
  try { await T(ctx.setSinkId("bogus")); r.bogus = "ok"; } catch (e) { r.bogus = e.name; }
  await ctx.close();
  try { const s = await T(navigator.mediaDevices.getUserMedia({ audio: true })); r.gum = "ok"; r.after = await sum(); s.getTracks().forEach((t) => t.stop()); } catch (e) { r.gum = e.name; }
  return r;
});
for (const headless of [true]) {
  const browser = await chromium.launch({ args, headless });
  for (const permissions of [[], ["microphone"]]) {
    const ctx = await browser.newContext({ permissions });
    const page = await ctx.newPage();
    await page.goto(url);
    console.log(JSON.stringify({ fakeUI: !process.env.NO_FAKE_UI, headless, permissions, ...(await probe(page)) }));
    await ctx.close();
  }
  await Promise.race([browser.close(), new Promise((ok) => setTimeout(ok, 8000))]);
}
server.close();
process.exit(0);
