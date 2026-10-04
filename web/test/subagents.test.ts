import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fmtDuration, isSubagentTool, showReport, subActivity, subagentOf, subBadge, subDurationMs, subKey,
  subLine, subList, subModelLabel, subReport, subResultLine, subToolCount,
} from "../src/logic/subagents.ts";
import { quotable } from "../src/logic/quotes.ts";
import { chatTitle } from "../src/logic/labels.ts";
import type { Catalog, Item, Subagent } from "../src/types.ts";

const call = (extra: Partial<Item> = {}): Item => ({
  kind: "tool", name: "Agent", toolId: "t1",
  input: { description: "Count files", prompt: "Count the files", subagent_type: "general-purpose" },
  ...extra,
});
const sub = (extra: Partial<Subagent> = {}): Subagent => ({ id: "s1", tool: "t1", status: "running", ...extra });

test("isSubagentTool: Agent, Task, and mcp__board__spawn_subagent", () => {
  assert.equal(isSubagentTool({ kind: "tool", name: "Agent" }), true);
  assert.equal(isSubagentTool({ kind: "tool", name: "Task" }), true);
  assert.equal(isSubagentTool({ kind: "tool", name: "mcp__board__spawn_subagent" }), true);
  assert.equal(isSubagentTool({ kind: "tool", name: "Bash" }), false);
  assert.equal(isSubagentTool({ kind: "tool", name: "mcp__board__wait_subagents" }), false);
  assert.equal(isSubagentTool({ kind: "tool", name: "mcp__board__stop_subagent" }), false);
  assert.equal(isSubagentTool({ kind: "tool", name: "mcp__board__list_subagent_models" }), false);
  assert.equal(isSubagentTool({ kind: "perm", name: "Agent" }), false);
  assert.equal(isSubagentTool(undefined), false);
});

test("subKey", () => {
  assert.equal(subKey("c1", "s1"), "c1/s1");
});

test("subagentOf: linked uses the state, falling back to the input", () => {
  const it = call({ subagent: "s1" });
  const sa = subagentOf(it, { s1: sub({ status: "completed", model: "m", kind: "cursor", effort: "medium" }) }, false);
  assert.equal(sa.status, "completed");
  assert.equal(sa.model, "m");
  assert.equal(sa.kind, "cursor");
  assert.equal(sa.effort, "medium");
  assert.equal(sa.description, "Count files");
  assert.equal(sa.prompt, "Count the files");
  assert.equal(sa.type, "general-purpose");
  const own = subagentOf(it, { s1: sub({ description: "Own", prompt: "P", type: "Explore" }) }, false);
  assert.equal(own.description, "Own");
  assert.equal(own.prompt, "P");
  assert.equal(own.type, "Explore");
});

test("subagentOf: linked without its state, or unlinked, is built from the call", () => {
  for (const extra of [{ subagent: "s9" }, {}]) {
    const done = subagentOf(call({ ...extra, result: "ok" }), {}, true);
    assert.equal(done.status, "completed");
    assert.equal(done.error, undefined);
    assert.equal(done.tool, "t1");
    assert.equal(done.description, "Count files");
    assert.equal(done.kind, undefined);
    assert.equal(done.effort, undefined);
    assert.equal(done.model, undefined);
    const failed = subagentOf(call({ ...extra, result: "boom", isError: true }), undefined, true);
    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "boom");
    const denied = subagentOf(call({ ...extra, denied: true }), {}, true);
    assert.equal(denied.status, "failed");
    assert.equal(denied.error, "Denied");
    assert.equal(subagentOf(call(extra), {}, true).status, "running");
    assert.equal(subagentOf(call(extra), {}, false).status, "stopped");
  }
  assert.equal(subagentOf(call({ subagent: "s9" }), {}, true).id, "s9");
  assert.equal(subagentOf(call(), {}, true).id, "");
});

