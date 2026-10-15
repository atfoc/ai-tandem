// What the checks of both platforms share: the message the page's refs.ts makes for a content, and a tally.
import { serialize } from "../../../web/src/logic/refs.ts";
import { POINT, SELECTIONS } from "../src/fixtures.ts";

export const sel = (i) => SELECTIONS[i]();
export const pt = () => POINT();
/** The message of a content, as the page produces it: its text and its references in order. */
export const message = (...segs) => serialize(segs);

export function tally(name) {
  const results = [];
  return {
    ok(cond, what, detail = "") { results.push({ cond: !!cond, what }); console.log(`${cond ? "PASS" : "FAIL"} ${name}: ${what}${cond ? "" : detail ? `\n     ${detail}` : ""}`); },
    eq(actual, expected, what) { this.ok(actual === expected, what, `expected ${JSON.stringify(expected)}\n     actual   ${JSON.stringify(actual)}`); },
    done() { const bad = results.filter((r) => !r.cond).length; console.log(`${name}: ${results.length - bad}/${results.length} passed`); return bad === 0; },
  };
}
