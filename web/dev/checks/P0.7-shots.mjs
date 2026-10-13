// Proves the driver's comparison of screenshots: a build against itself differs in no pixel on still pages, a copy of
// it with one colour token changed differs, and a region left out is not compared.
import fs from "node:fs";
import path from "node:path";
import { check, compareShots } from "../shot.mjs";

const PAGES = [
  { name: "home", sel: {} },
  { name: "chat", sel: { chat: "c_plain" }, wait: ".thread .msg.assistant" },
  { name: "board", sel: { board: "b_arch", chat: "c_board" }, wait: ".excalidraw" },
  { name: "seeded", sel: { chat: "c_A6_cards" }, seed: ["A6"], wait: ".thread .perm" },
];

await check("P0.7 screenshots of two builds, compared", async ({ browser, mock, dist, fail, note }) => {
  if (!mock) return fail("this check starts its own mocks, one per build: run it with PORT and DIST, not with MOCK");
  await mock.stop(); // the comparison's mocks take the port in turn
  const other = fs.mkdtempSync(path.join(path.dirname(dist), "aiwb-dist-token-"));
  try {
    fs.cpSync(dist, other, { recursive: true });
    const css = fs.readFileSync(path.join(dist, "main.css"), "utf8"), changed = css.replace(/--accent:\s*[^;}]+/g, "--accent:#00a000");
    if (changed === css) return fail("the build's main.css sets no --accent token to change");
    fs.writeFileSync(path.join(other, "main.css"), changed);
    const say = (r) => r.map((p) => `${p.name} ${p.differing}`).join(", ");
    const same = await compareShots({ a: dist, b: dist, pages: PAGES, port: mock.port, browser });
    note(`a build against itself, differing pixels: ${say(same)}`);
    for (const p of same) if (p.differing) fail(`${p.name}: ${p.differing} of ${p.pixels} pixels differ between two screenshots of one build`);
    const diff = await compareShots({ a: dist, b: other, pages: PAGES, port: mock.port, browser });
    note(`against a copy with --accent changed: ${say(diff)}`);
    for (const p of diff) if (!p.differing) fail(`${p.name}: no pixel differs though --accent was changed in the other build`);
    const less = await compareShots({ a: dist, b: other, pages: PAGES.slice(0, 2), omit: [".side-pane", ".chat-page"], port: mock.port, browser });
    note(`the same with the sidebar and the chat page left out: ${say(less)}`);
    if (less[1].differing) fail(`chat: ${less[1].differing} pixels differ with both panes of the page left out`);
    if (!less[0].differing || less[0].differing >= diff[0].differing) fail(`home: ${less[0].differing} pixels differ with the sidebar left out, ${diff[0].differing} with nothing left out`);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});
