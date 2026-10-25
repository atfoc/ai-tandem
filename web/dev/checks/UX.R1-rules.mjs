// UX.R1 (ux-improvements package R1; goal 6.2, 4.7; PLAN §3 "R1"): the rules of goal 3.1 on every phone screen of goal 6.1, in the light and the
// dark theme, as one check that cannot drift. The walker and its rules are in rules.mjs (its header lists them); the screens are the recipes of
// rules/*.mjs, each reached through the real navigation (Home's rows, the gear, the sheets, the Chats button) from a seed of the mock. A failure
// names the theme, the recipe and its step, the rule and the control ("light home.four/list: target: server-chip[server=h1_attic] "Attic" in
// server-chips — 40 × 36 pt, not 44 × 44"). A recipe that cannot run yet says why and is listed as skipped (V1's blocked states and voice
// until V1 is merged), never as passed. A screenshot of each step and theme, and report.json (the screens read, the failures, the skipped),
// are written to $R1_OUT (default `<tmp>/ux-r1-rules`).
//
// Run: `cd web && VIEWPORT=phone npm run uicheck -- UX.R1` (DIST=… as README.md says). By hand, a group or one theme: R1_GROUP=home,settings
// R1_THEME=dark VIEWPORT=phone node dev/checks/UX.R1-rules.mjs. Phone only: the wide layouts keep their sizes (goal 4.2).
export const limit = 1800; // (seconds: dev/uicheck.mjs gives this check this long; every screen in two themes)
import os from "node:os";
import path from "node:path";
import { check } from "../shot.mjs";
import { loadRecipes, runRecipes } from "./rules.mjs";

export const viewports = ["phone"];
const OUT = process.env.R1_OUT || path.join(os.tmpdir(), "ux-r1-rules");

await check("UX.R1 the rules of every phone screen: targets, text, words, sheets, state words, Auto-send, the canvas (light and dark)", async (c) => {
  const recipes = await loadRecipes();
  const r = await runRecipes(c, recipes, { out: OUT });
  const ids = new Set(r.screens.map((s) => s.id));
  c.note(`${r.screens.length} screens read (${ids.size} recipes), ${r.failures.length} failures, ${r.skipped.length} skipped; report ${path.join(OUT, "report.json")}`);
  if (!r.screens.length && !r.skipped.length) c.fail("no recipe ran (R1_GROUP names none?)");
}, { viewports, page: false });
