import assert from "node:assert/strict";
import { callsOf, check, mockEval, seed, until } from "../shot.mjs";
import { byTid, press } from "./sel.mjs";

export const viewports = ["phone", "tablet", "desktop"];

const REMOTE = "s_0123456789ab";
const ACCOUNT = "claude:a_work0001";
const WAIT = { timeout: 10_000 };

async function swipeSheetDown(page) {
  const handle = await byTid(page, "sheet-handle").last().boundingBox();
  const client = await page.context().newCDPSession(page);
  const x = Math.round(handle.x + handle.width / 2);
  const y = Math.round(handle.y + handle.height / 2);
  try {
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= 8; i++) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + 16 * i }] });
    }
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.detach();
  }
}

await check("PU.1 plan usage overview, entry points and connected servers", async ({ url, viewport, open }) => {
  const phone = viewport === "phone";
  const states = await seed(url, "A2");
  await mockEval(`
    extra.agents = ["claude", "codex"];
    setAccounts("local", { aliases: [{ id: "a_work0001", name: "Claude Work", login: { known: true, loggedIn: true }, container: { state: "running" } }] });
    const limit = (kind, label, percent, inMs = 3600000) => ({ kind, label, percent, inMs });
    ux3.planOverview = {
      local: {
        claude: { limits: [limit("weekly_all", "Weekly", 66, 7200000), limit("session", "Session", 52)] },
        codex: { limits: [limit("weekly", "Weekly", 82, 7200000)] },
        "${ACCOUNT}": { limits: [limit("session", "Session", 21)] },
        cursor: { limits: [{ ...limit("individual.overall", "Total usage", 38), detail: "$413.89 of $1,101" }] },
      },
      "${REMOTE}": { codex: { limits: [limit("session", "Session", 97)] } },
    };
    addServer({ id: "${REMOTE}", name: "Build box", state: "connected" }, { lists: { ...listsHere(), agents: ["codex"] } });
  `, url);

  for (const theme of ["light", "dark"]) {
    const { page, ctx } = await open({ sel: {}, ls: { "aiwb.theme": theme } });
    try {
      const T = (id, data) => byTid(page, id, data);
      const gauge = T("plan-gauge");
      const overview = T("plan-overview");
      const local = T("plan-usage-server", { server: "local" });
      const remote = T("plan-usage-server", { server: REMOTE });
      if (phone) {
        await press(page, T("home-gear"));
        await press(page, T("settings-row", { row: "plan-usage" }));
      } else {
        await gauge.waitFor({ state: "visible", ...WAIT });
        assert.ok(await until(async () => (await gauge.textContent()) === "Codex 82% used", 8000));
        assert.equal(await gauge.getAttribute("data-tone"), "danger");
        assert.match(await gauge.getAttribute("aria-label"), /Codex, Weekly: 82% used, resets in /);
        await press(page, gauge);
      }
      await overview.waitFor({ state: "visible", ...WAIT });
      assert.ok(await until(async () => (await local.textContent()).includes("82% used"), 8000));
      assert.deepEqual(await byTid(local, "plan-usage-agent").evaluateAll((nodes) => nodes.map((node) => node.dataset.agent)), ["claude", "codex", ACCOUNT]);
      const claude = byTid(local, "plan-usage-agent", { agent: "claude" });
      assert.deepEqual(await byTid(claude, "plan-usage-limit").evaluateAll((nodes) => nodes.map((node) => node.dataset.kind)), ["session", "weekly_all"]);
      assert.match(await local.textContent(), /Claude Work/);
      assert.match(await local.textContent(), /Resets in .* · /);
      assert.match(await remote.textContent(), /On Build box/);
      assert.ok(await until(async () => (await remote.textContent()).includes("97% used"), 8000));
      assert.match(await T("plan-overview-age").textContent(), /Updated 3m ago/);
      if (theme === "light") {
        const calls = callsOf(page);
        await mockEval(`
          extra.agents = ["claude", "codex", "cursor"];
          ux3.planOverview.local.claude = { limits: [], note: "Claude is using an API key." };
          ux3.planOverview.local["${ACCOUNT}"] = { error: "Claude Work is offline." };
          send({ type: "agents", agents: listsHere().agents });
        `, url);
        const again = T("plan-overview-refresh");
        await press(page, again);
        assert.ok(await until(() => ["local", REMOTE].every((server) => calls.some((call) => call.server === server && /^\/api\/usage\?.*fresh=1/.test(call.path))), 8000));
        assert.ok(await until(async () => (await local.textContent()).includes("Claude Work is offline."), 8000));
        assert.match(await local.textContent(), /Claude is using an API key\./);
        assert.match(await byTid(local, "plan-usage-agent", { agent: "cursor" }).textContent(), /\$413\.89 of \$1,101 · 38% used/);
        await mockEval(`setServerState("${REMOTE}", "unreachable");`, url);
        await remote.waitFor({ state: "detached", ...WAIT });
        if (!phone) assert.equal(await gauge.textContent(), "Codex 82% used");
        await mockEval(`
          extra.agents = ["claude", "codex"];
          ux3.planOverview.local.claude = { limits: [{ kind: "session", label: "Session", percent: 52, inMs: 3600000 }] };
          ux3.planOverview.local["${ACCOUNT}"] = { limits: [{ kind: "session", label: "Session", percent: 21, inMs: 3600000 }] };
          setServerState("${REMOTE}", "connected");
        `, url);
      }
      if (phone && theme === "light") await swipeSheetDown(page);
      else await page.keyboard.press("Escape");
      await overview.waitFor({ state: "detached", ...WAIT });

      if (!phone) {
        await press(page, T("side-hide"));
        await gauge.waitFor({ state: "hidden", ...WAIT });
        await press(page, T("side-rail-settings"));
        await press(page, T("settings-plan-usage"));
        await overview.waitFor({ state: "visible", ...WAIT });
        await T("overlay-backdrop").last().click({ force: true, position: { x: 2, y: 2 } });
        await overview.waitFor({ state: "detached", ...WAIT });
      }
    } finally {
      await ctx.close();
    }
  }

  const started = states.find(({ id }) => id === "plain-started");
  const { page, ctx } = await open({ sel: started.sel, wait: '[data-testid="ctx-meter"]' });
  try {
    await press(page, byTid(page, "ctx-meter").first());
    await press(page, byTid(page, "usage-all-agents"));
    await byTid(page, "plan-overview").waitFor({ state: "visible", ...WAIT });
    await page.keyboard.press("Escape");
    await byTid(page, "plan-overview").waitFor({ state: "detached", ...WAIT });
  } finally {
    await ctx.close();
  }
}, { viewports, page: false });
