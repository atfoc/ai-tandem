// The part of web/test/sectioncalls.test.ts that needs nothing of the old page: the change shown ahead of a section's server and
// put back, and the code that says a chat is gone. The rest of that file (the sidebar's and the chat view's calls) stays there until
// the old page is retired (plans/rn-rewrite/parity/webtest.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { putBack, shownAhead } from "../src/logic/sections.ts";
import { goneBySend } from "../src/logic/sendend.ts";
import type { Group } from "../src/types.ts";

test("shownAhead and putBack: what a section's server told last is put back, unless it told its groups since", () => {
  const told: Group[] = [{ id: "g_1", name: "Work" }];
  const rename = (name: string) => (gs: Group[]) => gs.map((g) => ({ ...g, name }));
  const one = shownAhead(told, undefined, rename("A"));
  assert.deepEqual([one.shown[0].name, one.truth], ["A", told]);
  assert.equal(putBack(one.shown, one), told, "refused: the list of before");
  assert.equal(putBack([...one.shown], one), null, "another list is in the store: the server's word since");
  assert.equal(putBack(undefined, one), null, "the section has no tree any more");
  assert.equal(putBack(one.shown, undefined), null);
  // a second change on top of the first, which is still shown: the truth is the first one's, not the name shown ahead
  const two = shownAhead(one.shown, one, rename("B"));
  assert.deepEqual([two.shown[0].name, two.truth], ["B", told]);
  assert.equal(putBack(two.shown, two), told);
  // a change after the server told its groups starts from what it told
  const news: Group[] = [{ id: "g_1", name: "Theirs" }];
  assert.equal(shownAhead(news, two, rename("C")).truth, news);
});

test("a Send to a section's chat that is answered 404 not_found says that the chat is no longer on that server", () => {
  assert.equal(goneBySend("not_found"), true);
  for (const code of [undefined, "no_branch", "no_server", "server_unreachable", "send_unknown", "no_answer", "bad_answer", "busy"]) assert.equal(goneBySend(code), false, String(code));
});
