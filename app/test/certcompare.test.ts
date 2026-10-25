// The certificate screen's decisions (S2-8, goal 3.8.4): a scanned code's fingerprint against the presented one, and the pairs the command prints.
import assert from "node:assert/strict";
import { test } from "node:test";

import { firstPairs, samePrinted } from "../src/screens/servers/cert/compare.ts";

const NOW = "8B:47:1E:C2:F9:03:6A:5D:D2:7B:40:E8:9C:16:B3:FA:05:D9:7E:21:C8:4A:6F:3B:1A:70:E5:C6:29:DF:4B:88";
const OLD = "5E:21:A0:C9:7B:44:D1:F8:0C:3A:92:E6:4F:17:B8:5D:2A:60:E9:C3:71:BD:08:F4:C6:A2:3D:95:F1:4E:8B:07";

test("samePrinted: the same fingerprint however written, never an unreadable one", () => {
  assert.equal(samePrinted(NOW, NOW), true);
  assert.equal(samePrinted(NOW, NOW.toLowerCase()), true);
  assert.equal(samePrinted(NOW, NOW.replaceAll(":", "")), true);
  assert.equal(samePrinted(NOW, OLD), false);
  assert.equal(samePrinted(NOW, undefined), false);
  assert.equal(samePrinted("zz", "zz"), false);
  assert.equal(samePrinted(undefined, undefined), false);
});

test("firstPairs: four pairs and a colon, as the command prints them", () => {
  assert.equal(firstPairs(NOW), "8B:47:1E:C2:");
  assert.equal(firstPairs("nope"), "");
});
