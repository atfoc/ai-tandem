// The microphone of the voice checks that listen (VC.3, VC.4, VC.6, VC.7; no dash in the name, the runner does not take it for a check).
// The checks' Chromium has a fake microphone (shot.mjs BROWSER_ARGS): the page captures a real MediaStream from it with no prompt, and the
// whole capture path (the stream, the conversion to 16 kHz, the frames) is then proved with the browser's own device. On the machine P13a
// was written on, `getUserMedia` never answers although the browser lists the fake devices and opens one: Chromium 153 and 156 on macOS 15
// (a MacBook Pro with the virtual audio driver "NDI Audio" installed) log `GenerateStreams` ... `OnStreamStarted` in the browser process and the
// renderer's promise stays pending, and the whole browser then stops answering clicks. It makes no difference with the sandbox off, the
// permission given or not, `--use-file-for-fake-audio-capture`, the headless shell or the full browser, or the audio service in the
// browser process (which hangs the page at once). Whether a machine without such a driver is spared is not verified. Where it hangs,
// `useMic` puts a stand-in for the device into the page: a stream of an oscillator that the page's own AudioContext makes, which goes through
// the same capture path from the stream on. It says so (note), so that a run that did not prove the browser's device is told as such.
// AIWB_MIC=device never falls back (a hang then fails the check); AIWB_MIC=synthetic never probes.
import { launchChromium, loadPlaywright } from "../shot.mjs";

const PROBE_MS = 6000;
let mode = process.env.AIWB_MIC === "device" || process.env.AIWB_MIC === "synthetic" ? process.env.AIWB_MIC : null;

/** Whether the browser's microphone answers `getUserMedia` within `ms`. It is asked of a browser of its own, closed at once: a request that never
 *  answers keeps its whole browser from answering a click, in any page (the first tries asked in the app's page, then in a page of its own). */
async function answers(page, ms) {
  const browser = await launchChromium(await loadPlaywright());
  try {
    const ctx = await browser.newContext({ permissions: ["microphone"] });
    const probe = await ctx.newPage();
    await probe.goto(new URL("/mock/state", page.url()).href);
    return await probe.evaluate(async (limit) => {
      try {
        const stream = await Promise.race([navigator.mediaDevices.getUserMedia({ audio: true }), new Promise((_, no) => setTimeout(() => no(new Error("timeout")), limit))]);
        stream.getTracks().forEach((t) => t.stop());
        return true;
      } catch { return false; }
    }, ms);
  } finally { await Promise.race([browser.close().catch(() => {}), new Promise((ok) => setTimeout(ok, 8000))]); }
}

/** Puts a stand-in microphone into the page (until it is loaded anew): an oscillator on the page's own AudioContext, as a stream. */
export const installSyntheticMic = (page) => page.evaluate(() => {
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = new AudioContext();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    const osc = ctx.createOscillator(), out = ctx.createMediaStreamDestination();
    osc.connect(out);
    osc.start();
    const stream = out.stream;
    stream.getAudioTracks().forEach((t) => { const stop = t.stop.bind(t); t.stop = () => { stop(); osc.stop(); void ctx.close(); }; });
    return stream;
  };
});

/** Makes sure the page has a microphone that answers. Answers "device" (the browser's fake one) or "synthetic". `note`: the check's. The probe is
 *  made once per process, on the first page. */
export async function useMic(page, note) {
  if (mode === null) {
    mode = await answers(page, PROBE_MS) ? "device" : "synthetic";
    if (mode === "synthetic") note("the browser's fake microphone never answered getUserMedia on this machine: the checks that listen use a synthetic stream in its place (mic.mjs says why)");
  }
  if (mode === "synthetic") await installSyntheticMic(page);
  return mode;
}
