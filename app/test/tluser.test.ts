// The generated name of the person on a new board (D12, screens/board/tluser.ts).
import assert from "node:assert/strict";
import { test } from "node:test";

import { ADJECTIVES, ANIMALS, TL_USER_KEY, USER_COLORS, makeTlUser, parseTlUser, tlUser, type TlUserStore } from "../src/screens/board/tluser.ts";

const memKv = (init: Record<string, string> = {}): TlUserStore & { map: Map<string, string> } => {
  const map = new Map(Object.entries(init));
  return { map, get: (k) => map.get(k) ?? null, set: (k, v) => { map.set(k, v); } };
};

test("a made person is an adjective and an animal, a colour of the palette, and a user id", () => {
  for (let i = 0; i < 50; i++) {
    const u = makeTlUser();
    const [adj, animal, ...rest] = u.name.split(" ");
    assert.equal(rest.length, 0);
    assert.ok((ADJECTIVES as readonly string[]).includes(adj), u.name);
    assert.ok((ANIMALS as readonly string[]).includes(animal), u.name);
    assert.ok((USER_COLORS as readonly string[]).includes(u.color), u.color);
    assert.match(u.id, /^user:[a-z0-9]{12}$/);
  }
});

test("the random source decides, the edges included", () => {
  assert.deepEqual(makeTlUser(() => 0), { id: "user:aaaaaaaaaaaa", name: `${ADJECTIVES[0]} ${ANIMALS[0]}`, color: USER_COLORS[0] });
  const last = makeTlUser(() => 0.999999);
  assert.equal(last.name, `${ADJECTIVES.at(-1)} ${ANIMALS.at(-1)}`);
  assert.equal(last.color, USER_COLORS.at(-1));
});

test("the first call makes and keeps the person; later calls give the same one", () => {
  const kv = memKv();
  const a = tlUser(kv);
  assert.deepEqual(JSON.parse(kv.map.get(TL_USER_KEY)!), a);
  assert.deepEqual(tlUser(kv), a);
});

test("a kept value that is broken or incomplete is made again", () => {
  for (const bad of ["{", "null", "[]", JSON.stringify({ id: "user:x", name: "" , color: "#fff" }), JSON.stringify({ name: "A B", color: "#fff" })]) {
    assert.equal(parseTlUser(bad), null, bad);
    const kv = memKv({ [TL_USER_KEY]: bad });
    const u = tlUser(kv, () => 0);
    assert.equal(u.name, `${ADJECTIVES[0]} ${ANIMALS[0]}`);
    assert.deepEqual(parseTlUser(kv.map.get(TL_USER_KEY)!), u);
  }
});

test("a storage that refuses still gives a person (for this run)", () => {
  const kv: TlUserStore = { get: () => null, set: () => { throw new Error("full"); } };
  assert.ok(tlUser(kv).name);
});
