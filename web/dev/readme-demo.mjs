// The made-up project of the README's screenshots (dev/readme-shots.mjs): a "checkout service" with its groups, boards,
// chats, subagents, prompt library and two remote servers. Plain data and the code that puts it into the mock (the
// mock's own helpers `chat`, `say`, `tool`, `addServer`, … are in scope of the code run through /mock/eval).
import { CREATE } from "./readme-diagram.mjs";

const J = JSON.stringify;
export const CO = "/Users/demo/projects/checkout-service";
const f = (p) => `${CO}/${p}`;

// ---- the chats' threads (the item lists of mock.mjs)

/** An `apply` call as the thread keeps it: the input as the agent sent it, and the answer as the page gave it. */
const applied = () => {
  const created = {};
  CREATE.forEach((c, i) => { created[c.key ?? `#${i}`] = Math.random().toString(36).slice(2, 16).padEnd(14, "0"); });
  return { input: { board: "b_flow", create: CREATE }, result: J({ board: "Checkout flow", id: "b_flow", created, updated: [], deleted: [], conflicts: [], rev: 4 }) };
};

/** The mock's own `say` and `tool` (mock.mjs), for the lists made here. */
const NODE = {
  say: (text) => ({ kind: "text", done: true, text }),
  tool: (id, name, input, result, more) => ({ kind: "tool", toolId: id, name, input, ...(result === undefined ? {} : { result }), ...more }),
};

