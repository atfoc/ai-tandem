// The Servers dialog's rules that need no screen (S3): the owner's things are offered where the transport is the desktop's or the
// host's and not on a phone's or a tablet's (goal 4.1), the rows a native app lists have no "This computer", a row's tone, the form an
// edit starts from and the patch it sends (the secret only when typed).
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { useTransport, type Transport } from "@aiwb/core/transport/index.ts";
import { LOCAL_ENTRY, type ServerView } from "@aiwb/core/logic/servers.ts";

import { editForm, ownerThings, patchOf, rowsOf, toneOf } from "../src/screens/servers/model.ts";

const way = (w: Transport["way"]): Transport => ({ way: w } as Transport);
afterEach(() => useTransport(null));

const remote: ServerView = { id: "s_a", name: "Studio", address: "https://studio.example:4790", state: "connected" };

test("the owner's things: the desktop's and the host's transports offer them, a phone's does not", () => {
  useTransport(way("ipc"));
  assert.equal(ownerThings(), true);
  useTransport(way("http"));
  assert.equal(ownerThings(), true);
  useTransport(way("native"));
  assert.equal(ownerThings(), false);
});

test("a native app lists the servers of its list alone: no row of this computer", () => {
  const list = [LOCAL_ENTRY, remote];
  assert.deepEqual(rowsOf(list, true).map((v) => v.id), ["local", "s_a"]);
  assert.deepEqual(rowsOf(list, false).map((v) => v.id), ["s_a"]);
});

test("the tone of a state: connected ok, connecting waiting, every other bad", () => {
  assert.equal(toneOf("connected"), "ok");
  assert.equal(toneOf("connecting"), "wait");
  for (const s of ["unreachable", "secret_not_accepted", "certificate_changed", "too_old", "not_started"] as const) assert.equal(toneOf(s), "bad");
});

test("an edit's form starts from the entry with the secret empty, and sends only what changed", () => {
  const was = editForm({ ...remote, selfSigned: true, pin: "AB" });
  assert.deepEqual(was, { id: "s_a", name: "Studio", address: "https://studio.example:4790", secret: "", selfSigned: true, pin: "AB" });
  assert.deepEqual(patchOf(was, was), {});
  assert.deepEqual(patchOf({ ...was, name: "Studio 2" }, was), { name: "Studio 2" });
  assert.deepEqual(patchOf({ ...was, secret: "new" }, was), { secret: "new" });
  assert.deepEqual(patchOf({ ...was, selfSigned: false, pin: "" }, was), { selfSigned: false, pin: "" });
});
