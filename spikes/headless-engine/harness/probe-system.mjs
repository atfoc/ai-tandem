// Can the native canvas reproduce Chromium's system fallback? Widths of each script, Nunito pieces + candidate fallback lists.
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
import { SCRIPTS } from "./probe-fallback.mjs";
const texts = Object.values(SCRIPTS);
const c = await startChromium(); await c.load("b", { elements: [], files: {}, appState: {} });
await c.warm(["20px Nunito, Segoe UI Emoji"], texts.join(""));
const [ref] = await c.measure(["20px Nunito, Segoe UI Emoji"], texts);
await c.close();
const n = await startNode();
const pieces = n.engine.nativeFont("20px Nunito").replace(/^20px /, "");
const lists = {
  "as is": "20px Nunito, Segoe UI Emoji",
  "+Times": `20px ${pieces}, Times`,
  "+Times+mac": `20px ${pieces}, Times, "PingFang SC", "Hiragino Sans", "Apple SD Gothic Neo", "Geeza Pro", "Lucida Grande", "Kohinoor Devanagari", Thonburi, "Apple Color Emoji"`,
  "+Times+emoji-first": `20px ${pieces}, Times, "Apple Color Emoji", "Hiragino Sans", "PingFang SC", "Apple SD Gothic Neo", "Geeza Pro", "Lucida Grande", "Kohinoor Devanagari", Thonburi`,
};
const ctx = (await import("@napi-rs/canvas")).createCanvas(1, 1).getContext("2d");
console.log("script".padEnd(11), "chromium".padStart(9), ...Object.keys(lists).map((k) => k.padStart(20)));
texts.forEach((t, i) => {
  const row = Object.values(lists).map((f) => { ctx.font = f; const w = ctx.measureText(t).width; return `${w.toFixed(2)} (${(w - ref[i]).toFixed(2)})`.padStart(20); });
  console.log(Object.keys(SCRIPTS)[i].padEnd(11), ref[i].toFixed(2).padStart(9), ...row);
});
