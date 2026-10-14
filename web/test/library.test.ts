// The prompt library's wire shapes and list (src/logic/library.ts) and its routes
// (src/libraryapi.ts through a fake transport): the server, method, path and body of each call, what
// a refusal becomes, and how a snapshot and the own_library events make the list of libraries.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../src/api.ts";
import { libraryApi } from "../src/libraryapi.ts";
import { installFake, ok, refuse } from "./fixtures/faketransport.ts";
import { LIBRARY_LIMITS, insertItem, libraryAway, libraryOf, removeLibrary, upsertLibrary, type LibraryCode, type LibraryView } from "../src/logic/library.ts";

const fake = installFake();
let answer: unknown = {};
let status = 200;
fake.handler = () => (status === 200 ? ok(answer) : refuse(status, answer as Record<string, unknown>));
beforeEach(() => { fake.reset(); answer = {}; status = 200; });
const calls = fake.calls;
const one = () => { assert.equal(calls.length, 1); return [calls[0].server, calls[0].method, calls[0].path, calls[0].body]; };

const lib = (server: string, o: Partial<LibraryView> = {}): LibraryView => ({ server, name: server === "local" ? "This computer" : "Studio", connected: true, groups: [], prompts: [], ...o });
const REMOTE = "s_3f9a1c2b77de";

test("create: the server is the call's, the group it is made in in the body; its library is `local` there", async () => {
  answer = { group: { id: "g_0000000000aa", name: "git", parent: "" } };
  assert.deepEqual(await libraryApi.createGroup("local", "git"), answer);
  assert.deepEqual(one(), ["local", "POST", "/api/library/local/groups", { name: "git", parent: "" }]);
  calls.length = 0;
  await libraryApi.createGroup(REMOTE, "hooks", "g_0000000000aa");
  assert.deepEqual(one(), [REMOTE, "POST", "/api/library/local/groups", { name: "hooks", parent: "g_0000000000aa" }]);
  calls.length = 0;
  answer = { prompt: { id: "p_0000000000aa", name: "review", parent: "", text: "one\ntwo" } };
  assert.deepEqual(await libraryApi.createPrompt("local", "review", "", "one\ntwo"), answer);
  assert.deepEqual(one(), ["local", "POST", "/api/library/local/prompts", { name: "review", parent: "", text: "one\ntwo" }]);
});

test("change: only the fields given are sent; an empty parent is a move to the top, an empty text a text", async () => {
  await libraryApi.changeGroup("local", "g_0000000000aa", { name: "Git" });
  assert.deepEqual(one(), ["local", "PATCH", "/api/library/local/groups/g_0000000000aa", { name: "Git" }]);
  calls.length = 0;
  await libraryApi.changeGroup(REMOTE, "g_0000000000aa", { parent: "" });
  assert.deepEqual(one(), [REMOTE, "PATCH", "/api/library/local/groups/g_0000000000aa", { parent: "" }]);
  calls.length = 0;
  await libraryApi.changePrompt("local", "p_0000000000aa", { name: "review", parent: "g_0000000000ab", text: "" });
  assert.deepEqual(one(), ["local", "PATCH", "/api/library/local/prompts/p_0000000000aa", { name: "review", parent: "g_0000000000ab", text: "" }]);
});

test("delete: no body", async () => {
  answer = { ok: true };
  assert.deepEqual(await libraryApi.deleteGroup("local", "g_0000000000aa"), answer);
  assert.deepEqual(one(), ["local", "DELETE", "/api/library/local/groups/g_0000000000aa", undefined]);
  calls.length = 0;
  await libraryApi.deletePrompt(REMOTE, "p_0000000000aa");
  assert.deepEqual(one(), [REMOTE, "DELETE", "/api/library/local/prompts/p_0000000000aa", undefined]);
});

test("an item id with other characters stays one part of the path", async () => {
  await libraryApi.changePrompt("local", "../x y", {});
  assert.equal(calls[0].path, "/api/library/local/prompts/..%2Fx%20y");
});

test("a refused call throws the server's sentence with its code", async () => {
  status = 409;
  answer = { error: 'There is already a prompt called "Review" in the group "git".', code: "name_taken" };
  await assert.rejects(libraryApi.createPrompt("local", "review", "g_0000000000aa", ""), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    const code: LibraryCode = "name_taken";
    assert.deepEqual([e.status, e.message, e.said, e.code], [409, 'There is already a prompt called "Review" in the group "git".', true, code]);
    return true;
  });
});

