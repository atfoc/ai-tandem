// The boards and `apply` sequences of the faithfulness harness (goal 6.1). Each case starts from an empty board or a saved
// one (restored by the engine, as the app's board side restores what it reads), runs its steps as the app's board side sends
// them (`apply` / `delete` on `target: { elements }`), and asks for pictures (`export`) of the result. Refs are by key, never by
// id: ids are random on each side.
import { createCanvas } from "./pngs.mjs";

const SCRIPTS = {
  latin: "Deploy the API gateway behind the load balancer",
  accents: "Žluťoučký kůň úpěl ďábelské ódy — façade, naïve, Größe, Łódź",
  cyrillic: "Сервис авторизации отвечает за токены и сессии",
  greek: "Η υπηρεσία πιστοποίησης εκδίδει διακριτικά",
  cjk: "认证服务负责令牌 と セッション 및 세션",
  emoji: "Ship it 🚀 when ✅ tests pass 👍🏽",
};
const FONTS = { hand: 5, normal: 6, code: 8, virgil: 1, helvetica: 2, cascadia: 3, lilita: 7, liberation: 9 };

/** A picture of every element. */
const ALL = { name: "all", ids: () => [] };

// ---- saved boards
let n = 0;
const nid = () => `fixture${++n}`;
const base = (type, x, y, w, h, more = {}) => ({
  id: more.id ?? nid(), type, x, y, width: w, height: h, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
  strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1234 + n, version: 3,
  versionNonce: 99 + n, isDeleted: false, boundElements: [], updated: 1700000000000, link: null, locked: false, ...more,
});

