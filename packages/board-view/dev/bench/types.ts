// Types of stats.mjs (plain JS that the Node scripts import too, so it has no declaration file) and of the result it describes.
export type FrameStats = { frames: number; durationMs: number; fps: number; meanMs: number; medianMs: number; p95Ms: number; maxMs: number; jankyPct: number };
export type Spread = { mean: number; min: number; max: number };
export type SummaryLine = { board: string; mode: string; gesture: string; reps: number; fps: Spread; p95Ms: Spread; jankyPct: Spread };
export type BenchRun = FrameStats & {
  board: string; mode: string; gesture: string; rep: number; filter: string;
  /** The replacement's blend layers (`.aiwb-canvas-layer`) at the start of the gesture: in the page, and drawn (not `display: none`). */
  blendLayers: { present: number; visible: number };
  moved: boolean; intervals: number[];
  /** Only on a run that did not take place (the board did not load, a canvas was missing): why. */
  failed?: string;
};
export type BenchResult = {
  kind: "aiwb-board-bench"; version: 1; startedAt: string; endedAt: string;
  env: { userAgent: string; dpr: number; width: number; height: number; isolated: boolean };
  config: { reps: number; gestureMs: number; boards: string[]; modes: string[]; gestures: string[] };
  idleMs: number; runs: BenchRun[]; summary: SummaryLine[];
};
export type Stats = {
  median(xs: number[]): number;
  frameStats(intervals: number[], nominalMs: number): FrameStats;
  summarize(runs: Pick<BenchRun, "board" | "mode" | "gesture" | "fps" | "p95Ms" | "jankyPct">[]): SummaryLine[];
  formatSummary(result: Partial<BenchResult>, title?: string): string;
};
export type ModeSet = {
  THEMES: string[];
  MODE_SETS: Record<"experiment" | "replacement" | "all", string[]>;
  expandModes(names: string[]): string[];
  parseModes(text: string): string[];
  SETTLE_MS: number; SETTLE_IMAGES_MS: number; PAUSE_MS: number; IDLE_MS: number;
  LOAD_MS: { desktop: number; simulator: number; device: number };
  estimateMs(o: { reps?: number; gestureMs?: number; boards?: string[]; modes: string[]; gestures?: string[]; loadMs?: number }): number;
  formatDuration(ms: number): string;
};
