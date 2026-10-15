import assert from "node:assert/strict";
import { test } from "node:test";

import { appName } from "../src/appname.ts";

test("the app module loads", () => {
  assert.equal(appName, "AI Whiteboard");
});
