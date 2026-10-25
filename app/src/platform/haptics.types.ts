// A haptic (ux-improvements goal 3.3: a long press on a row answers with one). Contract of package F1 (plans/ux-improvements/PLAN.md).
// haptics.native.ts and haptics.web.ts each export `haptic` with this signature; a caller imports "../platform/haptics" and the build
// picks the file (tsconfig `moduleSuffixes`, as for the kv port). `select` is a tick, `impact` a light tap, `warning` the double knock.
export type Haptic = "select" | "impact" | "warning";
