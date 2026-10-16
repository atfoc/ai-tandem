// A window today: does the board on screen correct a text measured before its face was loaded? apply on target "live" in a
// fresh page (no face loaded), then the snapshot right away and after a second; also the engine path (target elements) cold.
import { startChromium } from "./chromium.mjs";
import { startNode } from "./node.mjs";
const text = "Сервис авторизации — Žluťoučký kůň";
const params = { create: [{ type: "text", key: "t", x: 0, y: 0, text }, { type: "rectangle", key: "r", x: 0, y: 100, width: 160, height: 60, label: { text } }] };
const pick = (els) => els.filter((e) => e.type === "text" && !e.isDeleted).map((e) => `${e.width.toFixed(2)}x${e.height.toFixed(2)}`).join(" ");
const n = await startNode();
const nv = await n.req({ op: "apply", target: { elements: [] }, rev: 1, params });
console.log("node             ", pick(nv.value.elements), " container height", nv.value.elements.find((e) => e.type === "rectangle").height);
const c = await startChromium();
const g = await c.req({ op: "apply", target: { elements: [] }, rev: 1, params });
console.log("window, engine   ", pick(g.value.elements), " container height", g.value.elements.find((e) => e.type === "rectangle").height);
await c.load("b", { elements: [], files: {}, appState: {} });
await c.req({ op: "apply", target: "live", rev: 1, params: { create: params.create.map((x) => ({ ...x, key: x.key + "2" })) } });
const s0 = await c.req({ op: "snapshot" });
console.log("window, live, now", pick(s0.value.elements), " container height", s0.value.elements.find((e) => e.type === "rectangle").height);
await c.page.waitForTimeout(1500);
const s1 = await c.req({ op: "snapshot" });
console.log("window, live, 1.5s", pick(s1.value.elements), " container height", s1.value.elements.find((e) => e.type === "rectangle").height, "versions", s1.value.elements.map((e) => e.version).join(","));
const g2 = await c.req({ op: "apply", target: { elements: [] }, rev: 1, params });
console.log("window, engine, after the faces loaded", pick(g2.value.elements));
await c.close();
