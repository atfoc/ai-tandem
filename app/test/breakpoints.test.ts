import assert from "node:assert/strict";
import { test } from "node:test";

import { DESKTOP_FROM, layoutOf, TABLET_FROM } from "../src/ui/breakpoints.ts";

test("layoutOf: under 700 is the phone, 700 to 1099 the tablet, 1100 and over the desktop (AD-72)", () => {
  assert.equal(TABLET_FROM, 700);
  assert.equal(DESKTOP_FROM, 1100);
  const cases: [number, string][] = [
    [0, "phone"], [320, "phone"], [393, "phone"], [699, "phone"], [699.9, "phone"],
    [700, "tablet"], [834, "tablet"], [1099, "tablet"], [1099.5, "tablet"],
    [1100, "desktop"], [1280, "desktop"], [3840, "desktop"],
  ];
  for (const [width, layout] of cases) assert.equal(layoutOf(width), layout, `${width} wide`);
});

test("layoutOf: the devices of the browser checks are the layouts they stand for (AD-80)", () => {
  assert.equal(layoutOf(1280), "desktop"); // desktop 1280×800
  assert.equal(layoutOf(834), "tablet"); // iPad Pro 11
  assert.equal(layoutOf(393), "phone"); // iPhone 15
});
