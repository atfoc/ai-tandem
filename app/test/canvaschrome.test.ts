// The chrome of the board in a flavour is the old page's: the colours that its flavours-canvas.css gave Excalidraw's toolbar,
// panels, menus and dialogs, from the tokens and the palette of each flavour, are what the `theme` message carries (core's
// logic/canvaschrome.ts, validated by the bridge's list). test/fixtures/canvaschrome.json holds them, written from that
// stylesheet by the sweep while it existed (with the board view's own `--aiwb-line` and `--aiwb-faint`, the old rules'
// `--line` and `--faint`); the chrome the app sends is held to it. A change of a colour changes the fixture on purpose.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHROME_VARS } from "@aiwb/board-bridge/chrome.ts";
import { chromeOf } from "@aiwb/core/logic/canvaschrome.ts";
import { FLAVOURS, type Flavour } from "@aiwb/core/logic/theme.ts";

const fixtureFile = fileURLToPath(new URL("./fixtures/canvaschrome.json", import.meta.url));

type Vars = Record<string, string>;

const fixture = (): Record<Flavour, Vars> => JSON.parse(readFileSync(fixtureFile, "utf8"));

for (const f of FLAVOURS) {
  test(`the chrome of ${f} is the fixture's`, () => {
    assert.deepEqual(chromeOf(f), fixture()[f]);
  });
}

test("the fixture sets exactly the properties the bridge's list names, in every flavour", () => {
  for (const f of FLAVOURS) assert.deepEqual(Object.keys(fixture()[f]).sort(), [...CHROME_VARS].sort(), f);
});
