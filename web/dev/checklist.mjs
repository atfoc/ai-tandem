// Which check files a run of dev/uicheck.mjs takes: the files of dev/checks, narrowed by the words on the command line. Apart from uicheck.mjs so that a test can load it.
import fs from "node:fs";

/** Whether the word `w` names the check file `f`: a word is the check's id (the file's name up to the dash: P0.1 is the file
 *  P0.1-…, not P0.10-…), or the id of an item or a phase whose checks' ids go on with a dot (A2: A2.1-…, A2.2-…). */
export const named = (f, w) => { const id = f.replace(/\.mjs$/, "").split("-")[0]; return id === w || id.startsWith(w + "."); };

/** The check files of `dir` that the words name (all of them with no word), in the order of their ids (L2 before L10). Files
 *  that are not checks (`sel.mjs`, `README.md`) are not taken: a check's name has a dash. */
export function checkFiles(dir, want = []) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && f.includes("-") && (!want.length || want.some((w) => named(f, w))))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
