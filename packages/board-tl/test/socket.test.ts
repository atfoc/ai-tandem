// TransportSocket over a fake TlLink: the status mapping, the JSON round trip, restart, and that closing it leaves the link open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { TransportSocket, socketStatusOf } from "../src/view/socket.ts";
import { FakeLink } from "./fakelink.ts";

test("link status → socket status", () => {
  assert.equal(socketStatusOf("connecting"), "offline");
  assert.equal(socketStatusOf("online"), "online");
  assert.equal(socketStatusOf("offline"), "offline");
  assert.equal(socketStatusOf("offline", "host_stopped"), "offline");
  assert.equal(socketStatusOf("offline", "INVALID_RECORD"), "error");
  assert.equal(socketStatusOf("connecting", "INVALID_RECORD"), "offline");
});

test("status listeners hear changes only, in order; error carries the reason", () => {
  const link = new FakeLink();
  const s = new TransportSocket(link);
  assert.equal(s.connectionStatus, "offline");
  const seen: unknown[] = [];
  s.onStatusChange((e) => seen.push(e));
  link.setStatus("connecting"); // offline → offline: nothing
  link.setStatus("online");
  link.setStatus("online");
  link.setStatus("offline", "closed");
  link.setStatus("connecting");
  link.setStatus("online");
  link.setStatus("offline", "CLIENT_TOO_OLD");
  assert.deepEqual(seen, [{ status: "online" }, { status: "offline" }, { status: "online" }, { status: "error", reason: "CLIENT_TOO_OLD" }]);
  assert.equal(s.connectionStatus, "error");
  assert.equal(s.lastError, "CLIENT_TOO_OLD");
});

test("a socket made on an online link starts online", () => {
  const link = new FakeLink();
  link.status = "online";
  assert.equal(new TransportSocket(link).connectionStatus, "online");
});

test("JSON both ways; nothing sent while not online; bad JSON dropped", () => {
  const link = new FakeLink();
  const s = new TransportSocket(link);
  s.sendMessage({ type: "ping" });
  assert.equal(link.sent.length, 0);
  link.setStatus("online");
  const connect = { type: "connect", connectRequestId: "x", lastServerClock: 0, protocolVersion: 8, schema: { a: [1, "é"] } };
  s.sendMessage(connect);
  assert.equal(link.sent.length, 1);
  assert.equal(link.sent[0].length, 1);
  assert.deepEqual(JSON.parse(link.sent[0][0]), connect);
  const got: unknown[] = [];
  s.onReceiveMessage((m) => got.push(m));
  const warn = console.warn;
  console.warn = () => {};
  try {
    link.deliver([JSON.stringify({ type: "pong" }), "{not json", JSON.stringify({ type: "data", data: [] })]);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(got, [{ type: "pong" }, { type: "data", data: [] }]);
});

test("restart → link.restart; close stops listening and never closes the link", () => {
  const link = new FakeLink();
  let closed = 0;
  link.close = () => void closed++;
  const s = new TransportSocket(link);
  const unsub = s.onReceiveMessage(() => {});
  unsub();
  s.restart();
  assert.equal(link.restarts, 1);
  assert.equal(link.listeners, 2);
  s.close();
  assert.equal(link.listeners, 0);
  assert.equal(closed, 0);
  s.restart();
  assert.equal(link.restarts, 1);
  link.setStatus("online");
  s.sendMessage({ type: "ping" });
  assert.deepEqual(link.sent, []);
});
