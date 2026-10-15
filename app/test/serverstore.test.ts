import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import {
  CLIENT_ID_KEY, LIST_KEY, PENDING_KEY, SECRET_PREFIX, createServerStore,
  type SecretVault, type StoreKv,
} from "../src/platform/serverstorecore.ts";

// core/list.js is CommonJS without types: the real List checks what the Store returns, as it does in the app.
const { List } = createRequire(import.meta.url)("../../packages/conn/core/list.js") as {
  List: { open(store: unknown, o?: { random?: (a: Uint8Array) => void }): any };
};

// A fake of react-native-mmkv's instance.
function fakeKv() {
  const m = new Map<string, string>();
  const kv: StoreKv = {
    getString: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    remove: (k) => m.delete(k),
    getAllKeys: () => [...m.keys()],
  };
  return { kv, m };
}

// A fake of expo-secure-store; `failDelete` makes the asynchronous delete reject, `failSet` makes a write throw.
function fakeVault() {
  const m = new Map<string, string>();
  const state = { failDelete: false, failSet: false, deleted: [] as string[] };
  const vault: SecretVault = {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => { if (state.failSet) throw new Error("keychain locked"); m.set(k, v); },
    delete: async (k) => {
      if (state.failDelete) throw new Error("keychain locked");
      m.delete(k);
      state.deleted.push(k);
    },
  };
  return { vault, m, state };
}

let uuidCalls = 0;
const uuids = () => `${(++uuidCalls).toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

function setup(now?: () => Date) {
  const k = fakeKv();
  const v = fakeVault();
  const store = createServerStore({ kv: k.kv, vault: v.vault, randomUUID: uuids, now });
  return { ...k, v, store };
}

const SECRET_A = "secret-of-a-1234567890";
const SECRET_B = "secret-of-b-abcdefghij";
const entry = (id: string, secret: string, over: Record<string, unknown> = {}) => ({
  id, name: `Server ${id}`, address: `https://host-${id.slice(-2)}.example.com:4748`, secret, selfSigned: false, pin: "", instanceId: "", ...over,
});
const two = () => ({ version: 1, servers: [entry("s_000000000001", SECRET_A), entry("s_000000000002", SECRET_B)] });
const tick = () => new Promise((r) => setImmediate(r));

test("where is the app's storage", () => {
  assert.equal(setup().store.where, "the app's storage");
});

test("a list round-trips with its secrets, and none was saved reads null", () => {
  const { store } = setup();
  assert.equal(store.read(), null);
  store.write(two());
  assert.deepEqual(store.read(), two());
});

test("no secret is in the key-value storage, every one is in the secure storage under its entry's key", () => {
  const { store, m, v } = setup();
  store.write(two());
  for (const [k, text] of m) {
    assert.ok(!text.includes(SECRET_A) && !text.includes(SECRET_B), `secret in key ${k}`);
  }
  const saved = JSON.parse(m.get(LIST_KEY)!);
  assert.deepEqual(saved.servers.map((e: { secret: string }) => e.secret), ["", ""]);
  assert.equal(saved.version, 1);
  assert.equal(saved.servers[0].address, "https://host-01.example.com:4748");
  assert.equal(v.m.get(`${SECRET_PREFIX}s_000000000001`), SECRET_A);
  assert.equal(v.m.get(`${SECRET_PREFIX}s_000000000002`), SECRET_B);
  assert.equal(SECRET_PREFIX, "aiwb.secret.");
});

test("a changed secret replaces the old one", () => {
  const { store, v } = setup();
  store.write(two());
  const next = two();
  next.servers[0].secret = "another-secret-value";
  store.write(next);
  assert.equal(v.m.get(`${SECRET_PREFIX}s_000000000001`), "another-secret-value");
  assert.equal((store.read()!.servers[0] as { secret: string }).secret, "another-secret-value");
});

test("the List opens over it: the saved entries, checked, with their secrets", () => {
  const { store } = setup();
  store.write(two());
  const list = List.open(store);
  assert.equal(list.notice, "");
  assert.deepEqual(list.all().map((e: { id: string; secret: string }) => [e.id, e.secret]),
    [["s_000000000001", SECRET_A], ["s_000000000002", SECRET_B]]);
});

test("a list made by the List's own add is saved without secrets and read back", () => {
  const { store, m } = setup();
  const list = List.open(store);
  const added = list.add({ name: "Home", address: "https://home.example.com:4748", secret: SECRET_A, selfSigned: false, pin: "" });
  assert.ok(!m.get(LIST_KEY)!.includes(SECRET_A));
  const again = List.open(store);
  assert.equal(again.get(added.id).secret, SECRET_A);
  assert.equal(again.notice, "");
});