export const THREADS = (T) => {
  const { say, tool } = T;
  const end = { kind: "end" };
  const plain = (q, a) => [{ kind: "user", text: q }, say(a), end];
  const a = applied();
  return {
    hero: [
      { kind: "user", text: "Draw the request flow of our checkout service on this board: gateway, checkout, payments, inventory, the orders DB and the event bus." },
      say("I'll check how the service is wired first, then draw it."),
      tool("h1", "Read", { file_path: f("cmd/checkout/main.go") }, "package main\n\nfunc main() {\n\tcfg := config.Load()\n\t…"),
      tool("h2", "Grep", { pattern: "Publish", path: f("internal") }, "internal/orders/events.go:41\ninternal/payments/webhook.go:88"),
      tool("h3", "mcp__board__read_board", { board: "b_flow" }, "Checkout flow (rev 1, 0 elements)\n(empty board)"),
      tool("h4", "mcp__board__apply", a.input, a.result),
      say("Done. The gateway sends `POST /checkout` to the **checkout service**, which reserves stock with Inventory, charges the card through Payments (Stripe), writes the order to Postgres and publishes `order.created` for the email worker.\n\nI also left a note on the board about the idempotency key, since the cart cache depends on it."),
      end,
      { kind: "user", text: "What happens if the card is declined?" },
      say("Checkout stops before it writes anything:\n\n1. Payments returns `card_declined` and Stripe's decline code.\n2. Checkout **releases the reserved stock** in Inventory.\n3. The client gets a `402` with a message it can show, and the cart stays intact.\n\nNo order row and no `order.created` event exist for a declined card, so the email worker stays quiet. Want me to add this failure path to the board?"),
      end,
    ],
    tests: [
      { kind: "user", text: "TestApplyCoupon fails about one run in five on CI. Find out why and fix it." },
      say("Let me reproduce it first."),
      tool("t1", "Bash", { command: "go test ./internal/cart -run TestApplyCoupon -count=20", description: "Run the test 20 times" },
        "--- FAIL: TestApplyCoupon (0.00s)\n    coupon_test.go:48: total = 1799, want 1800\n--- FAIL: TestApplyCoupon (0.00s)\n    coupon_test.go:48: total = 1801, want 1800\nFAIL\nFAIL\tcheckout-service/internal/cart\t0.021s\nExit code 1", { isError: true }),
      tool("t2", "Read", { file_path: f("internal/cart/coupon.go") }, "…"),
      say("Found it. `ApplyCoupon` spreads the discount over the cart's lines by ranging over a **map**, and the rounding remainder lands on whichever line comes first. Go randomises map order, so the total is off by a cent in some runs.\n\nI'll allocate in a fixed order and give the remainder to the last line."),
      tool("t3", "Edit", { file_path: f("internal/cart/coupon.go"),
        old_string: "\tfor sku, line := range cart.Lines {\n\t\tshare := discount * line.Total / cart.Subtotal\n\t\tline.Discount = share\n\t\tallocated += share\n\t}\n\tcart.Lines[lastSKU(cart)].Discount += discount - allocated",
        new_string: "\tskus := sortedSKUs(cart.Lines)\n\tfor _, sku := range skus {\n\t\tline := cart.Lines[sku]\n\t\tshare := discount * line.Total / cart.Subtotal\n\t\tline.Discount = share\n\t\tallocated += share\n\t}\n\t// the cent left over goes to the last line, in a fixed order\n\tcart.Lines[skus[len(skus)-1]].Discount += discount - allocated" },
        "The file " + f("internal/cart/coupon.go") + " has been updated successfully."),
      tool("t4", "Bash", { command: "go test ./internal/cart -count=50", description: "Run the cart tests 50 times" }, "ok  \tcheckout-service/internal/cart\t0.412s"),
      say("Fixed: discounts are now allocated in sorted order and the remainder goes to the last line, so the total is the same on every run. `go test -count=50` passes. I did not touch anything outside `internal/cart`."),
      end,
    ],
    audit: [
      { kind: "user", text: "Audit the checkout service before Friday's release: the cart, the payment retries and stock reservation. Report what is wrong, fix nothing yet." },
      say("I'll split the audit in three and have each part looked at on its own."),
      { ...tool("s1", "mcp__board__spawn_subagent", { description: "Audit the cart totals and coupons", prompt: "Audit internal/cart for wrong totals, rounding and coupon rules. Report what is wrong, change nothing.", model: "sonnet", effort: "medium" }, "Started."), subagent: "sa_cart" },
      { ...tool("s2", "mcp__board__spawn_subagent", { description: "Audit the payment retries", prompt: "Audit internal/payments: retries, idempotency keys and the Stripe webhook handler. Report what is wrong, change nothing.", model: "sonnet", effort: "high" }, "Started."), subagent: "sa_pay" },
      { ...tool("s3", "mcp__board__spawn_subagent", { description: "Audit stock reservation", prompt: "Audit internal/inventory: reserve and release of stock. Report what is wrong, change nothing.", model: "haiku" }, "Started."), subagent: "sa_stock" },
      say("All three are at work. Their reports come back to me here when they finish."),
      end,
      { kind: "subresult", subagent: "sa_stock" },
      say("**Stock reservation** is sound: a reservation expires after 15 minutes and `Release` is idempotent. One nit: `Reserve` logs the SKU at info level on every call, which is noisy but harmless.\n\nThe cart and payment audits are still running."),
      end,
      { kind: "subresult", subagent: "sa_cart" },
      say("**Cart**: one real bug. `ApplyCoupon` allocates the discount over a map, so the total can be a cent off from run to run (that is the flaky `TestApplyCoupon`). Everything else matches the spec.\n\nStill waiting on the payment audit."),
      end,
    ],
    retry: [
      { kind: "user", text: "Add the retry path for failed payments to the board: three attempts with backoff, then the order is marked failed." },
      say("I'll add it next to Payments and keep the existing boxes where they are."),
      tool("r1", "mcp__board__get_view", {}, "active_board: Checkout flow\nselection: none"),
      tool("r2", "mcp__board__apply", { board: "b_flow", create: [{ type: "rectangle", key: "retry" }, { type: "arrow" }] }, J({ board: "Checkout flow", id: "b_flow", created: { retry: "x1", "#1": "x2" }, updated: [], deleted: [], conflicts: [], rev: 5 })),
      say("Added a **Retry queue** below Payments: attempts at 1 s, 5 s and 30 s, then the order moves to `failed`."),
      end,
    ],
    schema: [
      { kind: "user", text: "Review the orders schema for the new refund flow." },
      say("The `orders` table has no place for a partial refund yet. I would add a `refunds` table keyed by order id instead of a column on `orders`, so several refunds per order are possible."),
      end,
    ],
    refund: plain("Sketch the refund endpoint.", "POST /orders/{id}/refunds, idempotent by key, 202 while Stripe confirms."),
    push: plain("Three options for the shipped-order push.", "Your order is on its way. Track it in the app."),
    ci: plain("Why does CI take 14 minutes?", "The Docker layer cache is cold on every run: the lockfile is copied after the source."),
    regex: plain("A regex for codes like SPRING-24-AB12.", "^[A-Z]+-\\d{2}-[A-Z0-9]{4}$"),
  };
};