test("subBadge: null for the default type, else the type", () => {
  for (const t of ["general-purpose", "generalPurpose", "", undefined]) assert.equal(subBadge(t), null);
  assert.equal(subBadge("Explore"), "Explore");
  assert.equal(subBadge("file-counter"), "file-counter");
});

test("subActivity: running tool, progress, writing, thinking", () => {
  const bash: Item = { kind: "tool", name: "Bash", input: { command: "ls" } };
  assert.equal(subActivity(sub({ progress: "Reading files" }), [{ kind: "text", text: "hi", done: true }, bash]), "Running `ls`…");
  const finished: Item = { ...bash, result: "a\nb" };
  assert.equal(subActivity(sub({ progress: "Reading files" }), [finished]), "Reading files");
  assert.equal(subActivity(sub({ progress: "Reading files" })), "Reading files");
  assert.equal(subActivity(sub(), [finished, { kind: "text", text: "so", done: false }]), "Writing…");
  assert.equal(subActivity(sub(), [{ kind: "text", text: "so", done: true }]), "Thinking…");
  assert.equal(subActivity(sub(), [finished]), "Thinking…");
  assert.equal(subActivity(sub()), "Thinking…");
});

test("subLine: running is live", () => {
  assert.deepEqual(subLine(call(), sub({ progress: "Reading files" })), { text: "Reading files", tone: "live" });
});

test("subLine: completed, failed, stopped", () => {
  assert.deepEqual(subLine(call(), sub({ status: "completed", summary: "## Result\nfoo" })), { text: "Done · Result", tone: "muted" });
  assert.deepEqual(subLine(call(), sub({ status: "completed", background: true, last: "bar" })), { text: "Done · bar", tone: "muted" });
  assert.deepEqual(subLine(call(), sub({ status: "completed" })), { text: "Done", tone: "muted" });
  assert.deepEqual(subLine(call(), sub({ status: "failed", error: "It broke\nstack" })), { text: "It broke", tone: "error" });
  assert.deepEqual(subLine(call(), sub({ status: "failed" })), { text: "Failed", tone: "error" });
  assert.deepEqual(subLine(call(), sub({ status: "stopped" })), { text: "Stopped", tone: "muted" });
});

test("subResultLine: the subagent's name, final status and delivery state", () => {
  const done = sub({ status: "completed", description: "Count files" });
  assert.deepEqual(subResultLine({ ...done, delivery: "sent" }), { name: "Count files", text: "Done · sent to the agent", tone: "muted" });
  assert.deepEqual(subResultLine({ ...done, delivery: "owed" }), { name: "Count files", text: "Done · not sent yet", tone: "muted" });
  // No delivery on the record: the line says nothing about delivery.
  assert.deepEqual(subResultLine(done), { name: "Count files", text: "Done", tone: "muted" });
  assert.deepEqual(subResultLine(sub({ status: "stopped", delivery: "sent" })), { name: "Subagent", text: "Stopped · sent to the agent", tone: "muted" });
  assert.deepEqual(subResultLine(sub({ status: "failed", delivery: "owed" })), { name: "Subagent", text: "Failed · not sent yet", tone: "error" });
  // Owed after one failed attempt reads as owed; after two the result is given up.
  assert.deepEqual(subResultLine({ ...done, delivery: "retry" }), { name: "Count files", text: "Done · not sent yet", tone: "muted" });
  assert.deepEqual(subResultLine({ ...done, delivery: "given-up" }), { name: "Count files", text: "Done · could not be delivered", tone: "muted" });
  assert.deepEqual(subResultLine(sub({ status: "completed", error: "limit reached", delivery: "given-up" })),
    { name: "Subagent", text: "Done · ended with an error · could not be delivered", tone: "error" });
});

test("subResultLine: a delivery state this client does not know adds nothing", () => {
  const newer = { ...sub({ status: "completed", description: "Count files" }), delivery: "queued" } as unknown as Subagent;
  assert.deepEqual(subResultLine(newer), { name: "Count files", text: "Done", tone: "muted" });
  assert.deepEqual(subResultLine({ ...newer, error: "boom" }), { name: "Count files", text: "Done · ended with an error", tone: "error" });
});

