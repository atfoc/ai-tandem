// The collector of the board bench on a device (dev/bench/collect.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error: a plain .mjs of the dev tools, without types
import { startCollector } from "../dev/bench/collect.mjs";

const post = (url: string, body: string) => fetch(url, { method: "POST", headers: { "content-type": "text/plain" }, body });

test("collector: progress lines are emitted, the result resolves, anything else is ignored", async () => {
  const ignored: string[] = [];
  const c = await startCollector({ host: "127.0.0.1", log: (m: string) => ignored.push(m) });
  try {
    const url = c.url("127.0.0.1");
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/report$/);
    assert.notEqual(c.port, 4748);
    const seen: string[] = [];
    c.progress.on("line", (t: string) => seen.push(t));

    const root = await fetch(`http://127.0.0.1:${c.port}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /aiwb bench collector/);

    let r = await post(url, JSON.stringify({ kind: "aiwb-board-bench-progress", text: "hi" }));
    assert.equal(r.status, 204);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    r = await post(url, "{not json");
    assert.equal(r.status, 204);
    r = await post(url, JSON.stringify({ kind: "something-else" }));
    assert.equal(r.status, 204);
    assert.deepEqual(seen, ["hi"]);
    assert.equal(ignored.length, 2);
    assert.equal(c.latest(), null);

    await post(url, JSON.stringify({ kind: "aiwb-board-bench", version: 1, runs: [], n: 1 }));
    await post(url, JSON.stringify({ kind: "aiwb-board-bench", version: 1, runs: [], n: 2 }));
    assert.equal((await c.result).n, 1);
    assert.equal(c.latest().n, 2);
    assert.deepEqual(c.lines, ["hi"]);
  } finally {
    await c.close();
  }
});

test("collector: a preflight is answered, an unknown path is 404", async () => {
  const c = await startCollector({ host: "127.0.0.1", log: () => {} });
  try {
    const pre = await fetch(c.url("127.0.0.1"), { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.equal((await fetch(`http://127.0.0.1:${c.port}/nope`)).status, 404);
  } finally {
    await c.close();
  }
});
