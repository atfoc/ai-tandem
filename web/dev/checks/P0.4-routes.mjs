// Proves the mock's routes and knobs for the waits of the fork flows (plans/composer-ui-improvements.md, section 3):
// by calls made on the mock as the page's transport makes them (POST /host/call) with its stream (GET /host/events) read
// beside them, and by what the page does with them today.
// And the mock's servers (plans/app-as-client-plan.md, C3.4, C3.7 and C5.3): a call names its server and is answered by that
// machine, a thing made on a server is told as that server's event, the answer of a call by the state of its server, what
// is no call of the client API, what the routes refuse, and the order of the stream when a server drops and is back.
import { check, hostCall, mockEval, openPage, seed, startMove, until } from "../shot.mjs";

await check("P0.4 the mock's routes and knobs", async ({ url, browser, fail, note }) => {
  await seed(url, "A2", "A4");
  const call = async (method, path, body, server = "local") => {
    const t = Date.now(), r = await hostCall(url, method, path, body, server);
    return { status: r.status, body: typeof r.body === "string" ? null : r.body, ms: Date.now() - t };
  };
  const knob = (code) => mockEval(code, url);
  // The event stream, read as a page reads it: every envelope of the stream, flattened (the event, with the top-level
  // `server` of an event of another server, or the app's event), with the moment it came.
  const ctl = new AbortController(), events = [];
  const stream = await fetch(url + "/host/events", { signal: ctl.signal });
  (async () => {
    let buf = "";
    try {
      for await (const chunk of stream.body) {
        buf += Buffer.from(chunk).toString("utf8");
        for (let i; (i = buf.indexOf("\n\n")) >= 0; buf = buf.slice(i + 2)) {
          if (!buf.startsWith("data:")) continue; // (a comment: the open mark, a ping)
          const env = JSON.parse(buf.slice(5, i));
          events.push({ at: Date.now(), ...(env.event ?? env.app), ...(env.server && env.server !== "local" ? { server: env.server } : {}) });
        }
      }
    } catch {}
  })();
  const of = (chat) => (e) => (e.chat?.id ?? e.chat ?? e.state?.chat) === chat;
  const since = (n, chat) => events.slice(n).filter(of(chat));
  // What the mock has told of a chat from event n until now. The stream keeps the order: an event the mock is asked to
  // send now comes after everything it sent before, so no time has to be waited for what "has gone out".
  let marks = 0;
  const toldOf = async (n, chat) => {
    const id = `mark${++marks}`;
    await knob(`send({ type: "mock_mark", id: "${id}" });`);
    if (!await until(() => events.some((e) => e.id === id))) throw new Error("the event stream did not bring the mark the mock was asked to send");
    return events.slice(n, events.findIndex((e) => e.id === id)).filter(of(chat));
  };
  const word = (e) => (e.type === "branch_state" ? `branch_state:${e.state.branch}` : e.type === "chat_items" ? `chat_items:${e.branch}` : e.type);
  const words = (list) => list.map(word).join();
  const held = (ms, delay) => ms >= delay - 20; // (a time held is a lower bound: a slow machine makes it longer, never shorter)
  const expect = (what, ok, got) => { if (!ok) fail(`${what}: got ${JSON.stringify(got)}`); };
  const target = { text: "Try another way.", context: "", target: { branch: "main", at: 3, new: true } };
  // What the server refuses a message, a fork or a pick with (internal/server/server.go statusOf, codeOf): an archived
  // chat's refusal has no code.
  const NO = { busy: [409, "busy", "the agent is still working; wait for it to finish or stop it"], cap: [429, "cap", "this chat already has 4 branches working; wait for one to finish or stop one"],
    window: [409, "window", "the model's context window is too small for this conversation"], point: [400, "bad_point", "a branch or a fork can't start at that point"], archived: [409, "", "the chat is archived"] };
  const refuse = ([status, code, error]) => JSON.stringify({ status, code, error });
  const refused = (r, [status, code, error]) => r.status === status && r.body?.error === error && (code ? r.body.code === code : !("code" in r.body));
  const treeOf = async (chat) => (await call("GET", `/api/chats/${chat}/tree`)).body;
  const T = "c_A4_turns", send = (body = target) => call("POST", `/api/chats/${T}/messages`, body);

  // ---- a message with a target
  let n = events.length, t = Date.now(), r = await send();
  const made = r.body?.branch;
  expect("a message with a target answers with the new branch", r.status === 200 && r.body?.ok === true && typeof made === "string" && made !== "main", r);
  let told = await toldOf(n, T);
  const first = told.slice(0, told.findIndex((e) => e.type === "tree") + 1);
  expect("a chat's first branch tells main's branch_state, its own, chat and tree, in that order, and no chat_items for the message", words(first) === `branch_state:main,branch_state:${made},chat,tree`, words(told));
  expect("main's record is main's state, as it was", first[0]?.state.status === "ready" && first[0].state.usage?.turns === 3 && first[0].state.locked === true, first[0]?.state);
  expect("the chat event names the new branch as current", told.find((e) => e.type === "chat")?.chat.branch === made && told.find((e) => e.type === "chat")?.chat.branches === 2, told.find((e) => e.type === "chat"));
  const part = told.find((e) => e.type === "tree");
  expect("the tree event has the branch's part and the current branch", part?.branch?.id === made && part.branch.from === "main" && part.branch.at === 3 && part.current === made, part);
  let tree = await treeOf(T);
  expect("GET …/tree lists the branch made", tree.current === made && tree.branches.map((b) => b.id).join() === `main,${made}`, tree);
  let list = (await call("GET", `/api/chats/${T}/items?branch=${made}`)).body;
  expect("the new branch's list is the prefix and the message", list.branch === made && list.items.length >= 4 && list.items[3].text === target.text && list.state?.branch === made, { branch: list.branch, n: list.items?.length });
  list = (await call("GET", `/api/chats/${T}/items?branch=main`)).body;
  expect("main's list is as it was", list.branch === "main" && list.items.length === 6, { branch: list.branch, n: list.items?.length });
  expect("an unknown branch's list is refused", (await call("GET", `/api/chats/${T}/items?branch=nope`)).status === 404, "not 404");
  const ended = async () => (await call("GET", `/api/chats/${T}/items?branch=${made}`)).body.items.at(-1)?.kind === "end" && (await call("GET", `/api/chats/${T}`)).body.status === "ready";
  expect("the canned reply ended on the new branch", await until(ended), "not ended");

  // ---- the knobs of flags.send
  const branchesOf = async () => (await treeOf(T)).branches.length;
  await knob(`flags.send = { delay: 700, noReply: true };`);
  n = events.length; t = Date.now(); r = await send();
  expect("flags.send.delay holds the answer", r.status === 200 && held(r.ms, 700), r);
  told = await toldOf(n, T);
  expect("the events of a delayed branch have gone out at the answer and not before the delay: its record, chat and tree, main's not again", words(told) === `branch_state:${r.body?.branch},chat,tree` && told.every((e) => held(e.at - t, 700)), told.map((e) => [word(e), e.at - t]));
  // (a call that is held waits for its release, not for a time: a check reads the page meanwhile, at any speed)
  await knob(`flags.send = { hold: true, noReply: true };`);
  let waiting = true;
  const kept = send().then((x) => { waiting = false; return x; });
  expect("flags.send.hold: the call reaches the mock and waits there", await until(() => knob(`return flags.send.held?.length === 1;`)) && waiting, waiting);
  expect("release(\"fork\") lets go no call of another knob", await knob(`return release("fork");`) === 0 && waiting, waiting);
  expect("release(\"send\") answers how many calls it let go, and the call is answered with its branch", await knob(`return release("send");`) === 1 && (r = await kept).status === 200 && typeof r.body?.branch === "string", r);
  const once = send();
  expect("a knob that was replaced still holds its call, which release() lets go", await until(() => knob(`return flags.send.held?.length === 1;`)) && await knob(`flags.send = { noReply: true }; return release();`) === 1 && (await once).status === 200, "not let go");
  let had = await branchesOf();
  for (const [name, no] of Object.entries(NO)) {
    await knob(`flags.send = { refuse: ${refuse(no)} };`);
    r = await send();
    expect(`flags.send.refuse answers the server's refusal "${name}": ${no[0]}, ${no[1] ? `the code ${no[1]}` : "no code"}, and no branch is made`, refused(r, no) && await branchesOf() === had, r);
  }
  await knob(`flags.send = { unknown: true };`);
  r = await send();
  expect("flags.send.unknown answers 504 send_unknown and makes no branch", r.status === 504 && r.body?.code === "send_unknown" && await branchesOf() === had, r);
  await knob(`flags.send = { unknown: "arrived", noReply: true };`);
  n = events.length; r = await send();
  expect('flags.send.unknown = "arrived" answers 504 send_unknown too', r.status === 504 && r.body?.code === "send_unknown", r);
  expect("and its branch is made and told all the same", await until(() => since(n, T).some((e) => e.type === "tree")) && await branchesOf() === had + 1, [words(since(n, T)), await branchesOf(), had]);
  const arrived = (await treeOf(T)).branches.at(-1);
  expect("and that branch has the message", arrived.len === 4 && arrived.items.at(-1)?.text === target.text, arrived);
  had = await branchesOf();
  await knob(`flags.send = { noBranch: true, noReply: true };`);
  r = await send();
  expect("flags.send.noBranch answers with no branch, the branch made", r.status === 200 && r.body?.ok === true && !("branch" in r.body) && await branchesOf() === had + 1, r);
  // (the events are held for 2 s, long beside the call that asks what was told at the answer)
  await knob(`flags.send = { eventsAfter: 2000, noReply: true };`);
  n = events.length; t = Date.now(); r = await send();
  list = (await call("GET", `/api/chats/${T}/items?branch=${r.body?.branch}`)).body; // (read before the mark: nothing was told yet when it was answered)
  told = await toldOf(n, T);
  expect("flags.send.eventsAfter: nothing is told of the branch at the answer", r.status === 200 && !told.length, words(told));
  expect("flags.send.eventsAfter: the branch's list has the message at the answer, before anything is told of it", list?.items?.length === 4 && list.items[3].text === target.text && list.state?.status === "thinking" && (await treeOf(T)).current === r.body?.branch,
    { n: list?.items?.length, last: list?.items?.at(-1), state: list?.state?.status });
  expect("flags.send.eventsAfter: the events come after it", await until(() => since(n, T).some((e) => e.type === "tree")) && words(since(n, T)) === `branch_state:${r.body?.branch},chat,tree` && since(n, T).every((e) => held(e.at - t, 2000)), since(n, T).map((e) => [word(e), e.at - t]));
  // A chat archived while its message is held is refused, as a deleted one is. (The chat is the lab box's: the same
  // calls to that server, answered by that machine.)
  const GONE = "/api/chats/c_A4_remote", LABBOX = "s_lab";
  await knob(`flags.send = { delay: 1500 };`);
  const late = call("POST", `${GONE}/messages`, target, LABBOX);
  await call("POST", `${GONE}/archive`, undefined, LABBOX);
  r = await late;
  expect("a message to a chat archived during the delay is refused", r.status === 409 && r.body?.error === "the chat is archived" && (await call("GET", `${GONE}/tree`, undefined, LABBOX)).body.branches.length === 1, r);
  await knob(`delete flags.send;`);

  // ---- a branch's list: its own, delayed, failed
  const TWO = "c_A4_two";
  tree = await treeOf(TWO);
  expect("the seeded chat's tree has two branches", tree.current === "main" && tree.branches.length === 2 && tree.branches[1].id === "alt" && tree.branches[1].from === "main" && tree.branches[1].at === 3
    && tree.branches[1].items.some((i) => i.kind === "text" && i.end === 6 && i.ok), tree);
  const alt = (await call("GET", `/api/chats/${TWO}/items?branch=alt`)).body, main = (await call("GET", `/api/chats/${TWO}/items?branch=main`)).body;
  expect("a branch's GET …/items answers that branch's list", alt.branch === "alt" && alt.items[3].text === "Is there a faster way?" && main.branch === "main" && main.items[3].text === "Fix it.", [alt.items?.[3], main.items?.[3]]);
  await knob(`flags.items = { chat: "${TWO}", branch: "alt", delay: 1500 };`);
  let holding = true;
  const slow = call("GET", `/api/chats/${TWO}/items?branch=alt`).then((x) => { holding = false; return x; });
  r = await call("GET", `/api/chats/${TWO}/items?branch=main`);
  expect("flags.items.delay leaves another branch's list alone: it answers while the first is held", holding && r.status === 200, [holding, r.ms]);
  expect("flags.items.delay holds the branch's list", held((await slow).ms, 1500), "sooner");
  await knob(`flags.items = { chat: "${TWO}", branch: "alt", fail: 500 };`);
  expect("flags.items.fail fails the branch's list", (await call("GET", `/api/chats/${TWO}/items?branch=alt`)).status === 500, "not 500");
  await knob(`delete flags.items;`);

  // ---- a fork, and a fork's model pick
  r = await call("POST", `/api/chats/${TWO}/fork`, { branch: "alt", at: 6 });
  const fork = r.body;
  expect("POST …/fork answers the new chat", r.status === 200 && fork.forkedFrom === TWO && fork.forkedBranch === "alt" && fork.forkedAt === 6 && fork.fresh === true && fork.locked === true && fork.name === "Two branches (fork)", fork);
  expect("the fork has the branch's first items", (await call("GET", `/api/chats/${fork.id}/items?branch=main`)).body.items.length === 6, "another count");
  // (the message forked and edited gets two quotes: of an item the copy has, and of one it lacks)
  await knob(`items.${TWO}[3].references = [{ quote: "font copy step", comment: "", item: 1, start: 15, end: 29 }, { quote: "Done", comment: "", item: 4, start: 0, end: 4 }]; flags.fork = { delay: 600 };`);
  n = events.length; t = Date.now(); r = await call("POST", `/api/chats/${TWO}/fork`, { branch: "main", at: 3, message: 3 });
  told = (await toldOf(n, r.body?.id)).filter((e) => e.type === "chat");
  expect("flags.fork.delay holds the answer, and nothing is told before it", held(r.ms, 600) && told.length === 1 && held(told[0].at - t, 600), [r.ms, told.map((e) => e.at - t)]);
  expect("a fork with a message has it as its draft, with the quotes of the items copied", r.body?.draft?.text === "Fix it." && r.body.draft.references?.length === 1 && r.body.draft.references[0].item === 1, r.body?.draft);
  for (const name of ["busy", "point", "archived"]) {
    await knob(`flags.fork = { refuse: ${refuse(NO[name])} };`);
    r = await call("POST", `/api/chats/${TWO}/fork`, { branch: "main", at: 3 });
    expect(`flags.fork.refuse answers the server's refusal "${name}"`, refused(r, NO[name]), r);
  }
  // (a pick is held for 1.5 s: the fork's "thinking" comes within milliseconds, well inside it)
  await knob(`delete flags.fork; flags.configure = { delay: 1500 };`);
  // What a fork's view said in its `chat` events: its status and the model it names.
  const views = (list) => list.filter((e) => e.type === "chat").map((e) => `${e.chat.status}:${e.chat.model}`);
  for (const [kind, model, tells] of [["claude", "sonnet", true], ["cursor", "gpt-5.4-nano", true], ["pi", "gpt-5.4", false]]) {
    const id = `c_A4_fork_${kind}`;
    n = events.length; holding = true;
    const pick = call("PATCH", `/api/chats/${id}?branch=main`, { model }).then((x) => { holding = false; return x; });
    if (tells) {
      await until(() => !holding || views(since(n, id)).length);
      expect(`a fresh ${kind} fork is thinking, on the model picked, while its model pick is held`, holding && views(since(n, id)).join() === `thinking:${model}`, [holding, views(since(n, id))]);
      r = await call("PATCH", `/api/chats/${id}?branch=main`, { model });
      expect(`a second pick on the ${kind} fork meanwhile is refused as busy, at once`, holding && refused(r, NO.busy), [holding, r]);
    }
    r = await pick;
    expect(`a delayed model pick on a fresh ${kind} fork answers the chat on that model`, held(r.ms, 1500) && r.body?.chat?.model === model && r.body.chat.status === "ready" && r.body.chat.fresh === true, r);
    told = views(await toldOf(n, id));
    expect(tells ? `the ${kind} fork is ready again at the answer` : `the ${kind} fork tells nothing of the pick until it is made`, told.join() === (tells ? `thinking:${model},ready:${model}` : `ready:${model}`), told);
  }
  await knob(`flags.configure = { refuse: ${refuse(NO.window)} };`);
  for (const [kind, model, was] of [["claude", "haiku", "sonnet"], ["cursor", "gpt-5.4", "gpt-5.4-nano"], ["pi", "claude-sonnet-5-5", "gpt-5.4"]]) {
    const before = (await call("GET", `/api/chats/c_A4_fork_${kind}`)).body;
    n = events.length; r = await call("PATCH", `/api/chats/c_A4_fork_${kind}?branch=main`, { model });
    const now = (await call("GET", `/api/chats/c_A4_fork_${kind}`)).body;
    expect(`flags.configure.refuse on a fresh ${kind} fork answers its status and code, the fork as before`, refused(r, NO.window) && now.model === was && now.effort === before.effort && now.status === "ready" && now.fresh === true, [r, now.model, now.effort, now.status]);
    told = views(await toldOf(n, `c_A4_fork_${kind}`));
    expect(`a refused pick on a fresh ${kind} fork ${kind === "pi" ? "tells nothing" : "shows the choice while it is tried, then the old one again"}`, told.join() === (kind === "pi" ? "" : `thinking:${model},ready:${was}`), told);
  }
  await knob(`flags.configure = { chat: "c_A4_fork_pi", refuse: ${refuse(NO.window)} };`);
  r = await call("PATCH", `/api/chats/c_A4_fork_pi?branch=main`, { model: "claude-sonnet-5-5" });
  const other = await call("PATCH", `/api/chats/c_A4_fork_claude?branch=main`, { model: "haiku" });
  expect("a knob that names a chat holds for that chat alone", refused(r, NO.window) && other.status === 200 && other.body?.chat?.model === "haiku", [r, other]);
  await knob(`delete flags.configure; flags.spawn = { delay: 500 };`);
  n = events.length; r = await call("POST", `/api/chats/c_A4_fork_cursor/messages?branch=main`, { text: "Go on.", context: "" });
  await until(() => since(n, "c_A4_fork_cursor").some((e) => e.type === "chat" && e.chat.fresh === undefined));
  const cold = since(n, "c_A4_fork_cursor").filter((e) => e.type === "chat");
  expect("flags.spawn: the first message to a fresh fork finds it thinking and still fresh, then puts the message", held(r.ms, 500) && cold[0]?.chat.status === "thinking" && cold[0].chat.fresh === true && cold.at(-1).chat.fresh === undefined, cold.map((e) => [e.chat.status, e.chat.fresh]));
  await knob(`delete flags.spawn;`);

  // ---- the servers: a call names its server, a thing is made on a server by the call to it, and is fixed there
  const LAB = "s_lab", counts = () => knob('return Object.fromEntries(Object.entries(worlds).map(([id, w]) => [id, Object.keys(w.chats).length + Object.keys(w.boards).length]));');
  const heldBefore = await counts();
  for (const server of ["s_lab", "local"]) {
    r = await call("POST", `/api/chats`, { group: "g_A2", server: "s_lab" }, server);
    expect(`POST /api/chats to ${server} with a server in its body is refused, and nothing is made`, r.status === 400 && r.body?.code === "server_refused" && r.body.error === "an API client cannot name a server" && JSON.stringify(await counts()) === JSON.stringify(heldBefore), r);
    r = await call("POST", `/api/boards`, { group: "g_A2", server: "local" }, server);
    expect(`POST /api/boards to ${server} with a server in its body, "local" too, is refused, and nothing is made`, r.status === 400 && r.body?.code === "server_refused" && JSON.stringify(await counts()) === JSON.stringify(heldBefore), r);
  }
  n = events.length;
  r = await call("POST", `/api/chats`, { group: "g_A2" }, LAB);
  const there = r.body?.id;
  expect("POST /api/chats to a server makes the chat on that server, unstarted, with its folder and model, and names no server in it", r.status === 200 && !("server" in r.body) && r.body.locked === false && r.body.cwd === "/home/dev/projects" && r.body.agent === "claude" && r.body.model === "opus"
    && await knob(`return !!worlds.s_lab.chats[${JSON.stringify(there)}] && !worlds.local.chats[${JSON.stringify(there)}];`), r);
  told = await toldOf(n, there);
  expect("the chat made there is told as that server's: the envelope names s_lab and the `chat` event has that server's own ids", told.length === 1 && told[0].type === "chat" && told[0].server === "s_lab" && told[0].chat.id === there && told[0].chat.group === "g_A2", told);
  r = await call("POST", `/api/chats`, { group: "g_A2" }, "s_off");
  expect("a call for a server that is not connected is answered 503 server_unreachable with its name, and nothing is made", r.status === 503 && r.body?.code === "server_unreachable" && r.body.error === "Office Mac is not connected." && !r.body.id, r);
  r = await call("POST", `/api/chats`, { group: "g_A2" }, "s_bare");
  expect("a chat made on a server with no agent has none", r.status === 200 && !r.body.agent && r.body.cwd === "/home/bare", r);
  r = await call("POST", `/api/chats`, { group: "g_A2" }, "s_nope");
  expect("a server that is not in the list is 404 no_server", r.status === 404 && r.body?.code === "no_server", r);
  r = await call("GET", `/api/chats/c_nope`, undefined, LAB);
  expect("a call for a thing that server has not is that server's 404, with the code not_found", r.status === 404 && r.body?.code === "not_found", r);
  r = await call("GET", `/api/chats/${there}`);
  expect("this computer knows no chat of another server: 404 not_found", r.status === 404 && r.body?.code === "not_found", r);
  for (const path of ["/api/servers", "/api/on/s_lab/chats", "/api/restart", "/api/mcp/status", "/api/remote/status", "/api/groups/order", "/api/boards/b_x/reveal", "/api/chats/c_x/../items", "/index.html", "/api/events", "/api/chats#x"]) {
    r = await call("GET", path, undefined, LAB);
    expect(`${path} is no call of the client API: 400 not_client_api`, r.status === 400 && r.body?.code === "not_client_api", r);
  }
  r = await call("PUT", `/api/groups/g_A2`, { name: "x" }, LAB);
  expect("a method that is no row of the table for a path is 400 not_client_api too", r.status === 400 && r.body?.code === "not_client_api", r);
  r = await call("PATCH", `/api/chats/${there}?branch=main`, { agent: "pi" }, LAB);
  expect("PATCH {agent} answers the chat with that agent's default model there", r.body?.chat?.agent === "pi" && r.body.chat.model === "claude-sonnet-5-5" && r.body.chat.effort === "medium", r);
  r = await call("PATCH", `/api/chats/${there}?branch=main`, { server: "local" }, LAB);
  expect("PATCH {server} is refused: a chat is on the server it was made on", r.status === 409 && r.body?.code === "server_fixed", r);
  r = await call("PATCH", `/api/chats/c_A2_new?branch=main`, { server: "s_lab" });
  expect("PATCH {server} is refused for a chat on this computer too", r.status === 409 && r.body?.code === "server_fixed", r);
  for (const server of [LAB, "local"]) {
    const group = () => knob(`return JSON.stringify(onServer(${JSON.stringify(server)}, () => groups.find((g) => g.id === 'g_A2')));`), was = await group();
    r = await call("PATCH", `/api/groups/g_A2`, { collapsed: !JSON.parse(was).collapsed }, server);
    expect(`a PATCH of a group of ${server} with \`collapsed\` is refused, and nothing changes there`, r.status === 400 && r.body?.code === "collapsed_refused" && r.body.error === "an API client cannot collapse a group" && await group() === was, r);
  }
  const doomed = (await call("POST", `/api/chats`, { group: "g_A2" })).body?.id;
  r = await call("DELETE", `/api/chats/${doomed}?local=1`);
  expect("a delete takes the chat: the query `local` is nothing to a client API", r.status === 200 && !await knob(`return !!chats[${JSON.stringify(doomed)}];`), r);
  r = await call("POST", `/api/chats/c_x/unfollow`, undefined, "s_off");
  expect("an unfollow is answered 200, also for a server that is not connected", r.status === 200 && r.body?.ok === true, r);
  r = await call("POST", `/api/boards/b_x/release`, undefined, "s_off");
  expect("a release for a server that is not connected is answered {state: none}", r.status === 200 && r.body?.state === "none", r);
  r = await call("POST", `/api/chats/c_x/unfollow`, undefined, "s_nope");
  expect("an unfollow is 404 no_server for an id that is no entry", r.status === 404 && r.body?.code === "no_server", r);
  r = await call("POST", `/api/boards/b_x/release`, undefined, "s_nope");
  expect("a release for an id that is no entry is 404 no_server", r.status === 404 && r.body?.code === "no_server", r);
  r = await call("PATCH", `/api/groups/g_A2`, { Collapsed: false }, LAB);
  expect("`collapsed` is refused in whatever case its letters are, as the server that decodes the body would take any", r.status === 400 && r.body?.code === "collapsed_refused", r);
  // the bodies the module limits
  r = await call("POST", `/api/chats/${there}/messages`, { text: "x".repeat(2 * 1024 * 1024 + 1) }, LAB);
  expect("a JSON body over 2 MiB is 413 too_large, and nothing is sent", r.status === 413 && r.body?.code === "too_large", r);
  // the draft's counter
  r = await call("PUT", `/api/chats/${there}/draft?branch=main&rev=0`, { text: "first" }, LAB);
  expect("a draft saved on its counter answers the next one", r.status === 200 && r.body?.rev === 1, r);
  r = await call("PUT", `/api/chats/${there}/draft?branch=main&rev=0`, { text: "second" }, LAB);
  expect("a draft saved on an older counter is refused as stale, with the counter and the draft there are", r.status === 409 && r.body?.code === "stale" && r.body.rev === 1 && r.body.draft?.text === "first", r);
  // the snapshot: each server's own (app.APISnapshot), and a server that drops and is back
  const snap = (await call("GET", "/api/state", undefined, LAB)).body, mine = (await call("GET", "/api/state")).body;
  const KEYS = ["agents", "catalogs", "home", "defaultCwd", "groups", "boards", "chats", "defaults", "states", "library"];
  expect("a snapshot is the API snapshot: its fields, this server's tree under its own ids, the library null for a server that has none", KEYS.every((k) => k in snap && k in mine) && snap.home === "/home/dev" && mine.home === "/Users/demo" && snap.chats.some((c) => c.id === there) && !mine.chats.some((c) => c.id === there)
    && snap.library === null && Array.isArray(mine.library?.groups) && !("sections" in mine) && !("servers" in mine) && !("libraries" in mine) && !("dataDir" in mine), Object.keys(snap));
  const fields = (list) => [...new Set(list.flatMap((x) => Object.keys(x)))].filter((k) => ["server", "gone", "unmoved", "moveError", "start", "was", "collapsed"].includes(k));
  expect("no thing of a snapshot has a field of what went away, and no group says whether it is collapsed", !fields([...snap.chats, ...snap.boards, ...snap.groups, ...mine.chats, ...mine.boards, ...mine.groups]).length, fields([...mine.chats, ...mine.boards, ...mine.groups]));
  n = events.length;
  await knob('setServerState("s_lab", "unreachable", { detail: "connection refused" });');
  r = await call("GET", `/api/chats/${there}`, undefined, LAB);
  expect("with the server dropped its calls are 503, and the page was told `server_state` and nothing else of it", r.status === 503 && r.body?.error === "lab-gpu-box.tailnet-1234.ts.net is not connected."
    && events.slice(n).length === 1 && events.slice(n)[0].type === "server_state" && events.slice(n)[0].server?.id === "s_lab" && events.slice(n)[0].server.state === "unreachable", [r, events.slice(n).map((e) => e.type)]);
  await knob('setServerState("s_lab", "too_old", { version: "0.9" });');
  r = await call("GET", `/api/chats/${there}`, undefined, LAB);
  expect("of a server that is too old its calls say so", r.status === 503 && r.body?.code === "server_unreachable" && /is too old: update the server on that machine\.$/.test(r.body.error), r);
  n = events.length;
  await knob(`await elsewhere("s_lab", "PATCH", "/chats/${there}", { name: "Named while away" }); send({ type: "mock_mark", id: "away" });`);
  await until(() => events.some((e) => e.id === "away"));
  expect("what changes on a server that is not connected is told to nobody here", !events.slice(n).some((e) => e.type === "chat"), events.slice(n).map((e) => e.type));
  n = events.length;
  await knob('setServerState("s_lab", "connected");');
  await until(() => events.slice(n).length >= 3);
  const back = events.slice(n);
  expect("back, its stream opens: hello, the snapshot as it is now (its own tree), then the entry as connected, in that order", back.map((e) => `${e.type}:${e.server?.id ?? e.server}`).join() === "hello:s_lab,snapshot:s_lab,server_state:s_lab" && back[1].chats.some((c) => c.id === there && c.name === "Named while away")
    && back[2].server.state === "connected" && !("detail" in back[2].server), back.map((e) => e.type));
  r = await call("PATCH", `/api/chats/c_A2_new`, { name: "Renamed" });
  expect("a rename answers the chat too", r.body?.ok === true && r.body.chat?.name === "Renamed" && r.body.chat.userNamed === true, r);

  // ---- seeding again is a check's reset: what is pending of the chats it replaces is dropped
  {
    const CUR = "c_A4_fork_cursor", CLA = "c_A4_fork_claude", PI = "c_A4_fork_pi", ALL = [T, TWO, CUR, CLA, PI];
    const get = async (path) => (await call("GET", path)).body;
    // A chat as the routes answer it: its view, its list (less the version, a counter that only goes up), its tree.
    const look = async (c) => JSON.stringify([await get(`/api/chats/${c}`), { ...await get(`/api/chats/${c}/items`), version: 0 }, await get(`/api/chats/${c}/tree`)]);
    await seed(url, "A4");
    const seeded = {};
    for (const c of ALL) seeded[c] = await look(c);
    // Pending when the seed is called again: a branch's canned reply (T), a canned reply on main (the pi fork), a
    // branch's late events (TWO), a first message held by its start (the cursor fork), a held pick (the claude fork),
    // and, started inside the mock so that they are held for sure, a held message and a held fork. (The calls are
    // held for 1.5 s, long beside the few calls made until the second seed.)
    await knob(`flags.send = { chat: "${TWO}", eventsAfter: 600 }; flags.spawn = { chat: "${CUR}", delay: 1500 }; flags.configure = { chat: "${CLA}", delay: 1500 };`);
    r = await send();
    expect("a branch send before the second seed is answered", r.status === 200 && (await call("POST", `/api/chats/${PI}/messages?branch=main`, { text: "Go on.", context: "" })).status === 200
      && (await call("POST", `/api/chats/${TWO}/messages`, target)).status === 200, r);
    n = events.length;
    const cold = call("POST", `/api/chats/${CUR}/messages?branch=main`, { text: "Go on.", context: "" }), pick = call("PATCH", `/api/chats/${CLA}?branch=main`, { model: "sonnet" });
    expect("the held message and the held pick have reached the mock", await until(() => [CUR, CLA].every((c) => since(n, c).some((e) => e.type === "chat" && e.chat.status === "thinking"))), words(events.slice(n)));
    await knob(`flags.send = { chat: "${T}", delay: 1500 }; flags.fork = { chat: "${TWO}", delay: 1500 }; globalThis.heldBySeed = [];
      for (const call of [sendMessage(chats.${T}, ${JSON.stringify(target)}, null), forkChat(chats.${TWO}, { branch: "main", at: 3 })]) call.then((v) => heldBySeed.push(v.fail?.[0] ?? 200));`);
    await toldOf(0, T); n = events.length; // (everything told until now has come: what comes from here on is told after the second seed)
    await seed(url, "A4");
    await knob(`await wait(3200);`); // (the mock's own clock: every timer set before this one, and the ones those would set, has fired)
    expect("a message and a pick held while their chat was seeded again answer 404", (await cold).status === 404 && (await pick).status === 404, [(await cold).status, (await pick).status]);
    expect("a message and a fork held inside the mock answer 404 too", (await knob(`return heldBySeed;`)).join() === "404,404", await knob(`return heldBySeed;`));
    for (const c of ALL) {
      const now = await look(c);
      expect(`seeded again with work pending, ${c} is as seeded`, now === seeded[c], now === seeded[c] ? "" : { seeded: JSON.parse(seeded[c])[0], now: JSON.parse(now)[0], items: JSON.parse(now)[1].items?.length, branches: JSON.parse(now)[2].branches?.length });
      const late = await toldOf(n, c);
      expect(`nothing is told of ${c} after the second seed`, !late.length, words(late));
    }
    await knob(`delete flags.send; delete flags.spawn; delete flags.configure; delete flags.fork; delete globalThis.heldBySeed;`);
  }
  ctl.abort();

  // ---- in the page, on today's code
  const branchSend = async (page, text) => { await startMove(page); await page.locator(".composer [contenteditable]").click(); await page.keyboard.type(text); await page.keyboard.press("Enter"); };
  const replied = (page) => page.waitForFunction(() => [...document.querySelectorAll(".thread .msg.assistant")].some((m) => m.textContent.includes("A canned reply of the mock")), null, { timeout: 15000 });
  const usersOf = (page) => page.evaluate(() => [...document.querySelectorAll(".thread .msg.user")].map((m) => m.textContent.trim().slice(0, 30)));
  {
    const errors = [], said = "Branch from the page";
    await seed(url, "A4"); // the chat with main alone again
    await mockEval(`flags.send = { delay: 1500 };`, url);
    const { ctx, page } = await openPage({ url, browser, sel: { chat: T }, errors, wait: ".thread .msg.assistant" });
    const meter = () => page.evaluate(() => document.querySelector(".composer .ctx-meter")?.textContent ?? "");
    const onMain = await until(meter);
    if (!onMain) fail("main's toolbar has no context meter before the branch send");
    const t = Date.now();
    await branchSend(page, said);
    try {
      await page.waitForFunction((said) => !document.querySelector(".fk-banner") && [...document.querySelectorAll(".thread .msg.user")].some((m) => m.textContent.includes(said)), said, { timeout: 8000 });
      await replied(page);
      const seen = { users: await usersOf(page), pill: await page.evaluate(() => document.querySelector(".fk-tree-btn .pill")?.textContent) };
      note(`a branch send in the page against a route delayed by 1.5 s: on the new branch after ${Date.now() - t} ms, the thread says ${JSON.stringify(seen.users)}, the tree button counts ${seen.pill}`);
      if (seen.users.length !== 2 || seen.pill !== "2") fail(`after the branch send the thread has ${JSON.stringify(seen.users)} and the tree button counts ${seen.pill}: not the new branch, cut after the first turn`);
      if (Date.now() - t < 1500) fail("the page was on the new branch before the delayed answer");
      // Back on main, through the tree: its toolbar is drawn from main's record, which the page got with the branch's.
      // (The new branch is given another usage first, so that main's meter cannot be the current branch's.)
      await mockEval(`setSession("${T}", chats.${T}.branch, { usage: { ctxIn: 30000, ctxOut: 500, ctxWindow: 200000, turns: 4 } });`, url);
      const onNew = await until(async () => { const m = await meter(); return m && m !== onMain ? m : ""; });
      if (!onNew) fail(`the new branch's meter still says "${await meter()}" after its usage changed`);
      await page.locator(".chat-head .fk-tree-btn").click();
      await page.locator(".fk-nav .fk-row", { hasText: "Done: the fonts are copied once." }).first().dblclick({ timeout: 8000 });
      await page.waitForFunction(() => !document.querySelector(".fk-nav") && [...document.querySelectorAll(".thread .msg.user")].some((m) => m.textContent.includes("Fix it.")), null, { timeout: 8000 });
      if (await until(async () => await meter() === onMain, 5000)) note(`back on main through the tree: its meter says "${onMain}" as before the send (the new branch's: "${onNew}")`);
      else fail(`back on main after the branch send its meter says "${await meter()}", before the send "${onMain}": the page has no state record of main`);
    } catch (e) { fail(`a branch send in the page did not end on the new branch, or main could not be gone back to: ${e.message.split("\n")[0]}`); }
    for (const e of errors) fail(`page error during the branch send: ${e}`);
    await mockEval(`delete flags.send;`, url);
    await ctx.close();
  }
  {
    // The branch's events come after the answer: the page has the message from the branch's list, where it is at the answer.
    const errors = [], said = "Branch told late";
    await seed(url, "A4");
    await mockEval(`flags.send = { eventsAfter: 1500 };`, url);
    const { ctx, page } = await openPage({ url, browser, sel: { chat: T }, errors, wait: ".thread .msg.assistant" });
    await branchSend(page, said);
    try {
      await replied(page);
      const users = await usersOf(page);
      if (users.join("|") === `Why is the build slow?|${said}`) note(`a branch send in the page whose events come 1.5 s after the answer: once the reply ended the thread says ${JSON.stringify(users)}`);
      else fail(`after a branch send whose events came after the answer the thread has ${JSON.stringify(users)}: the message sent is not shown`);
    } catch (e) { fail(`a branch send whose events come after the answer got no reply in the page: ${e.message.split("\n")[0]}`); }
    for (const e of errors) fail(`page error during the branch send with late events: ${e}`);
    await mockEval(`delete flags.send;`, url);
    await ctx.close();
  }
  {
    // A model pick on a fresh fork, held: the chip names the model picked while the agent starts on it.
    const errors = [], STARTING = '.composer .tchip.static[title^="Starting the agent"]';
    await mockEval(`flags.configure = { delay: 1500 };`, url);
    const { ctx, page } = await openPage({ url, browser, sel: { chat: "c_A4_fork_claude" }, errors, wait: '.composer button.tchip[title^="Model"]' });
    await page.locator('.composer button.tchip[title^="Model"]').click();
    await page.locator(".composer .menu-item", { hasText: "Sonnet 5.5" }).first().click();
    try {
      const during = await (await page.waitForFunction((sel) => document.querySelector(sel)?.textContent, STARTING, { timeout: 8000 })).jsonValue();
      if (during.includes("Sonnet 5.5")) note(`a model pick on a fresh fork, held for 1.5 s: meanwhile the chip says "${during.trim()}"`);
      else fail(`while a pick of Sonnet 5.5 on a fresh fork is held the chip says "${during.trim()}": not the model picked`);
      await page.waitForFunction(() => document.querySelector('.composer button.tchip[title^="Model"]')?.textContent.includes("Sonnet 5.5"), null, { timeout: 8000 });
    } catch (e) { fail(`a held model pick on a fresh fork did not show its start, or did not end on the model picked: ${e.message.split("\n")[0]}`); }
    for (const e of errors) fail(`page error during the held model pick: ${e}`);
    await mockEval(`delete flags.configure;`, url);
    await ctx.close();
  }
  {
    const errors = [];
    const { ctx, page } = await openPage({ url, browser, sel: { chat: "c_A4_two" }, errors, wait: ".thread .msg.assistant" });
    await page.locator(".thread .msg.assistant").first().hover();
    await page.locator(".thread .msg.assistant .fk-act.k-fork").first().click();
    try {
      await page.waitForFunction(() => document.querySelector(".chat-head-name")?.textContent.includes("Two branches (fork)"), null, { timeout: 5000 });
      note("Fork on a reply: the page opens the new chat");
    } catch { fail(`Fork on a reply did not open the new chat: the header says "${await page.locator(".chat-head-name").textContent()}"`); }
    for (const e of errors) fail(`page error during the fork: ${e}`);
    await ctx.close();
  }
});
