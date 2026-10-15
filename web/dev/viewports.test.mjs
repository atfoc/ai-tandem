import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutOf } from "../../app/src/ui/breakpoints.ts";
import { VIEWPORTS, checkViewports, contextOptions, isTouch, layoutOfViewport, layoutOfWidth, viewportNames } from "./viewports.mjs";

test("each viewport gets the layout of its own name, from the app's breakpoints", () => {
  for (const name of viewportNames) assert.equal(layoutOf(VIEWPORTS[name].width), layoutOfViewport(name), name);
});

test("the widths of the layout bands are the app's", () => {
  for (let w = 300; w <= 1600; w += 1) assert.equal(layoutOfWidth(w), layoutOf(w), `${w}`);
});

test("touch is the tablet's and the phone's", () => {
  assert.deepEqual(viewportNames.filter(isTouch), ["tablet", "phone"]);
});

test("the options of a context: the device's, with the window of AD-80", () => {
  const playwright = { devices: { "iPad Pro 11": { userAgent: "ipad", viewport: { width: 834, height: 1194 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, defaultBrowserType: "webkit" },
    "iPhone 15": { userAgent: "iphone", viewport: { width: 393, height: 659 }, screen: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, defaultBrowserType: "webkit" } } };
  assert.deepEqual(contextOptions(playwright, "desktop"), { viewport: { width: 1280, height: 800 } });
  const phone = contextOptions(playwright, "phone");
  assert.deepEqual(phone.viewport, { width: 393, height: 852 });
  assert.equal(phone.hasTouch, true);
  assert.equal(phone.deviceScaleFactor, 3);
  assert.equal("defaultBrowserType" in phone, false);
  assert.deepEqual(contextOptions(playwright, "tablet", { size: [900, 700], scheme: "dark" }).viewport, { width: 900, height: 700 });
  assert.equal(contextOptions(playwright, "tablet", { scheme: "dark" }).colorScheme, "dark");
  assert.throws(() => contextOptions(playwright, "watch"), /no viewport "watch"/);
});

test("the list a check gives is checked", () => {
  assert.deepEqual(checkViewports(["desktop", "phone"]), ["desktop", "phone"]);
  assert.throws(() => checkViewports([]), /must be a list/);
  assert.throws(() => checkViewports(["desktop", "tv"]), /no viewport "tv"/);
});
