// The words of the phone's Quote sheet and Select text (screens/quotes/quotewords.ts).
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pickBlocked, pickButtons, quoteTitle } from "../src/screens/quotes/quotewords.ts";

describe("quoteTitle", () => {
  it("names the agent by its short name", () => {
    assert.equal(quoteTitle("quote", false, "claude"), "Quote from Claude's reply");
    assert.equal(quoteTitle("quote", false, "cursor"), "Quote from Cursor's reply");
    assert.equal(quoteTitle("quote", false, "pi"), "Quote from Pi's reply");
  });
  it("says 'your message' for the person's own and 'Select text' in select mode", () => {
    assert.equal(quoteTitle("quote", true, "claude"), "Quote from your message");
    assert.equal(quoteTitle("select", false, "claude"), "Select text");
    assert.equal(quoteTitle("select", true), "Select text");
  });
});

describe("pickButtons / pickBlocked", () => {
  it("has the quote buttons in quote mode and the copy buttons in select mode", () => {
    assert.deepEqual(pickButtons("quote"), { selection: "Quote selection", whole: "Whole message" });
    assert.deepEqual(pickButtons("select"), { selection: "Copy selection", whole: "Copy all" });
  });
  it("lets Select text work whatever blocks a quote", () => {
    assert.equal(pickBlocked("quote", "Archived — unarchive to continue"), true);
    assert.equal(pickBlocked("select", "Archived — unarchive to continue"), false);
    assert.equal(pickBlocked("quote", ""), false);
  });
});