// ---- the code run inside the mock

/** Puts the demo world into the mock, replacing what it started with. `scene`: the board's drawing, when there is one
 *  already (the page makes it first: dev/readme-shots.mjs). */
export function installCode() {
  return `
  const D = ${J({ CO })};
  const THREADS = ${J(THREADS(NODE))};
  const wipe = (o) => { for (const k of Object.keys(o)) delete o[k]; };
  for (const o of [chats, items, boards, scenes, subs, subItems, versions, branches, sessions]) wipe(o);
  groups.length = 0;
  flags.hello = { version: "uicheck" };
  extra.servers[0].version = "uicheck"; // (the version the page is built with: this computer's server runs the app's build)
  const model = claude.models.find((m) => m.id === "haiku"); model.label = "Haiku 5.5"; model.efforts = ["low", "medium", "high"]; model.defaultEffort = "medium";
  catalogs.pi = { default: { model: "claude-sonnet-5-5", effort: "medium" }, models: [
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "anthropic", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 200000 },
    { id: "gpt-5.4", label: "GPT-5.4", provider: "openai", efforts: ["low", "medium", "high"], defaultEffort: "medium", contextWindow: 128000 } ] };
  const CWD = { co: D.CO, app: HOME + "/projects/shop-app", ops: HOME + "/projects/infra" };
  for (const d of Object.values(CWD)) { TREE[d] = []; const up = d.slice(0, d.lastIndexOf("/")); if (!TREE[up].includes(d.slice(up.length + 1))) TREE[up].push(d.slice(up.length + 1)); }
  Object.assign(CWD, { build: "/home/ci/checkout-service" });

  groups.push({ id: "g_co", name: "Checkout service" }, { id: "g_pay", name: "Payments", parent: "g_co" }, { id: "g_app", name: "Mobile app" }, { id: "g_ops", name: "Infra" });
  boards.b_flow = { id: "b_flow", name: "Checkout flow", group: "g_co", created: iso(T0 - 600 * MIN) };
  boards.b_model = { id: "b_model", name: "Orders data model", group: "g_co", created: iso(T0 - 900 * MIN) };
  boards.b_onb = { id: "b_onb", name: "Onboarding flow", group: "g_app", created: iso(T0 - 1500 * MIN) };
  boards.b_deploy = { id: "b_deploy", name: "Deploy pipeline", group: "g_ops", created: iso(T0 - 2500 * MIN) };
  scenes.b_flow = { rev: 1, scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} } };

  const used = (n, turns) => ({ ctxIn: n, ctxOut: 1800, ctxWindow: 200000, turns });
  const add = (id, name, where, min, items0, o = {}) => { chats[id] = chat(id, { name, ...where, created: iso(T0 - min * MIN), ...o }); items[id] = items0; };
  const cursorChat = { agent: "cursor", model: "gpt-5.4", effort: "medium" };
  const piChat = { agent: "pi", model: "claude-sonnet-5-5", effort: "medium" };
  add("c_hero", "Draw the request flow", { board: "b_flow" }, 40, THREADS.hero, { cwd: CWD.co, usage: used(58000, 2) });
  add("c_retry", "Failed-payment retries", { board: "b_flow" }, 90, THREADS.retry, { ...cursorChat, cwd: CWD.co, usage: used(31000, 1) });
  add("c_schema", "Review orders schema", { board: "b_model" }, 200, THREADS.schema, { cwd: CWD.co, effort: "medium", model: "sonnet", usage: used(24000, 1) });
  add("c_tests", "Fix the flaky cart test", { group: "g_co" }, 25, THREADS.tests, { cwd: CWD.co, usage: used(71000, 1) });
  add("c_audit", "Audit the checkout flow", { group: "g_co" }, 60, THREADS.audit, { cwd: CWD.co, subDepth: 2, subCap: 10, subsRunning: 2, usage: used(46000, 3) });
  add("c_refund", "Refund endpoint", { group: "g_pay" }, 300, THREADS.refund, { ...piChat, cwd: CWD.co, usage: used(18000, 1) });
  add("c_push", "Push notification copy", { group: "g_app" }, 700, THREADS.push, { ...cursorChat, cwd: CWD.app, usage: used(9000, 1) });
  add("c_ci", "Why is CI slow?", { group: "g_ops" }, 1200, THREADS.ci, { cwd: CWD.ops, usage: used(37000, 1) });
  add("c_regex", "Regex for promo codes", { group: "__ungrouped__" }, 15, THREADS.regex, { ...piChat, cwd: CWD.co, usage: used(6000, 1) });

  const sa = (id, description, o) => ({ id, description, prompt: description + ".", kind: "claude", model: "sonnet", effort: "medium", background: true, window: 200000, ...o });
  subs.c_audit = [
    sa("sa_cart", "Audit the cart totals and coupons", { tool: "s1", status: "completed", started: T0 - 40 * MIN, ended: T0 - 29 * MIN, tokens: 52000, toolUses: 14, delivery: "sent", last: "One real bug: ApplyCoupon allocates over a map." }),
    sa("sa_pay", "Audit the payment retries", { tool: "s2", status: "running", waiting: true, effort: "high", started: T0 - 38 * MIN, tokens: 88000, toolUses: 21 }),
    sa("sa_pay_hook", "Trace the Stripe webhook handler", { tool: "p2", parent: "sa_pay", status: "running", started: T0 - 6 * MIN, tokens: 21000, toolUses: 5 }),
    sa("sa_stock", "Audit stock reservation", { tool: "s3", model: "haiku", status: "completed", started: T0 - 40 * MIN, ended: T0 - 34 * MIN, tokens: 17000, toolUses: 6, delivery: "sent", last: "Reservation expiry and Release are fine." }),
  ];
  const spawn = (id, sid, description) => ({ ...tool(id, "mcp__board__spawn_subagent", { description, prompt: description + "." }, "Started."), subagent: sid });
  Object.assign(subItems, {
    "c_audit/sa_pay": [
      say("I'll start with the retry loop, then the webhook."),
      tool("p1", "Read", { file_path: D.CO + "/internal/payments/retry.go" }, "…"),
      tool("p1b", "Grep", { pattern: "IdempotencyKey" }, "internal/payments/charge.go:57\\ninternal/payments/retry.go:23"),
      spawn("p2", "sa_pay_hook", "Trace the Stripe webhook handler"),
      say("The retry loop reuses the idempotency key, as it should. The webhook handler is being traced: I am waiting for that."),
    ],
    "c_audit/sa_pay_hook": [say("Reading the handler."), tool("w1", "Read", { file_path: D.CO + "/internal/payments/webhook.go" }, "…"), tool("w2", "Grep", { pattern: "VerifySignature" }, "2 matches")],
    "c_audit/sa_cart": [tool("c1", "Read", { file_path: D.CO + "/internal/cart/coupon.go" }, "…"), say("One real bug: ApplyCoupon allocates over a map.")],
    "c_audit/sa_stock": [tool("k1", "Read", { file_path: D.CO + "/internal/inventory/reserve.go" }, "…"), say("Reservation expiry and Release are fine.")],
  });

  // ---- two other machines, each with a tree of its own
  const remote = (id, name, address, lists) => addServer({ id, name, address, state: "connected", version: "1.8.2" }, { lists });
  remote("s_build", "Build box", "https://build-box.example:4790", { agents: ["claude", "cursor"], catalogs: { claude, cursor }, home: "/home/ci", defaultCwd: "/home/ci/checkout-service" });
  remote("s_lab", "Home lab", "https://home-lab.example:4790", { agents: ["claude", "pi"], catalogs: { claude, pi: catalogs.pi }, home: "/home/dev", defaultCwd: "/home/dev/projects" });
  const there = (cwd) => ({ cwd, usage: used(30000, 1) });
  onServer("s_build", () => {
    groups.push({ id: "g_nightly", name: "Nightly builds" }, { id: "g_rel", name: "Releases" });
    boards.b_runners = { id: "b_runners", name: "Runner layout", group: "g_nightly", created: iso(T0 - 4000 * MIN) };
    scenes.b_runners = { rev: 1, scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} } };
    add("c_nightly", "Why did last night's build fail?", { group: "g_nightly" }, 50, [{ kind: "user", text: "Last night's build of checkout-service failed on the linux runner. Why?" },
      say("Let me read the end of the build log."),
      tool("n1", "Bash", { command: "tail -n 40 /var/log/ci/nightly-1280.log", description: "Read the end of the build log" }, "…\\nwaiting for postgres… 118s\\nerror: timeout after 120s"),
      say("The **integration** job timed out waiting for Postgres: the service container reported healthy before the migrations had finished. Raising the timeout would only hide it, so I'll wait for the \`schema_migrations\` table instead of the port."),
      tool("n2", "Edit", { file_path: "/home/ci/checkout-service/.ci/integration.sh",
        old_string: "until pg_isready -h localhost; do sleep 1; done",
        new_string: "until psql -h localhost -tAc \\"select 1 from schema_migrations limit 1\\" >/dev/null 2>&1; do sleep 1; done" }, "The file /home/ci/checkout-service/.ci/integration.sh has been updated successfully."),
      tool("n3", "Bash", { command: ".ci/integration.sh --dry-run", description: "Dry-run the integration job" }, "migrations ready after 14s\\nintegration: 212 passed"),
      say("Done, on this machine. The job now waits for the migrations, not the port: the dry run passed after 14 s. The change is in the working tree of /home/ci/checkout-service, not committed."), { kind: "end" }], { cwd: "/home/ci/checkout-service", usage: used(34000, 1) });
    add("c_cache", "Cache the Go modules", { group: "g_nightly" }, 700, THREADS.ci, { ...cursorChat, cwd: "/home/ci/checkout-service", usage: used(12000, 1) });
    add("c_rel", "Tag the 2.4 release", { group: "g_rel" }, 1500, THREADS.push, { cwd: "/home/ci/checkout-service", usage: used(8000, 1) });
  });
  onServer("s_lab", () => {
    groups.push({ id: "g_exp", name: "Experiments" });
    boards.b_net = { id: "b_net", name: "Network map", group: "g_exp", created: iso(T0 - 5000 * MIN) };
    scenes.b_net = { rev: 1, scene: { type: "excalidraw", version: 2, elements: [], appState: {}, files: {} } };
    add("c_ingest", "Tune the ingest worker", { board: "b_net" }, 120, THREADS.regex, { ...piChat, cwd: "/home/dev/projects", usage: used(15000, 1) });
  });
  resync();
  return 1;`;
}

