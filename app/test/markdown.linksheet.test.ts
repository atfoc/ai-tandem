// The link sheet's store: what a hold opens, what closes it, and the words that title it.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Inline } from "../src/screens/markdown/doc.ts";
import { closeLinkSheet, getLinkSheet, guardLift, liftGuarded, linkText, openLinkSheet, subscribeLinkSheet } from "../src/screens/markdown/linksheet.ts";

test("a hold opens the sheet for the link, and closing clears it, telling the listener each time", () => {
  let calls = 0;
  const off = subscribeLinkSheet(() => { calls++; });
  openLinkSheet({ text: " the Stripe docs ", href: "https://stripe.com/docs" });
  assert.deepEqual(getLinkSheet(), { text: "the Stripe docs", href: "https://stripe.com/docs" });
  closeLinkSheet();
  assert.equal(getLinkSheet(), null);
  closeLinkSheet(); // (nothing open: nothing to tell)
  assert.equal(calls, 2);
  off();
  openLinkSheet({ text: "x", href: "y" });
  assert.equal(calls, 2);
  closeLinkSheet();
});

test("a link with no words is titled with its address", () => {
  openLinkSheet({ text: "  ", href: "https://example.com/a" });
  assert.equal(getLinkSheet()?.text, "https://example.com/a");
  closeLinkSheet();
});

test("the words of a link are its text, nested emphasis and code included", () => {
  const kids: Inline[] = [
    { k: "text", v: "the  " },
    { k: "strong", kids: [{ k: "text", v: "Stripe" }] },
    { k: "text", v: " " },
    { k: "code", v: "docs()" },
  ];
  assert.equal(linkText(kids), "the Stripe docs()");
});

test("the lift of a hold is guarded for a moment, and no longer", async () => {
  assert.equal(liftGuarded(), false);
  guardLift(30);
  assert.equal(liftGuarded(), true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(liftGuarded(), false);
});
