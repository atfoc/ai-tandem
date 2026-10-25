// The web build's haptic is nothing: it takes every kind and neither throws nor returns anything.
import assert from "node:assert/strict";
import { test } from "node:test";

import { haptic } from "../src/platform/haptics.web.ts";

test("the web haptic does nothing for every kind", () => {
  for (const kind of ["select", "impact", "warning"] as const) assert.equal(haptic(kind), undefined);
});