test("subResultLine: says a result ended with an error", () => {
  // A subagent whose turn ended with an error is recorded as completed, with the error.
  assert.deepEqual(subResultLine(sub({ status: "completed", error: "API Error: overloaded", last: "half", delivery: "sent" })),
    { name: "Subagent", text: "Done · ended with an error · sent to the agent", tone: "error" });
  assert.deepEqual(subResultLine(sub({ status: "failed", error: "boom", delivery: "owed" })),
    { name: "Subagent", text: "Failed · ended with an error · not sent yet", tone: "error" });
  assert.deepEqual(subResultLine(sub({ status: "stopped", error: "process ended", delivery: "sent" })),
    { name: "Subagent", text: "Stopped · ended with an error · sent to the agent", tone: "error" });
});

test("subResultLine: before the chat's subagents are loaded", () => {
  assert.deepEqual(subResultLine(undefined), { name: "Subagent", text: "", tone: "muted" });
});

test("a result row is not a subagent tool, not quotable and not a chat title source", () => {
  const row: Item = { kind: "subresult", subagent: "s1" };
  assert.equal(isSubagentTool(row), false);
  assert.equal(quotable(row), undefined);
  assert.equal(quotable({ kind: "user" }), true);
  assert.equal(quotable({ kind: "text", done: true }), true);
  assert.equal(quotable({ kind: "text" }), false);
  for (const kind of ["tool", "perm", "note"] as const) assert.equal(quotable({ kind }), undefined);
  assert.equal(chatTitle({}, [row]), "New chat");
  assert.equal(chatTitle({}, [row, { kind: "user", text: "Count the files" }]), "Count the files");
  assert.equal(chatTitle({ name: "Named" }, [row]), "Named");
});

test("subReport / showReport", () => {
  const thread: Item[] = [{ kind: "text", text: "The answer is 4", done: true }];
  const same = sub({ status: "completed", summary: "The answer is 4" });
  assert.equal(showReport(call(), same, thread), false);
  const other = sub({ status: "completed", summary: "Found 4 files" });
  assert.equal(showReport(call(), other, thread), true);
  const fg = sub({ status: "completed" });
  assert.equal(subReport(call({ result: "Result text" }), fg, thread), "Result text");
  assert.equal(showReport(call({ result: "Result text" }), fg, thread), true);
  const bg = sub({ status: "completed", background: true });
  assert.equal(subReport(call({ result: "Async agent launched" }), bg, thread), "The answer is 4");
  assert.equal(showReport(call({ result: "Async agent launched" }), bg, thread), false);
  assert.equal(subReport(call(), sub({ status: "completed" })), "");
  assert.equal(showReport(call(), sub({ status: "completed" })), false);
});

