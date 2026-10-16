// What the Node engine costs: time to load it, the first apply and the first picture, memory (RSS) at each step, and the
// steady time of an apply and a picture on the large case.
import { CASES } from "./cases.mjs";
const mb = () => (process.memoryUsage().rss / 1e6).toFixed(0) + " MB";
const t0 = performance.now(); const rss0 = mb();
const e = await import("../out/engine.mjs");
const t1 = performance.now();
const small = await e.request({ op: "apply", target: { elements: [] }, rev: 1, params: CASES[0].steps[0].apply });
const t2 = performance.now();
const pic = await e.request({ op: "export", target: { elements: small.value.elements, files: {}, appState: {} }, ids: [], scale: 1, background: true });
const t3 = performance.now();
console.log(`node ${process.version} ${process.platform}-${process.arch}, ${e.lib.name}: before load ${rss0}`);
console.log(`load ${(t1 - t0).toFixed(0)} ms (${mb()}), first apply ${(t2 - t1).toFixed(0)} ms, first picture ${(t3 - t2).toFixed(0)} ms (${mb()})`);
const large = CASES.find((c) => c.name === "large");
let els = [];
let t = performance.now();
for (const s of large.steps) els = (await e.request({ op: "apply", target: { elements: els }, rev: 1, params: s.apply })).value.elements;
const ta = performance.now() - t;
t = performance.now();
const all = await e.request({ op: "export", target: { elements: els, files: {}, appState: {} }, ids: [], scale: 0.25, background: true });
const te = performance.now() - t;
t = performance.now();
const one = await e.request({ op: "apply", target: { elements: els }, rev: 3, params: { update: [{ ref: { key: "n1_1" }, moveBy: [5, 5] }] } });
const tu = performance.now() - t;
t = performance.now();
const json = JSON.stringify(els); const tj = performance.now() - t;
console.log(`large: ${els.length} elements (${(json.length / 1e6).toFixed(1)} MB of JSON, stringify ${tj.toFixed(0)} ms); the two applies ${ta.toFixed(0)} ms, one more update ${tu.toFixed(0)} ms, picture of all at 0.25 ${te.toFixed(0)} ms (${all.value.width}x${all.value.height}); ${mb()}`);