test("libraryOf: a server's tree is its library, connected, with the name the server list has and the notice its snapshot gave", () => {
  const tree = { groups: [{ id: "g_0000000000aa", name: "git", parent: "" }], prompts: [{ id: "p_0000000000aa", name: "review", parent: "", text: "x" }] };
  assert.deepEqual(libraryOf(REMOTE, "Studio", tree), { server: REMOTE, name: "Studio", connected: true, ...tree });
  assert.deepEqual(libraryOf("local", "This computer", tree, "The library file was set aside."), { server: "local", name: "This computer", connected: true, notice: "The library file was set aside.", ...tree });
  assert.deepEqual(libraryOf(REMOTE, "Studio", {}), lib(REMOTE)); // lists the server left out are empty
  assert.deepEqual(libraryOf(REMOTE, "Studio", null), lib(REMOTE));
});

test("libraryAway: the library of a server that is not connected stays as last received, marked so; the list is the same when nothing changes", () => {
  const list = [lib("local"), lib(REMOTE, { prompts: [{ id: "p_0000000000aa", name: "review", parent: "", text: "x" }] })];
  const away = libraryAway(list, REMOTE);
  assert.deepEqual(away.map((v) => [v.server, v.connected]), [["local", true], [REMOTE, false]]);
  assert.deepEqual(away[1].prompts, list[1].prompts);
  assert.equal(away[0], list[0]);
  assert.equal(libraryAway(away, REMOTE), away);
  assert.equal(libraryAway(list, "s_000000000001"), list);
});

test("upsertLibrary: a snapshot's library or an own_library event takes the place of the library of its server, or is added after the others", () => {
  const list = [lib("local"), lib(REMOTE)];
  const changed = lib("local", { prompts: [{ id: "p_0000000000aa", name: "review", parent: "", text: "x" }] });
  assert.deepEqual(upsertLibrary(list, changed), [changed, list[1]]);
  const dropped = lib(REMOTE, { connected: false });
  assert.deepEqual(upsertLibrary(list, dropped), [list[0], dropped]);
  const added = lib("s_000000000001", { name: "Office" });
  assert.deepEqual(upsertLibrary(list, added), [...list, added]);
  assert.deepEqual(upsertLibrary([], changed), [changed]);
  assert.deepEqual(list, [lib("local"), lib(REMOTE)]); // the list given is not changed
});

test("removeLibrary: an entry that left the server list takes the library of its server out", () => {
  const list = [lib("local"), lib(REMOTE)];
  assert.deepEqual(removeLibrary(list, REMOTE), [list[0]]);
  assert.equal(removeLibrary(list, "s_000000000001"), list);
});

test("a call for another server's library can also be refused on the way there, with a sentence and one of three codes", async () => {
  // (the app: the server is not connected, it did not answer, its answer cannot be used)
  for (const [st, code, said] of [[503, "server_unreachable", "Studio is not connected: its prompts cannot be changed until it is back."], [504, "no_answer", "Studio did not answer."], [502, "bad_answer", "Studio's answer cannot be used."]] as [number, LibraryCode, string][]) {
    status = st; answer = { error: said, code };
    await assert.rejects(libraryApi.deletePrompt(REMOTE, "p_0000000000aa"), (e: unknown) => e instanceof ApiError && e.status === st && e.code === code && e.message === said && e.said);
  }
});

test("insertItem: the item a call answered with is added to its server's library only when the library has none with its id", () => {
  const group = { id: "g_0000000000aa", name: "git", parent: "" }, prompt = { id: "p_0000000000aa", name: "review", parent: "g_0000000000aa", text: "a\nb" };
  const list = [lib("local"), lib(REMOTE)];
  const withGroup = insertItem(list, REMOTE, "group", group);
  assert.deepEqual(withGroup.map((v) => v.groups), [[], [group]]);
  assert.equal(withGroup[0], list[0]);
  const withBoth = insertItem(withGroup, REMOTE, "prompt", prompt);
  assert.deepEqual(withBoth[1].prompts, [prompt]);
  // one the stream has brought already stays as the stream gave it
  const newer = { ...prompt, text: "changed since" };
  const held = [lib("local", { prompts: [newer] })];
  assert.deepEqual(insertItem(held, "local", "prompt", prompt)[0].prompts, [newer]);
  assert.equal(insertItem(withGroup, REMOTE, "group", { ...group, name: "Git" })[1], withGroup[1]);
  // a list without the library is left as it is, and the given list is never changed
  assert.deepEqual(insertItem(list, "s_gone", "prompt", prompt), list);
  assert.deepEqual(list.map((v) => [v.groups.length, v.prompts.length]), [[0, 0], [0, 0]]);
  // (the same id in another server's library is another item)
  assert.deepEqual(insertItem(held, "local", "group", group)[0].groups, [group]);
});

test("the limits are the server's (internal/library/library.go)", () => {
  assert.deepEqual(LIBRARY_LIMITS, { name: 80, text: 100_000, items: 5_000, bytes: 4 * 1024 * 1024, depth: 16 });
});
