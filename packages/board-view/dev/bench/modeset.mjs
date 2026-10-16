// Which modes a bench run covers, and how long it takes (a dev tool: never in a shipped build, README.md here). Plain JS without
// imports, so the page (bench.ts), the Node scripts (webkit.mjs, device.mjs) and the tests all read the same lists.
//
// A mode is an entry of modes.ts. The names are fixed here by rule:
//   <theme>         the theme message the app sends for that canvas theme -> the page's NEW phone filter (phonetheme.ts)
//   <theme>-today   the same theme as the phone page drew it before the replacement: the SVG url(#id) filter, no blend layers
//   light, dark-css, dark-none, dark-matrix   the experiment's (experiment.md)
// A SET is a name for a list of modes:
//   experiment    light, dark-today, dark-css, dark-none, dark-matrix: what experiment.md's criterion reads (its `dark` is `dark-today`)
//   replacement   light, the five <theme>, the five <theme>-today
//   all           both, each mode once

/** The canvas themes of @aiwb/core `CANVAS_THEMES` (a test holds this list to it). */
export const THEMES = ["dark", "latte", "frappe", "macchiato", "mocha"];

const experiment = ["light", "dark-today", "dark-css", "dark-none", "dark-matrix"];
const replacement = ["light", ...THEMES, ...THEMES.map((t) => `${t}-today`)];

export const MODE_SETS = {
  experiment,
  replacement,
  all: [...new Set([...replacement, ...experiment])],
};

/** Every mode there is (the sets are made of these). */
export const MODE_NAMES = MODE_SETS.all;

/** What a run measures when it is not told (device.mjs, the page's build): the biggest set. */
export const DEFAULT_MODES = "all";

/** A list of mode names and set names -> the mode names, each once, in the order first met (a set stands for its modes). */
export function expandModes(names) {
  return [...new Set(names.flatMap((n) => MODE_SETS[n] ?? [n]))];
}

/** The same from text: "replacement", "light,dark-today", "replacement,dark-css". */
export const parseModes = (text) => expandModes(text.split(",").map((s) => s.trim()).filter(Boolean));

// ---- how long a run takes (the page's timings, bench.ts uses these)

export const SETTLE_MS = 1000;         // after the fonts: the first frames of a new board are not measured
export const SETTLE_IMAGES_MS = 1500;  // more for the board with pictures: they are decoded when first drawn
export const PAUSE_MS = 500;           // between the pan and the pinch
export const IDLE_MS = 1500;           // the frames of an idle page, for `idleMs`

/** Time to load one board in a page, besides the settling: a guess from the runs so far (a Mac's WebKit and the simulator: about
 *  0.5 s). A physical phone is slower and has not been measured, so it is taken generously. */
export const LOAD_MS = { desktop: 500, simulator: 500, device: 4000 };

/** The expected duration of a run in ms: the idle frames, then per repetition, board and mode one load and its gestures. */
export function estimateMs({ reps = 3, gestureMs = 4000, boards = ["large", "images"], modes, gestures = ["pan", "pinch"], loadMs = LOAD_MS.device }) {
  let ms = IDLE_MS;
  for (const board of boards) {
    const perMode = loadMs + (board === "images" ? SETTLE_IMAGES_MS : SETTLE_MS) + gestures.length * gestureMs + (gestures.length - 1) * PAUSE_MS;
    ms += reps * modes.length * perMode;
  }
  return ms;
}

/** "14 min", "52 s". */
export const formatDuration = (ms) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);
