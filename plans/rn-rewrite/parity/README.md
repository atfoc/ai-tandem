# The parity report's tables, one file per area of the inventory

`plans/rn-rewrite/parity-report.md` (written by the sweep) sums these up. Each file `a.md`, `b.md`, `c.md`, `d.md` is
written by one package of the sweep and has, for **every row** of its area of `parity-inventory.md`, in the inventory's
order and under its sub-headings (`### A.1 …`):

| ID | On the new build | Shown by | Why not / note |
|---|---|---|---|

- **On the new build**: `yes` (true and shown), `yes, unshown` (true by the code, and nothing automated shows it: say
  what a test would need), `partly` (say which part), `no` (say why), `n/a` (the row cannot apply, by a decision).
- **Shown by**: each proof, in the cheapest place it is: a check of `web/dev/checks-app/` as `ID@viewports`
  (`SEC.2@d,t,p`; `d` desktop, `t` tablet, `p` phone) — the check's own `viewports` line, and the failure line or
  section that proves the row when the check proves several; a unit test as `<package>/test/<file> "its name"`
  (`app/test`, `packages/core/test`, `packages/conn/test`, `desktop/test`); a free e2e as `e2e/<name>[APP] step "…"`;
  the desktop app's e2e as `desktop/e2e[web build]`; a device flow as `maestro/<flow>.yaml` (iOS, Android) or
  `xcuitest/<…>`; by hand as `hand (goal 7.5)`. A row whose old proof was a check proves on the new build at least at the
  viewports its "Note for the app" names (`all` = d,t,p; `wide only` = d,t; `desktop only` = the Electron window).
- **Why not / note**: for `no` and `n/a` the reason, one of: *device-only* (a browser cannot show it; name the flow or
  "hand"), *deliberate* (a recorded difference: name the AD-… of `architecture.md` or the goal's section), *out of scope*
  (goal 4.1/4.3/10: this computer on a phone or tablet, the owner's things, a browser tab), *lost* (a behaviour of the
  desktop page the new build does not have: the sweep must fix it — list these also at the end of the file), *pending*
  (a flag of a check the sweep is turning on: name the check and the flag).
- After the table of each area: the counts per value, and the list of `lost` and `yes, unshown` rows.

How to find the proof: the inventory's "Covered today by" (an old check `X` → its port `web/dev/checks-app/X-*.mjs`;
read it to see that the assertion is there, not only the ID), the new checks `L*` (their first comments name the rows
they prove: `grep -n "<row ID>" web/dev/checks-app/*.mjs`), the package notes `plans/rn-rewrite/*.md` (they list their
rows and deviations), the unit tests' names, the device flows `app/e2e/maestro/*.yaml` and their notes (`v1`…`v3`
files), `web/e2e/lib/ui.mjs` for the e2e scripts on the new build. Do not run checks; this is reading. When a flag at
the top of a check (`const X = false`) gates the part that proves the row, the row is `pending` with that flag.