/** The prompt library of this computer. */
export const LIBRARY = {
  groups: [
    { id: "g_git", name: "git", parent: "" }, { id: "g_review", name: "review", parent: "" }, { id: "g_writing", name: "writing", parent: "" },
    { id: "g_git_pr", name: "pull requests", parent: "g_git" },
  ],
  prompts: [
    { id: "p_commit", name: "Commit message", parent: "g_git", text: "Write a commit message for the staged changes.\n\n- Subject line in the imperative, at most 60 characters.\n- A short body that says why, not what.\n- No emoji." },
    { id: "p_conflict", name: "Resolve merge conflicts", parent: "g_git", text: "Resolve the merge conflicts in the working tree. Keep both sides' intent, run the tests, and list what you decided for each file." },
    { id: "p_pr", name: "Pull request description", parent: "g_git_pr", text: "Write a pull request description for this branch.\n\n## What changed\nOne short paragraph, then bullets for the notable parts.\n\n## Why\nThe problem this solves, and the ticket if there is one.\n\n## How to test\nThe exact commands to run, and what to look at by hand.\n\n## Risks\nAnything a reviewer should look at twice: migrations, flags, public API." },
    { id: "p_pr_title", name: "PR title", parent: "g_git_pr", text: "Suggest three titles for this pull request, under 70 characters each." },
    { id: "p_review", name: "Review this diff", parent: "g_review", text: "Review the diff on this branch. Report correctness bugs first, then risks, then nits. Quote the line for each point." },
    { id: "p_sec", name: "Security pass", parent: "g_review", text: "Look at this change for security problems: injection, missing authorisation checks, secrets in code, unsafe deserialisation." },
    { id: "p_tests", name: "Find missing tests", parent: "g_review", text: "List the behaviours of this change that no test covers, most important first." },
    { id: "p_new", name: "Explain to a newcomer", parent: "g_writing", text: "Explain this code to someone who joined the team today. Start with what it is for, then how it works." },
    { id: "p_notes", name: "Release notes", parent: "g_writing", text: "Write release notes from the commits since the last tag. Group them by user-visible effect." },
    { id: "p_scratch", name: "Rubber duck", parent: "", text: "Ask me questions one at a time until the problem is clear. Do not suggest a fix yet." },
  ],
};
