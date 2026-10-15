import assert from "node:assert/strict";
import { test } from "node:test";

import { isTopOverlay, overlaysOpen, pushOverlay } from "../src/ui/overlaystack.ts";

test("only the overlay opened last is on top; taking it away gives the top to the one under it", () => {
  const menu = pushOverlay(), confirm = pushOverlay();
  assert.equal(overlaysOpen(), 2);
  assert.equal(isTopOverlay(menu.token), false);
  assert.equal(isTopOverlay(confirm.token), true);
  confirm.remove();
  assert.equal(isTopOverlay(menu.token), true);
  menu.remove();
  assert.equal(overlaysOpen(), 0);
});

test("an overlay under another that closes first leaves the other on top; removing twice does nothing", () => {
  const a = pushOverlay(), b = pushOverlay();
  a.remove();
  a.remove();
  assert.equal(overlaysOpen(), 1);
  assert.equal(isTopOverlay(b.token), true);
  b.remove();
  assert.equal(isTopOverlay(b.token), false);
});
