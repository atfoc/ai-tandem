// What of the stand-in page does Excalidraw's code reach for while the engine runs every case (risk 7.3)? Each global the
// page installs, and each property of `document`, is replaced by a getter that counts reads; then every case runs.
import { CASES } from "./cases.mjs";
const e = await import("../out/engine.mjs");
const seen = new Map();
const count = (k) => seen.set(k, (seen.get(k) ?? 0) + 1);
const names = ["window", "self", "document", "FontFace", "FileReader", "Image", "HTMLImageElement", "Path2D", "DOMMatrix", "ImageData", "devicePixelRatio", "innerWidth", "innerHeight", "matchMedia", "addEventListener", "removeEventListener", "requestAnimationFrame", "cancelAnimationFrame", "requestIdleCallback", "localStorage", "sessionStorage", "ResizeObserver", "IntersectionObserver", "MutationObserver", "getComputedStyle", "location", "navigator", "HTMLElement", "Element", "Node", "HTMLCanvasElement"];
for (const n of names) { const v = globalThis[n]; Object.defineProperty(globalThis, n, { configurable: true, get() { count(n); return v; } }); }
const doc = document;
const watched = new Proxy(doc, { get(t, k) { count(`document.${String(k)}`); const v = t[k]; return typeof v === "function" ? v.bind(t) : v; } });
Object.defineProperty(globalThis, "document", { configurable: true, get() { count("document"); return watched; } });
const created = new Map();
const ce = doc.createElement; doc.createElement = (tag) => { created.set(tag, (created.get(tag) ?? 0) + 1); return ce(tag); };
for (const c of CASES) {
  const scene = c.scene ? c.scene() : { elements: [], files: {}, appState: {} };
  let els = scene.elements.length ? (await e.request({ op: "restore", elements: scene.elements })).value.elements : [];
  for (const s of c.steps) { const r = await e.request(s.apply ? { op: "apply", target: { elements: els }, params: s.apply, rev: 1 } : { op: "delete", target: { elements: els }, refs: s.delete.refs, cascade: s.delete.cascade, rev: 1 }); if (r.ok) els = r.value.elements; }
  for (const p of c.pictures ?? []) await e.request({ op: "export", target: { elements: els, files: scene.files, appState: scene.appState }, ids: [], scale: p.scale ?? 1, background: true });
}
console.log("read while running (global: reads):", [...seen].filter(([k]) => k !== "document" && k !== "window").map(([k, v]) => `${k}:${v}`).join(", "));
console.log("elements created:", [...created].map(([k, v]) => `${k}:${v}`).join(", "));
console.log("never read while running:", names.filter((n) => !seen.has(n)).join(", "));