/** A board a person drew: hand-drawn style, an elbow arrow bound by fixed points, a group, a frame with children, rotated text. */
function savedBoard() {
  const a = base("rectangle", 0, 0, 180, 80, { id: "s-a", roundness: { type: 3 }, backgroundColor: "#a5d8ff", boundElements: [{ id: "s-el", type: "arrow" }, { id: "s-at", type: "text" }] });
  const at = base("text", 10, 27.5, 160, 25, { id: "s-at", text: "Gateway", originalText: "Gateway", fontSize: 20, fontFamily: 5, textAlign: "center", verticalAlign: "middle", containerId: "s-a", lineHeight: 1.25, autoResize: true });
  const b = base("diamond", 400, 160, 160, 120, { id: "s-b", boundElements: [{ id: "s-el", type: "arrow" }] });
  const el = base("arrow", 182, 40, 298, 118, {
    id: "s-el", elbowed: true, points: [[0, 0], [149, 0], [149, 118], [298, 118]], roundness: null, lastCommittedPoint: null,
    startBinding: { elementId: "s-a", focus: 0, gap: 1, fixedPoint: [1.0111, 0.5] }, endBinding: { elementId: "s-b", focus: 0, gap: 1, fixedPoint: [0.5, -0.0083] },
    startArrowhead: null, endArrowhead: "arrow", fixedSegments: null, startIsSpecial: null, endIsSpecial: null,
  });
  const g1 = base("ellipse", 0, 300, 100, 60, { id: "s-g1", groupIds: ["grp1"] });
  const g2 = base("ellipse", 120, 300, 100, 60, { id: "s-g2", groupIds: ["grp1"] });
  const fr = base("frame", 600, 0, 320, 240, { id: "s-fr", name: "Storage" });
  const fc = base("rectangle", 640, 60, 120, 60, { id: "s-fc", frameId: "s-fr" });
  const ft = base("text", 640, 150, 200, 25, { id: "s-ft", frameId: "s-fr", text: "inside the frame", originalText: "inside the frame", fontSize: 20, fontFamily: 6, textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true });
  const rt = base("text", 0, 420, 240, 25, { id: "s-rt", angle: 0.4, text: "rotated note", originalText: "rotated note", fontSize: 20, fontFamily: 1, textAlign: "left", verticalAlign: "top", containerId: null, lineHeight: 1.25, autoResize: true });
  const fd = base("freedraw", 300, 400, 120, 60, { id: "s-fd", points: Array.from({ length: 30 }, (_, i) => [i * 4, Math.round(30 + 25 * Math.sin(i / 4))]), pressures: [], simulatePressure: true, lastCommittedPoint: null });
  const ln = base("line", 450, 400, 150, 40, { id: "s-ln", points: [[0, 0], [75, 40], [150, 0]], roundness: { type: 2 }, strokeStyle: "dashed", lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
  return { elements: [a, at, b, el, g1, g2, fr, fc, ft, rt, fd, ln], files: {}, appState: { viewBackgroundColor: "#ffffff" } };
}

/** A board with pictures: a PNG, a JPEG and an SVG, one cropped, one in a frame. */
function imageBoard() {
  const png = createCanvas(160, 100, "png"), jpg = createCanvas(200, 120, "jpeg"), svg = svgData();
  const files = {
    fpng: { id: "fpng", mimeType: "image/png", dataURL: png, created: 1700000000000 },
    fjpg: { id: "fjpg", mimeType: "image/jpeg", dataURL: jpg, created: 1700000000000 },
    fsvg: { id: "fsvg", mimeType: "image/svg+xml", dataURL: svg, created: 1700000000000 },
  };
  const img = (id, fileId, x, y, w, h, more = {}) => base("image", x, y, w, h, { id, fileId, status: "saved", scale: [1, 1], crop: null, ...more });
  const fr = base("frame", 500, 0, 300, 260, { id: "i-fr", name: "Screens" });
  return {
    elements: [
      img("i-png", "fpng", 0, 0, 160, 100),
      img("i-jpg", "fjpg", 200, 0, 200, 120, { crop: { x: 20, y: 10, width: 160, height: 100, naturalWidth: 200, naturalHeight: 120 } }),
      img("i-svg", "fsvg", 0, 160, 120, 120),
      fr, img("i-in", "fpng", 540, 60, 160, 100, { frameId: "i-fr" }),
    ],
    files, appState: { viewBackgroundColor: "#ffffff" },
  };
}
function svgData() {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><rect x="5" y="5" width="110" height="110" rx="12" fill="#ffd43b" stroke="#e67700" stroke-width="6"/><circle cx="60" cy="60" r="30" fill="#4dabf7"/><path d="M20 100 L60 20 L100 100 Z" fill="none" stroke="#212529" stroke-width="4"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(s).toString("base64")}`;
}

/** A large board: a grid of labelled shapes joined by arrows (created by the engine itself, in one apply). */
function largeCreate(cols, rows) {
  const create = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    create.push({ type: c % 3 === 1 ? "ellipse" : "rectangle", key: `n${r}_${c}`, x: c * 220, y: r * 140, width: 160, height: 70, label: { text: `Service ${r}.${c} ${SCRIPTS[Object.keys(SCRIPTS)[(r + c) % 4]].slice(0, 14)}` } });
  }
  for (let r = 0; r < rows; r++) for (let c = 0; c + 1 < cols; c++) create.push({ type: "arrow", key: `a${r}_${c}`, start: { key: `n${r}_${c}` }, end: { key: `n${r}_${c + 1}` } });
  for (let r = 0; r + 1 < rows; r++) create.push({ type: "arrow", key: `v${r}`, start: { key: `n${r}_0` }, end: { key: `n${r + 1}_0` }, label: { text: "next" } });
  return create;
}

export const CASES = [
  {
    name: "trial", desc: "the trial's board: labels, a wrapping label in an ellipse, a bound arrow with a label, a resize, a text change, a delete",
    steps: [
      { apply: { create: [
        { type: "rectangle", key: "a", x: 0, y: 0, width: 160, height: 60, label: { text: "API gateway" } },
        { type: "rectangle", key: "b", x: 320, y: 0, width: 120, height: 60, label: { text: "Database" } },
        { type: "ellipse", key: "c", x: 160, y: 200, width: 200, height: 90, label: { text: "A longer label that must wrap inside" } },
        { type: "text", key: "t", x: 0, y: 340, text: "Free text\nsecond line", fontSize: 24 },
        { type: "arrow", key: "ar", x: 0, y: 0, points: [[0, 0], [100, 0]], start: { key: "a" }, end: { key: "b" }, label: { text: "reads" } },
      ] } },
      { apply: { update: [{ ref: { key: "b" }, width: 260, height: 90 }, { ref: { key: "t" }, text: "Changed text that is much wider" }] } },
      { apply: { delete: [{ ref: { key: "c" } }] } },
    ],
    pictures: [ALL, { name: "refs-a-b", ids: (els, k) => [k("a"), k("b")] }],
  },
  {
    name: "scripts", desc: "a long label per script that wraps in a fixed-width box, in the normal and the hand font, then relabelled and restyled",
    steps: [
      { apply: { create: Object.entries(SCRIPTS).flatMap(([s, text], i) => [
        { type: "rectangle", key: `n-${s}`, x: 0, y: i * 160, width: 180, height: 60, label: { text } },
        { type: "rectangle", key: `h-${s}`, x: 260, y: i * 160, width: 180, height: 60, fontFamily: "hand", label: { text, fontFamily: 5 } },
        { type: "text", key: `t-${s}`, x: 520, y: i * 160, text, fontFamily: "normal" },
      ]) } },
      { apply: { update: Object.keys(SCRIPTS).flatMap((s) => [
        { ref: { key: `n-${s}` }, label: SCRIPTS[s] + " " + SCRIPTS[s].split(" ").reverse().join(" ") },
        { ref: { key: `h-${s}` }, fontSize: 28 },
        { ref: { key: `t-${s}` }, text: SCRIPTS[s].toUpperCase() },
      ]) } },
    ],
    pictures: [ALL, { name: "cjk-row", ids: (els, k) => [k("n-cjk"), k("h-cjk"), k("t-cjk")] }],
  },
  {
    name: "fonts", desc: "every font Excalidraw offers (the three of the agent's style and the five others by number), text and labels, multi-line",
    steps: [
      { apply: { create: Object.entries(FONTS).flatMap(([f, id], i) => [
        { type: "text", key: `t-${f}`, x: 0, y: i * 120, text: `${f}: The quick brown fox\nПривет — Ελλάδα — Łódź`, fontFamily: id, fontSize: 20 },
        { type: "rectangle", key: `r-${f}`, x: 420, y: i * 120, width: 200, height: 70, label: { text: `${f} label that wraps over two lines`, fontFamily: id } },
      ]) } },
    ],
    pictures: [ALL],
  },
  {
    name: "frames-groups", desc: "a frame with children, a group, an arrow from inside the frame to outside, moving the frame's child and the group",
    steps: [
      { apply: { create: [
        { type: "rectangle", key: "in1", x: 40, y: 60, width: 140, height: 60, label: { text: "inside one" } },
        { type: "ellipse", key: "in2", x: 220, y: 60, width: 140, height: 80, label: { text: "inside two" } },
        { type: "frame", key: "fr", x: 0, y: 0, width: 420, height: 200, name: "Backend", children: [{ key: "in1" }, { key: "in2" }] },
        { type: "rectangle", key: "g1", x: 0, y: 300, width: 100, height: 50 },
        { type: "rectangle", key: "g2", x: 140, y: 300, width: 100, height: 50, groupWith: [{ key: "g1" }] },
        { type: "arrow", key: "x", start: { key: "in2" }, end: { key: "g2" }, label: { text: "calls" } },
      ] } },
      { apply: { update: [{ ref: { key: "in2" }, moveBy: [20, 30] }, { ref: { key: "g2" }, x: 300, y: 320 }] } },
    ],
    pictures: [ALL, { name: "frame", ids: (els, k) => [k("fr")] }, { name: "frame+children", ids: (els, k) => [k("fr"), k("in1"), k("in2")] },
      { name: "region", ids: (els) => els.filter((e) => !e.isDeleted && !e.containerId && e.x >= -10 && e.y >= 250 && e.x + e.width <= 500 && e.y + e.height <= 400).map((e) => e.id) }],
  },
  {
    name: "saved-board", desc: "a board a person drew (hand-drawn, elbow arrow by fixed points, group, frame, rotated text, freedraw, curved dashed line), restored, then moved and relabelled by an agent",
    scene: savedBoard,
    steps: [
      { apply: { update: [{ ref: { id: "s-b" }, moveBy: [60, 40] }, { ref: { id: "s-a" }, label: "Gateway with a much longer name" }] } },
      { apply: { create: [{ type: "arrow", key: "new", start: { id: "s-g2" }, end: { id: "s-fc" } }], update: [{ ref: { id: "s-fr" }, name: "Storage tier" }] } },
      { delete: { refs: [{ id: "s-g1" }], cascade: false } },
    ],
    pictures: [ALL, { name: "frame", ids: () => ["s-fr"] }, { name: "elbow", ids: () => ["s-el"] }],
  },
  {
    name: "images", desc: "a board with a PNG, a cropped JPEG, an SVG and a picture in a frame; one moved, one resized; pictures of all and of the frame",
    scene: imageBoard,
    steps: [
      { apply: { update: [{ ref: { id: "i-png" }, moveBy: [0, 300] }, { ref: { id: "i-svg" }, width: 180, height: 180 }], create: [{ type: "text", key: "cap", x: 0, y: 420, text: "Pictures with a caption" }] } },
    ],
    pictures: [ALL, { name: "frame", ids: () => ["i-fr"] }, { name: "svg", ids: () => ["i-svg"] }],
  },
  {
    name: "large", desc: "a large board made by one apply: 30x20 labelled shapes and 600 arrows; then a move of a shape with arrows on it; a picture of all at scale 0.25 and of one region (599 arrows: 580 across, 19 down)",
    steps: [
      { apply: { create: largeCreate(30, 20) } },
      { apply: { update: [{ ref: { key: "n5_5" }, moveBy: [30, 20] }, { ref: { key: "n6_6" }, label: "moved and relabelled" }] } },
    ],
    pictures: [{ name: "all-0.25", ids: () => [], scale: 0.25 }, { name: "region", ids: (els) => els.filter((e) => !e.isDeleted && !e.containerId && e.x >= 400 && e.y >= 400 && e.x + e.width <= 1300 && e.y + e.height <= 1000).map((e) => e.id) }],
  },
];
