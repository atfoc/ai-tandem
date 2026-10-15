// The chrome of the board in a flavour (logic/canvaschrome.ts): the map the `theme` message carries is the bridge's
// list of custom properties, each a colour of the flavour, and what the bridge's validator accepts. (That it is what
// the old page's flavours-canvas.css sets is app/test/canvaschrome.test.ts's.)
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHROME_VARS } from "@aiwb/board-bridge/chrome.ts";
import { validateToBoard } from "@aiwb/board-bridge/validate.ts";
import { chromeOf } from "../src/logic/canvaschrome.ts";
import { PALETTE, flavourTokens } from "../src/logic/flavours.ts";
import { FLAVOURS } from "../src/logic/theme.ts";

test("every flavour has a colour for every property of the bridge's list, and the bridge accepts the map", () => {
  for (const f of FLAVOURS) {
    const chrome = chromeOf(f);
    assert.deepEqual(Object.keys(chrome).sort(), [...CHROME_VARS].sort(), f);
    const r = validateToBoard({ t: "theme", theme: { mode: f === "latte" ? "light" : "dark", filter: null, chrome } });
    assert.ok(r.ok, `${f}: ${r.ok ? "" : r.error}`);
    assert.equal(chromeOf(f), chrome, "the same map each time");
  }
});

test("the chrome is on the flavour's Base with its Text, its accent for the chosen, and the greys of the theme it sits on", () => {
  for (const f of FLAVOURS) {
    const c = chromeOf(f), p = PALETTE[f], t = Object.fromEntries(flavourTokens(f).map((x) => [x.name, x.value]));
    assert.equal(c["--island-bg-color"], p.base);
    assert.equal(c["--popup-text-color"], p.text);
    assert.equal(c["--color-primary"], t["--accent"]);
    assert.equal(c["--color-danger-dark"], t["--danger-fill"]);
    assert.equal(c["--aiwb-line"], p.surface0);
    // light (Latte): gray-10 is Base and gray-100 Text; dark: the other way round
    const light = f === "latte";
    assert.equal(c["--color-gray-10"], light ? p.base : p.text, `${f} gray-10`);
    assert.equal(c["--color-gray-100"], light ? p.text : p.crust, `${f} gray-100`);
  }
  assert.notEqual(chromeOf("latte")["--island-bg-color"], chromeOf("mocha")["--island-bg-color"]);
});