test("an entry whose secret is missing sets the list aside with a notice", () => {
  const { store, m, v } = setup(() => new Date(Date.UTC(2026, 9, 14, 8, 5, 3)));
  store.write(two());
  const saved = m.get(LIST_KEY)!;
  v.m.delete(`${SECRET_PREFIX}s_000000000002`);
  const list = List.open(store);
  assert.deepEqual(list.all(), []);
  assert.equal(
    list.notice,
    "server list: the app's storage cannot be read (entry 2: bad secret); set aside as list.unreadable-20261014T080503Z; starting with this computer only",
  );
  assert.ok(!list.notice.includes(SECRET_A));
  assert.equal(m.has(LIST_KEY), false);
  assert.equal(m.get("list.unreadable-20261014T080503Z"), saved);
  assert.equal(store.read(), null);
  // The next write makes a fresh list; the one set aside stays.
  list.add({ name: "Home", address: "https://home.example.com:4748", secret: SECRET_A, selfSigned: false, pin: "" });
  assert.equal(m.get("list.unreadable-20261014T080503Z"), saved);
});

test("an unreadable list is set aside under a name not taken yet, and never deleted", () => {
  const { store, m } = setup(() => new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  m.set(LIST_KEY, "{not json");
  assert.throws(() => store.read());
  const first = store.setAside("x");
  assert.equal(first, "list.unreadable-20260102T030405Z");
  m.set(LIST_KEY, "[1]");
  assert.throws(() => store.read(), /not an object/);
  assert.equal(store.setAside("x"), "list.unreadable-20260102T030405Z-2");
  m.set(LIST_KEY, "7");
  assert.equal(store.setAside("x"), "list.unreadable-20260102T030405Z-3");
  assert.equal(m.get(first), "{not json");
  assert.throws(() => store.setAside("x"), /no saved list/);
});

test("the List sets a list of a later version aside, and one that is not JSON", () => {
  for (const text of [JSON.stringify({ version: 2, servers: [] }), "garbage"]) {
    const { store, m } = setup();
    m.set(LIST_KEY, text);
    const list = List.open(store);
    assert.match(list.notice, /set aside as list\.unreadable-/);
    assert.deepEqual(list.all(), []);
  }
});

test("an empty saved list reads as none", () => {
  const { store, m } = setup();
  m.set(LIST_KEY, "  ");
  assert.equal(store.read(), null);
});

test("a secret saved in the key-value storage by mistake is not trusted: the secure storage decides", () => {
  const { store, m } = setup();
  m.set(LIST_KEY, JSON.stringify({ version: 1, servers: [entry("s_000000000001", "planted-secret")] }));
  const list = List.open(store);
  assert.deepEqual(list.all(), []);
  assert.match(list.notice, /entry 1: bad secret/);
});

test("a removed entry's secret is deleted, the others stay", async () => {
  const { store, v } = setup();
  store.write(two());
  store.write({ version: 1, servers: [two().servers[0]] });
  await tick();
  assert.deepEqual(v.state.deleted, [`${SECRET_PREFIX}s_000000000002`]);
  assert.equal(v.m.has(`${SECRET_PREFIX}s_000000000002`), false);
  assert.equal(v.m.get(`${SECRET_PREFIX}s_000000000001`), SECRET_A);
});

test("the List's remove deletes the secret", async () => {
  const { store, v } = setup();
  store.write(two());
  List.open(store).remove("s_000000000001");
  await tick();
  assert.equal(v.m.has(`${SECRET_PREFIX}s_000000000001`), false);
  assert.equal(v.m.get(`${SECRET_PREFIX}s_000000000002`), SECRET_B);
});

test("a delete that fails is kept as an id and retried at the next read, no secret in it", async () => {
  const { store, m, v } = setup();
  store.write(two());
  v.state.failDelete = true;
  store.write({ version: 1, servers: [two().servers[0]] });
  await tick();
  assert.equal(v.m.has(`${SECRET_PREFIX}s_000000000002`), true);
  assert.deepEqual(JSON.parse(m.get(PENDING_KEY)!), ["s_000000000002"]);
  assert.ok(!m.get(PENDING_KEY)!.includes(SECRET_B));
  v.state.failDelete = false;
  store.read();
  await tick();
  assert.equal(v.m.has(`${SECRET_PREFIX}s_000000000002`), false);
  assert.equal(m.has(PENDING_KEY), false);
});

test("a write whose secret cannot be saved throws and keeps the old list", () => {
  const { store, m, v } = setup();
  store.write({ version: 1, servers: [two().servers[0]] });
  const before = m.get(LIST_KEY);
  v.state.failSet = true;
  assert.throws(() => store.write(two()), /keychain locked/);
  assert.equal(m.get(LIST_KEY), before);
});

test("clientId is made once, as a lower-case UUID v4, and kept", () => {
  const { store, m } = setup();
  const before = uuidCalls;
  const id = store.clientId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(store.clientId(), id);
  assert.equal(uuidCalls, before + 1);
  assert.equal(m.get(CLIENT_ID_KEY), id);
  // A new Store over the same storage (the next run) has the same id.
  const again = createServerStore({ kv: { ...setup().kv, getString: (k) => m.get(k), set: (k, v) => { m.set(k, v); } }, vault: fakeVault().vault, randomUUID: uuids });
  assert.equal(again.clientId(), id);
  assert.equal(uuidCalls, before + 1);
});

test("a client id of a wrong form is made again", () => {
  const { store, m } = setup();
  m.set(CLIENT_ID_KEY, "not-a-uuid");
  const id = store.clientId();
  assert.notEqual(id, "not-a-uuid");
  assert.equal(m.get(CLIENT_ID_KEY), id);
});
