import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerFor, runningChats, restartConfirmText } from "../src/logic/version.ts";
import type { Status } from "../src/types.ts";

test("bannerFor: all equal → none", () => {
  assert.equal(bannerFor("v1", "v1", "v1"), "none");
});

test("bannerFor: any of the three dev → none", () => {
  assert.equal(bannerFor("dev", "v1", "v2"), "none");
  assert.equal(bannerFor("v1", "dev", "v2"), "none");
  assert.equal(bannerFor("v1", "v2", "dev"), "none");
  assert.equal(bannerFor("dev", "dev", "dev"), "none");
});

test("bannerFor: page = disk ≠ server → restart", () => {
  assert.equal(bannerFor("v2", "v1", "v2"), "restart");
});

test("bannerFor: page ≠ disk → reload", () => {
  assert.equal(bannerFor("v1", "v2", "v2"), "reload"); // page ≠ disk = server: the server was replaced
  assert.equal(bannerFor("v1", "v1", "v2"), "reload"); // page = server ≠ disk
  assert.equal(bannerFor("v1", "v2", "v3"), "reload"); // all different
});

test("runningChats counts thinking, writing, tool and approval", () => {
  const chats: { status: Status }[] = [
    { status: "ready" }, { status: "thinking" }, { status: "stopped" }, { status: "tool" }, { status: "error" },
  ];
  assert.equal(runningChats(chats), 2);
  assert.equal(restartConfirmText(runningChats(chats)), "Restart ends 2 running agent chats.");
  assert.equal(runningChats([{ status: "writing" }, { status: "approval" }, { status: "ready" }]), 2);
  assert.equal(runningChats([{ status: "ready" }, { status: "stopped" }, { status: "error" }]), 0);
  assert.equal(runningChats([]), 0);
});

test("restartConfirmText", () => {
  assert.equal(restartConfirmText(2), "Restart ends 2 running agent chats.");
  assert.equal(restartConfirmText(1), "Restart ends 1 running agent chat.");
});
