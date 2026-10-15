// What the native chip input tells the device runner (app/e2e/run.mjs), package V3. Active only in a bundle made with
// EXPO_PUBLIC_AIWB_REPORT_URL (the runner sets it for a flow whose header says `report=1`); with none, `report` does nothing and
// `reportState` / `reportRaw` are undefined, so the box in a build for people draws and posts nothing. Used by the chipdoc gallery
// (its Mark and Send buttons) and by ChipInput.native.tsx (the composer's own box: what it holds after every change, and the
// selection the platform reported before the box moved it out of a chip).
import type { DocState } from "../platform/chipinput/ChipDocInput.tsx";

const REPORT = process.env.EXPO_PUBLIC_AIWB_REPORT_URL;
const run = Math.random().toString(36).slice(2, 8); // (the app starts again between two attempts and its counter with it)
let seq = 0, queue = Promise.resolve();

/** Posts to the device runner, one post at a time and each within 5 s, and logs the same to Metro's log, which the runner reads
 *  too: nothing is lost when a post through adb reverse hangs. */
export const report = (o: object): void => {
  if (!REPORT) return;
  const body = JSON.stringify({ run, seq: seq++, ...o });
  console.log(`AIWB_REPORT ${body}`);
  queue = queue.then(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((r) => { timer = setTimeout(() => { stop.abort(); r(); }, 5000); }); // (also when the abort is not honoured)
    return Promise.race([fetch(REPORT, { method: "POST", body, signal: stop.signal }).then(() => {}, () => {}), late]).finally(() => clearTimeout(timer));
  });
};

/** The box's `onState` and `onRaw` for the runner, or undefined when the build has no report address. */
export const reportState = REPORT ? (s: DocState) => report({ state: s }) : undefined;
export const reportRaw = REPORT ? (s: { start: number; end: number }) => report({ raw: s }) : undefined;