test("subModelLabel", () => {
  const cursor: Catalog = {
    models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: ["low", "medium", "high"] }],
    default: { model: "gpt-5.4-mini" } as any,
  };
  assert.deepEqual(subModelLabel("gpt-5.4-mini-medium", "cursor", cursor), { model: "GPT-5.4 Mini", effort: "Medium" });
  assert.deepEqual(subModelLabel("gpt-9-turbo", "cursor", cursor), { model: "gpt-9-turbo" });
  assert.deepEqual(subModelLabel("gpt-5.4-mini", "cursor", cursor), { model: "GPT-5.4 Mini" });
  const claude: Catalog = {
    models: [
      { id: "sonnet", label: "Sonnet 5.5" },
      { id: "opus", label: "Opus 5.5" },
      { id: "haiku", label: "Haiku 4.5" },
    ],
    default: { model: "sonnet" } as any,
  };
  // a full id is not matched by family: only an exact catalog id is labelled, else the raw id
  assert.deepEqual(subModelLabel("claude-haiku-4-5-20251001", "claude", claude), { model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(subModelLabel("opus", "claude", claude), { model: "Opus 5.5" });
  assert.equal(subModelLabel(undefined, "claude", claude), null);
  const pi: Catalog = {
    models: [
      { id: "deepseek/deepseek-flash", label: "DeepSeek Flash" },
      { id: "anthropic/claude-sonnet", label: "Claude Sonnet" },
    ],
    default: { model: "deepseek/deepseek-flash" } as any,
  };
  // exact provider-qualified id
  assert.deepEqual(subModelLabel("deepseek/deepseek-flash", "pi", pi), { model: "DeepSeek Flash" });
  // unqualified id against the provider-qualified catalog id
  assert.deepEqual(subModelLabel("deepseek-flash", "pi", pi), { model: "DeepSeek Flash" });
  assert.deepEqual(subModelLabel("claude-sonnet", "pi", pi), { model: "Claude Sonnet" });
  // no suffix match: the raw id
  assert.deepEqual(subModelLabel("deepseek", "pi", pi), { model: "deepseek" });
  assert.deepEqual(subModelLabel("openrouter/x/flash", "pi", pi), { model: "openrouter/x/flash" });
  assert.equal(subModelLabel(undefined, "pi", pi), null);
  // cross-kind: parent would be claude; the sub's cursor catalog labels the id
  assert.deepEqual(subModelLabel("gpt-5.4-mini-medium", "cursor", cursor), { model: "GPT-5.4 Mini", effort: "Medium" });
  assert.deepEqual(subModelLabel("gpt-5.4-mini-medium", "claude", claude), { model: "gpt-5.4-mini-medium" });
  // no catalog / absent kind: raw id, never the parent kind's matching rules
  assert.deepEqual(subModelLabel("gpt-5.4-mini-medium", "cursor"), { model: "gpt-5.4-mini-medium" });
  assert.deepEqual(subModelLabel("claude-haiku-4-5-20251001", undefined, claude), { model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(subModelLabel("opus", undefined, claude), { model: "opus" });
  // sa.effort when the catalog match did not already produce one
  assert.deepEqual(subModelLabel("haiku", "claude", claude, "high"), { model: "Haiku 4.5", effort: "High" });
  assert.deepEqual(subModelLabel("claude-haiku-4-5-20251001", "claude", claude, "high"), { model: "claude-haiku-4-5-20251001", effort: "High" });
  assert.deepEqual(subModelLabel("deepseek-flash", "pi", pi, "low"), { model: "DeepSeek Flash", effort: "Low" });
  // catalog-parsed effort wins over sa.effort
  assert.deepEqual(subModelLabel("gpt-5.4-mini-medium", "cursor", cursor, "high"), { model: "GPT-5.4 Mini", effort: "Medium" });
});

test("subToolCount: max of toolUses and the thread's tools", () => {
  const thread: Item[] = [{ kind: "tool", name: "Bash" }, { kind: "text", text: "x" }, { kind: "tool", name: "Read" }];
  assert.equal(subToolCount(sub({ toolUses: 1 }), thread), 2);
  assert.equal(subToolCount(sub({ toolUses: 5 }), thread), 5);
  assert.equal(subToolCount(sub({ toolUses: 3 })), 3);
  assert.equal(subToolCount(sub()), 0);
});

test("subDurationMs", () => {
  assert.equal(subDurationMs(sub({ started: 1000 }), 5000), 4000);
  assert.equal(subDurationMs(sub({ started: 1000, ended: 3000 }), 9000), 2000);
  assert.equal(subDurationMs(sub(), 5000), null);
});

test("fmtDuration", () => {
  assert.equal(fmtDuration(0), "0s");
  assert.equal(fmtDuration(42000), "42s");
  assert.equal(fmtDuration(185000), "3m 05s");
  assert.equal(fmtDuration(3720000), "1h 02m");
});

test("subList: sorted by started, then id; nested included", () => {
  const list = subList({
    c: sub({ id: "c", started: 200 }),
    b: sub({ id: "b", started: 100, parent: "c" }),
    a: sub({ id: "a", started: 100 }),
  });
  assert.deepEqual(list.map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(subList(undefined), []);
});
