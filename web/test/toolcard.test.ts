import { test } from "node:test";
import assert from "node:assert/strict";
import type { Item } from "../src/types.ts";
import type { DiffRow } from "../src/logic/linediff.ts";
import { ARRIVING, CUT_OFF, EDITS, cardParts, cardRow, cardState, clipRows, clipText, hintBeside, leftText, readPartial, shownParts, shownPath, type Part } from "../src/logic/toolcard.ts";

const tool = (name: string, input?: unknown, result?: string, more: Partial<Item> = {}): Item => ({ kind: "tool", toolId: "t", name, input, ...(result === undefined ? {} : { result }), ...more });
const WHERE = { cwd: "/Users/demo/projects/shop", home: "/Users/demo" };
const SUM = "/Users/demo/projects/shop/internal/calc/sum.go";
const OLD = "func Sum(xs []int) int {\n\ttotal := 0\n\tfor _, x := range xs {\n\t\ttotal += x\n\t}\n\treturn total\n}", NEW = OLD.replace("total += x", "total += x * 2");

/** The parts in short: "path internal/calc/sum.go +1 -1", "text Command", "change Change +1 -1", "note …". */
const brief = (parts: Part[]) => parts.map((p) => {
  if (p.part === "path") return `path ${p.path}${p.added === undefined ? "" : ` +${p.added} -${p.removed}`}${p.lines === undefined ? "" : ` ${p.lines} lines`}`;
  if (p.part === "text") return `text ${p.title}${p.failed ? " (failed)" : ""}`;
  if (p.part === "change") return `change ${p.title} +${p.diff.added} -${p.diff.removed}`;
  return `note ${p.text}`;
});
const parts = (item: Item, live = true) => cardParts(item, live, WHERE);
const textOf = (ps: Part[], title: string) => { const p = ps.find((x) => x.part === "text" && x.title === title); return p?.part === "text" ? p : undefined; };
const rows = (ps: Part[], n = 0) => { const p = ps.filter((x) => x.part === "change")[n]; return p?.part === "change" ? p.diff.rows.map((r: DiffRow) => (r.kind === "skip" ? `@${r.count}` : (r.kind === "same" ? " " : r.kind === "del" ? "-" : "+") + r.text)) : []; };

// ---- the kind and the closed row

test("the kind of a card, by the tool's name, for the three agents", () => {
  const kind = (name: string, input: unknown) => cardRow(tool(name, input, ""), true).kind;
  assert.equal(kind("Bash", { command: "ls" }), "shell");
  assert.equal(kind("bash", { command: "ls" }), "shell");
  assert.equal(kind("powershell", { command: "dir" }), "shell");
  assert.equal(kind("Edit", { file_path: SUM, old_string: "a", new_string: "b" }), "edit");
  assert.equal(kind("MultiEdit", { file_path: SUM, edits: [] }), "edit");
  assert.equal(kind("edit", { path: "sum.go", edits: [{ oldText: "a", newText: "b" }] }), "edit");
  assert.equal(kind("Edit", { file_path: SUM }), "edit", "Cursor's edit of before: the path alone");
  assert.equal(kind("Write", { file_path: SUM, content: "x" }), "write");
  assert.equal(kind("write", { path: "doc.go", content: "x" }), "write");
  assert.equal(kind("Delete", { file_path: SUM }), "delete");
  for (const [name, input] of [["Read", { file_path: SUM }], ["NotebookEdit", { notebook_path: "/n.ipynb", new_source: "x" }], ["Grep", { pattern: "x" }],
    ["mcp__board__get_run", {}], ["Delete `/x/old.go`", { path: "/x/old.go" }], ["Update todos", { todos: [] }], ["BASH", { command: "ls" }], ["toString", { command: "ls" }]] as const) {
    assert.equal(kind(name, input), "other", name);
  }
});

test("a call whose input lacks what its kind is read by is any other tool's card", () => {
  for (const item of [tool("Bash", {}), tool("Bash", { command: "" }), tool("Bash", { command: "  \n" }), tool("Bash", { command: 5 }), tool("Bash", { cmd: "ls" }), tool("Bash"), tool("Bash", "ls"), tool("Bash", ["ls"]),
    tool("Edit", { old_string: "a", new_string: "b" }), tool("Edit", { file_path: "" }), tool("Edit", { file_path: { a: 1 } }), tool("Write", { content: "x" }), tool("Delete", { path: 3 }), tool("Delete", {})]) {
    assert.equal(cardRow(item, true).kind, "other", JSON.stringify(item));
    assert.equal(cardRow(item, true).hint, "");
    assert.equal(parts(item)[0].part, "text", "its input shows as it is");
  }
  assert.equal(textOf(parts(tool("Bash", { cmd: "ls" }, "x")), "Bash")?.text, '{\n  "cmd": "ls"\n}');
});

test("the closed row's line: a command's first line, or the file's path", () => {
  const hint = (item: Item) => cardRow(item, true, WHERE).hint;
  assert.equal(hint(tool("Bash", { command: "go test ./internal/calc/\n", description: "Run the calc tests" })), "go test ./internal/calc/");
  assert.equal(hint(tool("Bash", { command: "go vet ./... &&\n  go test ./internal/calc/ -run TestSum" })), "go vet ./... && …", "more lines follow");
  assert.equal(hint(tool("bash", { command: "\n\n  ls -la  \n\n" })), "ls -la", "the first line that says something");
  const long = hint(tool("Bash", { command: "echo " + "x".repeat(500) + "\nsecond" }));
  assert.deepEqual([long.length, long.endsWith("x…")], [160, true]);
  assert.equal(hint(tool("Edit", { file_path: SUM, old_string: OLD, new_string: NEW })), "internal/calc/sum.go");
  assert.equal(hint(tool("edit", { path: "internal/calc/sum.go", edits: [] })), "internal/calc/sum.go");
  assert.equal(hint(tool("Write", { file_path: "/Users/demo/notes/todo.md", content: "x" })), "~/notes/todo.md");
  assert.equal(hint(tool("Delete", { file_path: "/etc/hosts" })), "/etc/hosts");
  assert.equal(hint(tool("Read", { file_path: SUM })), "");
  assert.equal(cardRow(tool("Edit", { file_path: SUM }), true).hint, SUM, "with no folder and no home known: the path as it is");
});

test("a path: from the chat's folder, else with the home as ~, else as it is", () => {
  assert.equal(shownPath(SUM, WHERE), "internal/calc/sum.go");
  assert.equal(shownPath(SUM, { cwd: "/Users/demo/projects/shop/", home: "/Users/demo" }), "internal/calc/sum.go");
  assert.equal(shownPath("/Users/demo/projects/shop-two/a.go", WHERE), "~/projects/shop-two/a.go", "a folder that only begins alike is another folder");
  assert.equal(shownPath("/Users/demo/projects/shop", WHERE), "~/projects/shop");
  assert.equal(shownPath("/tmp/a.go", WHERE), "/tmp/a.go");
  assert.equal(shownPath("internal/calc/sum.go", WHERE), "internal/calc/sum.go");
  assert.equal(shownPath(SUM), SUM);
});

test("the line stands beside the label unless the label says all of it", () => {
  assert.equal(hintBeside("Run the calc tests", "go test ./internal/calc/"), "go test ./internal/calc/");
  assert.equal(hintBeside("Ran `ls -la`", "ls -la"), "");
  assert.equal(hintBeside("Ran `ls -la`", "ls   -la"), "", "the label writes blanks as one space");
  assert.equal(hintBeside("Ran `go vet ./... && go test ./internal/calc/ -r…`", "go vet ./... && …"), "", "the label goes on with the next line");
  assert.equal(hintBeside("Vet, then one test", "go vet ./... && …"), "go vet ./... && …");
  assert.equal(hintBeside("Ran `go test ./internal/calc/ -run TestSum -coun…`", "go test ./internal/calc/ -run TestSum -count=1"), "go test ./internal/calc/ -run TestSum -count=1");
  assert.equal(hintBeside("Edited sum.go", "internal/calc/sum.go"), "internal/calc/sum.go");
  assert.equal(hintBeside("Edited sum.go", "sum.go"), "");
  assert.equal(hintBeside("Read the run", ""), "");
});

// ---- the open card

test("a shell card: the command with its description, then the output", () => {
  const ps = parts(tool("Bash", { command: "go vet ./... &&\n  go test ./internal/calc/", description: "Vet, then test" }, "ok  \tcalc\t0.4s"));
  assert.deepEqual(brief(ps), ["text Command", "text Output"]);
  assert.deepEqual(textOf(ps, "Command"), { part: "text", title: "Command", text: "go vet ./... &&\n  go test ./internal/calc/", lead: "Vet, then test", lang: "bash" });
  assert.deepEqual(textOf(ps, "Output"), { part: "text", title: "Output", text: "ok  \tcalc\t0.4s", failed: false });
  // Cursor's and Pi's give no description; powershell has no colours
  assert.deepEqual(textOf(parts(tool("bash", { command: "ls" }, "a")), "Command"), { part: "text", title: "Command", text: "ls", lang: "bash" });
  assert.deepEqual(textOf(parts(tool("powershell", { command: "dir" }, "a")), "Command"), { part: "text", title: "Command", text: "dir" });
});

test("what else an input holds is one line: nothing of it is hidden", () => {
  assert.deepEqual(brief(parts(tool("Bash", { command: "npm run watch", description: "Rebuild on change", timeout: 120000, run_in_background: true }, "started"))),
    ["text Command", "note timeout: 120000 · run_in_background: true", "text Output"]);
  assert.deepEqual(brief(parts(tool("bash", { command: "ls", timeout: 120 }, "a"))), ["text Command", "note timeout: 120", "text Output"]);
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, old_string: "a", new_string: "b", replace_all: false, note: "why\n it  changed" }, "ok"))),
    ["path internal/calc/sum.go +1 -1", "change Change +1 -1", "note note: why it changed"]);
  assert.deepEqual(brief(parts(tool("Write", { file_path: SUM, content: "x", mode: { octal: "644" } }, "ok"))), ["path internal/calc/sum.go 1 lines", "text Content", 'note mode: {"octal":"644"}']);
  assert.deepEqual(brief(parts(tool("Delete", { file_path: SUM, old_string: "x", recursive: null }, ""))), ["path internal/calc/sum.go +0 -1", "change Deleted +0 -1", "note recursive: null"]);
  // a field the card would draw, of a type it cannot: told with the rest
  assert.deepEqual(brief(parts(tool("Bash", { command: "ls", description: { text: "x" } }, "a"))), ["text Command", 'note description: {"text":"x"}', "text Output"]);
  assert.deepEqual(brief(parts(tool("Write", { file_path: SUM, content: 5 }, "ok"))), ["path internal/calc/sum.go", "note The content was not recorded.", "note content: 5"]);
  // a long value is cut, and so is a long list of fields
  const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, "v".repeat(i === 0 ? 200 : 2)]));
  const line = brief(parts(tool("Bash", { command: "ls", ...many }, "a")))[1];
  assert.equal(line, `note k0: ${"v".repeat(59)}… · k1: vv · k2: vv · k3: vv · k4: vv · k5: vv · …`);
  // not while the input arrives: a number may be half-way
  assert.deepEqual(brief(parts({ kind: "tool", toolId: "x", name: "Bash", partial: '{"command": "sleep 1", "timeout": 12' })), ["text Command", `note ${ARRIVING}`, "note Still running: no output yet."]);
});

test("a failed command marks its output", () => {
  const ps = parts(tool("Bash", { command: "go test" }, "FAIL\nExit code 1", { isError: true }));
  assert.deepEqual(brief(ps), ["text Command", "text Output (failed)"]);
});

test("an edit card: the path, the lines added and removed, the change with lines around", () => {
  const ps = parts(tool("Edit", { file_path: SUM, old_string: OLD, new_string: NEW }, "The file has been updated successfully."));
  assert.deepEqual(brief(ps), ["path internal/calc/sum.go +1 -1", "change Change +1 -1"]);
  assert.deepEqual(ps[0], { part: "path", path: "internal/calc/sum.go", full: SUM, added: 1, removed: 1 });
  assert.deepEqual(rows(ps), [" func Sum(xs []int) int {", " \ttotal := 0", " \tfor _, x := range xs {", "-\t\ttotal += x", "+\t\ttotal += x * 2", " \t}", " \treturn total", " }"]);
  // every occurrence
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, old_string: "total", new_string: "sum", replace_all: true }, "ok"))), ["path internal/calc/sum.go +1 -1", "change Change · every occurrence +1 -1"]);
});

test("one block per edit: Claude's MultiEdit, Pi's edits, and Pi's pair of before", () => {
  const multi = parts(tool("MultiEdit", { file_path: SUM, edits: [{ old_string: "Sum adds", new_string: "Sum doubles and adds" }, { old_string: "a\nb", new_string: "a\nB\nc", replace_all: true }] }, "ok"));
  assert.deepEqual(brief(multi), ["path internal/calc/sum.go +3 -2", "change Edit 1 of 2 +1 -1", "change Edit 2 of 2 · every occurrence +2 -1"]);
  const pi = parts(tool("edit", { path: "internal/calc/sum.go", edits: [{ oldText: OLD, newText: NEW }, { oldText: "Sum adds", newText: "Sum doubles and adds" }] }, "Successfully replaced 2 block(s)."));
  assert.deepEqual(brief(pi), ["path internal/calc/sum.go +2 -2", "change Edit 1 of 2 +1 -1", "change Edit 2 of 2 +1 -1"]);
  assert.deepEqual(rows(pi, 1), ["-Sum adds", "+Sum doubles and adds"]);
  assert.deepEqual(brief(parts(tool("edit", { path: "internal/calc/sum.go", oldText: "x * 2", newText: "2 * x" }, "ok"))), ["path internal/calc/sum.go +1 -1", "change Change +1 -1"]);
  // a list with nothing to read in it falls back on the pair beside it
  assert.deepEqual(brief(parts(tool("edit", { path: "a.go", edits: [5, null, {}], oldText: "a", newText: "b" }, "ok"))), ["path a.go +1 -1", "change Change +1 -1"]);
});

test("a Cursor edit: its texts, a new file, an edit of before the texts were kept, texts left out", () => {
  const file = "package calc\n\n" + OLD + "\n";
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, old_string: file, new_string: file.replace("total += x", "total += x * 2") }, ""))), ["path internal/calc/sum.go +1 -1", "change Change +1 -1"]);
  const fresh = parts(tool("Edit", { file_path: SUM, new_string: "package calc\n\nfunc Two() {}\n" }, ""));
  assert.deepEqual(brief(fresh), ["path internal/calc/sum.go +3 -0", "change Change +3 -0"]);
  assert.deepEqual(rows(fresh), ["+package calc", "+", "+func Two() {}"]);
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM }, ""))), ["path internal/calc/sum.go", "note The change was not recorded."]);
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, texts_omitted: true }, ""))), ["path internal/calc/sum.go", "note The change was too large to keep: its texts were left out."]);
});

test("an edit that changes no line says so", () => {
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, old_string: "a\n", new_string: "a" }, "ok"))), ["path internal/calc/sum.go +0 -0", "note Change: no line differs."]);
  assert.deepEqual(brief(parts(tool("MultiEdit", { file_path: SUM, edits: [{ old_string: "a", new_string: "a" }, { old_string: "a", new_string: "b" }] }, "ok"))),
    ["path internal/calc/sum.go +1 -1", "note Edit 1 of 2: no line differs.", "change Edit 2 of 2 +1 -1"]);
});

test("the edits of one card share the bound of the comparison", () => {
  const side = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} ${i}`).join("\n");
  const e = (n: number) => ({ old_string: side("old", n), new_string: side("new", n) });
  const ps = parts(tool("MultiEdit", { file_path: SUM, edits: [e(800), e(800), e(10)] }, "ok"));
  assert.deepEqual(brief(ps), ["path internal/calc/sum.go +1610 -1610", "change Edit 1 of 3 +800 -800", "change Edit 2 of 3 · too large to compare line by line +800 -800", "change Edit 3 of 3 +10 -10"],
    "the second is over what the first left; the third fits in it");
});

test("a write card: the path, how many lines, the content", () => {
  const ps = parts(tool("Write", { file_path: SUM, content: "package calc\n\nfunc Two() {}\n" }, "File created successfully"));
  assert.deepEqual(brief(ps), ["path internal/calc/sum.go 3 lines", "text Content"]);
  assert.equal(textOf(ps, "Content")?.text, "package calc\n\nfunc Two() {}\n");
  assert.deepEqual(brief(parts(tool("write", { path: "doc.go", content: "// one line" }, "ok"))), ["path doc.go 1 lines", "text Content"]);
  assert.deepEqual(brief(parts(tool("Write", { file_path: SUM, content: "" }, "ok"))), ["path internal/calc/sum.go", "note The file is empty."]);
  assert.deepEqual(brief(parts(tool("Write", { file_path: SUM }, "ok"))), ["path internal/calc/sum.go", "note The content was not recorded."]);
});

test("a delete card: the path, and the deleted text as removed lines when the item has it", () => {
  const ps = parts(tool("Delete", { file_path: SUM, old_string: "package calc\n\nfunc Old() {}\n" }, ""));
  assert.deepEqual(brief(ps), ["path internal/calc/sum.go +0 -3", "change Deleted +0 -3"]);
  assert.deepEqual(rows(ps), ["-package calc", "-", "-func Old() {}"]);
  assert.deepEqual(brief(parts(tool("Delete", { file_path: SUM }, ""))), ["path internal/calc/sum.go", "note The deleted text was not recorded."]);
  assert.deepEqual(brief(parts(tool("Delete", { file_path: SUM, old_string: "" }, ""))), ["path internal/calc/sum.go", "note The deleted text was not recorded."]);
  assert.deepEqual(brief(parts(tool("Delete", { file_path: SUM, texts_omitted: true }, ""))), ["path internal/calc/sum.go", "note The deleted text was too large to keep."]);
});

test("any other tool: its name, its input as JSON, its result", () => {
  const ps = parts(tool("mcp__board__get_task", { id: "T11" }, "T11 [verify]"));
  assert.deepEqual(ps, [{ part: "text", title: "get_task", text: '{\n  "id": "T11"\n}' }, { part: "text", title: "Result", text: "T11 [verify]", failed: false }]);
  assert.deepEqual(brief(parts(tool("Read", { file_path: SUM }, "no such file", { isError: true }))), ["text Read", "text Result (failed)"]);
  assert.deepEqual(brief(parts(tool("Grep", { pattern: "x" }, ""))), ["text Grep", "note No result."]);
});

test("a file card tells its result only when the call failed", () => {
  assert.deepEqual(brief(parts(tool("Edit", { file_path: SUM, old_string: "a", new_string: "b" }, "String to replace not found in file.", { isError: true }))),
    ["path internal/calc/sum.go +1 -1", "change Change +1 -1", "text Result (failed)"]);
  assert.deepEqual(brief(parts(tool("write", { path: "a.go", content: "x" }, "EACCES", { isError: true }))), ["path a.go 1 lines", "text Content", "text Result (failed)"]);
  assert.deepEqual(brief(parts(tool("Delete", { file_path: SUM }, "busy", { isError: true }))), ["path internal/calc/sum.go", "note The deleted text was not recorded.", "text Result (failed)"]);
});

// ---- what is missing

test("a call's state: running, denied, stopped with its subagent, done", () => {
  assert.equal(cardState(tool("Bash", { command: "ls" }), true), "running");
  assert.equal(cardState(tool("Bash", { command: "ls" }), false), "stopped");
  assert.equal(cardState(tool("Bash", { command: "ls" }, undefined, { denied: true }), true), "denied");
  assert.equal(cardState(tool("Bash", { command: "ls" }, ""), true), "done");
  assert.equal(cardState(tool("Bash", { command: "ls" }, "x", { denied: true }), false), "denied");
});

test("a card with no result shows what it has and says what is missing", () => {
  const bash = { command: "go test ./..." }, edit = { file_path: SUM, old_string: "a", new_string: "b" };
  const last = (item: Item, live = true) => brief(parts(item, live)).at(-1);
  // still running
  assert.deepEqual(brief(parts(tool("Bash", bash))), ["text Command", "note Still running: no output yet."]);
  assert.deepEqual(brief(parts(tool("Edit", edit))), ["path internal/calc/sum.go +1 -1", "change Change +1 -1", "note Still running: no result yet."]);
  assert.equal(last(tool("Read", { file_path: SUM })), "note Still running: no result yet.");
  // denied
  assert.equal(last(tool("Bash", bash, undefined, { denied: true })), "note Denied: the command did not run.");
  assert.equal(last(tool("Edit", edit, undefined, { denied: true })), "note Denied: the file was not changed.");
  assert.equal(last(tool("Write", { file_path: SUM, content: "x" }, undefined, { denied: true })), "note Denied: the file was not changed.");
  assert.equal(last(tool("Delete", { file_path: SUM }, undefined, { denied: true })), "note Denied: the file was not changed.");
  assert.equal(last(tool("WebFetch", { url: "https://x" }, undefined, { denied: true })), "note Denied: the tool did not run.");
  // its subagent ended before the result
  assert.equal(last(tool("Bash", bash), false), "note Stopped before the command gave its output.");
  assert.equal(last(tool("Edit", edit), false), "note Stopped before it gave a result: the file may not be changed.");
  assert.equal(last(tool("Read", { file_path: SUM }), false), "note Stopped before it gave a result.");
  // ended with no result: closed by a copy of the thread, or a command that said nothing
  assert.equal(last(tool("Bash", bash, "", { isError: true })), "note Ended with no output.");
  assert.equal(last(tool("Bash", bash, "")), "note No output.");
  assert.equal(last(tool("Edit", edit, "", { isError: true })), "note Ended with no result: the file may not be changed.");
  assert.equal(last(tool("Edit", edit, "")), "change Change +1 -1", "a Cursor edit's result is always empty: nothing is missing");
  assert.equal(last(tool("Read", { file_path: SUM }, "", { isError: true })), "note Ended with no result.");
});

test("an item with nothing but its id, and one with no input", () => {
  assert.deepEqual(parts({ kind: "tool", toolId: "i3" }), [{ part: "text", title: "tool", text: "" }, { part: "note", text: "The input was not recorded." }, { part: "note", text: "Still running: no result yet." }]);
  assert.deepEqual(cardRow({ kind: "tool", toolId: "i3" }, true), { kind: "other", state: "running", hint: "" });
  assert.deepEqual(brief(parts(tool("Bash", undefined, "", { isError: true }))), ["text Bash", "note The input was not recorded.", "note Ended with no result."]);
  assert.equal(textOf(parts(tool("mcp__board__get_run", {}, "ok")), "get_run")?.text, "{}", "an empty input is an input");
});

test("an input that is still arriving is read as far as it came", () => {
  const partial = '{"file_path": "/Users/demo/projects/shop/internal/calc/doc.go", "content": "// Package calc adds num';
  const item: Item = { kind: "tool", toolId: "i5", name: "Write", partial };
  assert.deepEqual(cardRow(item, true, WHERE), { kind: "write", state: "running", hint: "internal/calc/doc.go" });
  assert.deepEqual(brief(parts(item)), ["path internal/calc/doc.go 1 lines", "text Content", `note ${ARRIVING}`, "note Still running: no result yet."]);
  assert.equal(textOf(parts(item), "Content")?.text, "// Package calc adds num");
  // closed by a copy of the thread before the input was whole
  assert.deepEqual(brief(parts({ ...item, result: "", isError: true })), ["path internal/calc/doc.go 1 lines", "text Content", `note ${CUT_OFF}`, "note Ended with no result: the file may not be changed."]);
  // a command half-way
  assert.deepEqual(brief(parts({ kind: "tool", toolId: "x", name: "Bash", partial: '{"command": "curl -s' })), ["text Command", `note ${ARRIVING}`, "note Still running: no output yet."]);
  // nothing readable yet: the text itself, under the tool's name
  const raw: Item = { kind: "tool", toolId: "x", name: "Write", partial: '{"file_pa' };
  assert.deepEqual(parts(raw), [{ part: "text", title: "Write", text: '{"file_pa' }, { part: "note", text: ARRIVING }, { part: "note", text: "Still running: no result yet." }]);
  assert.equal(cardRow(raw, true).kind, "other");
  // any other tool's input shows as the text that came: closed, its number would be a wrong one
  const sleep: Item = { kind: "tool", toolId: "x", name: "mcp__x__wait", partial: '{"seconds": 12' };
  assert.deepEqual(parts(sleep)[0], { part: "text", title: "mcp__x__wait", text: '{"seconds": 12' });
  // the input, once it is there, is what counts: the item still carries the streamed text
  assert.deepEqual(brief(parts({ ...item, input: { file_path: SUM, content: "a\nb\n" }, result: "ok" })), ["path internal/calc/sum.go 2 lines", "text Content"]);
  // a partial that is whole JSON is the input
  assert.deepEqual(brief(parts({ kind: "tool", toolId: "x", name: "Bash", partial: '{"command":"ls"}', result: "a" })), ["text Command", "text Output"]);
});

test("a streamed input is closed where it stops", () => {
  const read = (s: string) => readPartial(s)?.value;
  assert.deepEqual(readPartial('{"command":"ls"}'), { value: { command: "ls" }, whole: true });
  assert.deepEqual(readPartial('{"command": "curl -s'), { value: { command: "curl -s" }, whole: false });
  assert.deepEqual(read('{"file_path": "/x/a.go", "content": "a\\nb'), { file_path: "/x/a.go", content: "a\nb" });
  assert.deepEqual(read('{"file_path": "/x/a.go", "content": "a\\'), { file_path: "/x/a.go", content: "a" }, "an escape cut in two");
  assert.deepEqual(read('{"content": "a\\\\'), { content: "a\\" }, "a whole escaped backslash stays");
  assert.deepEqual(read('{"content": "caf\\u00e'), { content: "caf" });
  assert.deepEqual(read('{"file_path": "/x/a.go"'), { file_path: "/x/a.go" });
  assert.deepEqual(read('{"file_path": "/x/a.go", "con'), { file_path: "/x/a.go" }, "a field that stops in its name is left out");
  assert.deepEqual(read('{"file_path": "/x/a.go", "content":'), { file_path: "/x/a.go" });
  assert.deepEqual(read('{"path": "a.go", "edits": [{"oldText": "a", "newText": "b'), { path: "a.go", edits: [{ oldText: "a", newText: "b" }] });
  assert.deepEqual(read('{"path": "a.go", "edits": [{"oldText": "a"}'), { path: "a.go", edits: [{ oldText: "a" }] });
  assert.deepEqual(read('{"command": "sleep 1", "timeout": 12'), { command: "sleep 1", timeout: 12 }, "a number is the digits that came");
  for (const s of ["", "{", '{"file_pa', '{"file_path":', "[1, 2", '"text', "nonsense"]) assert.equal(readPartial(s), null, s);
});

test("no item, however malformed, throws: every part is of a known shape with texts in it", () => {
  const junk: unknown[] = [undefined, null, 0, 5, "", "text", true, [], [1, "a"], {}, { a: { b: [1] } }];
  const names: unknown[] = [undefined, null, 7, {}, "", "Bash", "bash", "Edit", "MultiEdit", "edit", "Write", "write", "Delete", "Read", "constructor", "__proto__"];
  const fields = ["command", "description", "file_path", "path", "old_string", "new_string", "oldText", "newText", "content", "edits", "replace_all", "texts_omitted"];
  let n = 0;
  const hold = (item: Item) => {
    for (const live of [true, false]) {
      const row = cardRow(item, live, WHERE), ps = cardParts(item, live, WHERE);
      assert.equal(typeof row.hint, "string");
      assert.ok(ps.length > 0, "a card always shows something");
      for (const p of ps) {
        if (p.part === "path") assert.deepEqual([typeof p.path, typeof p.full], ["string", "string"]);
        else if (p.part === "text") assert.deepEqual([typeof p.title, typeof p.text, typeof (p.lead ?? "")], ["string", "string", "string"]);
        else if (p.part === "change") { assert.equal(typeof p.title, "string"); for (const r of p.diff.rows) assert.equal(typeof (r.kind === "skip" ? String(r.count) : r.text), "string"); }
        else assert.equal(typeof p.text, "string");
        clipRows(p.part === "change" ? p.diff.rows : []);
        if (p.part === "text") clipText(p.text);
      }
      shownParts(ps, false);
      n++;
    }
  };
  for (const name of names) {
    for (const v of junk) {
      hold({ kind: "tool", name, input: v } as Item);
      hold({ kind: "tool", name, partial: v, result: v, isError: v, denied: v } as Item);
      for (const f of fields) hold({ kind: "tool", name, input: { file_path: "/a", command: "ls", [f]: v }, result: v } as Item);
      hold({ kind: "tool", name, input: { path: "a", edits: [v, { oldText: v, newText: v }, { old_string: "a", new_string: v }] } } as Item);
    }
  }
  hold({ kind: "tool" } as Item);
  hold({} as Item);
  assert.ok(n > 4000);
  // a result that is no text is told as JSON, not handed on as it is
  assert.equal(textOf(cardParts({ kind: "tool", name: "Bash", input: { command: "ls" }, result: { code: 1 } } as unknown as Item, true), "Output")?.text, '{"code":1}');
});

// ---- what is kept out of the page

test("a short text is drawn whole", () => {
  assert.deepEqual(clipText("a\nb\n"), { head: "a\nb", tail: "", left: null });
  assert.deepEqual(clipText(""), { head: "", tail: "", left: null });
  const few = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n");
  assert.deepEqual(clipText(few + "\n"), { head: few, tail: "", left: null });
  assert.equal(clipText("x".repeat(2400)).left, null);
});

test("a long output is its first and last lines, and how many lie between", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `ok  \tpkg${String(i + 1).padStart(4, "0")}\t0.1s`), text = lines.join("\n");
  const c = clipText(text);
  assert.deepEqual(c.head.split("\n"), lines.slice(0, 8));
  assert.deepEqual(c.tail.split("\n"), lines.slice(-12));
  assert.equal(c.left?.lines, 3000 - 20);
  assert.equal(leftText(c.left!), "2,980 lines left out");
  assert.equal(c.head.length + c.left!.chars + c.tail.length, text.length, "the three parts are the text");
  assert.ok(c.head.length + c.tail.length < 2000, "what enters the page is small");
  // one line over the bound of whole lines
  const c25 = clipText(lines.slice(0, 25).join("\n") + "\n");
  assert.deepEqual([c25.head.split("\n").length, c25.tail.split("\n").length, leftText(c25.left!)], [8, 12, "5 lines left out"]);
});

test("a text of few long lines is cut by characters", () => {
  const one = "x".repeat(200_000), c = clipText(one);
  assert.deepEqual([c.head.length, c.tail.length, c.left], [800, 1200, { lines: 0, chars: 200_000 - 2000 }]);
  assert.equal(leftText(c.left!), "198,000 characters left out");
  // lines of 1,000 characters: the head and the tail hold what their characters allow
  const wide = Array.from({ length: 40 }, (_, i) => String(i).padStart(2, "0") + "y".repeat(998)).join("\n"), w = clipText(wide);
  assert.deepEqual([w.head.length, w.tail.length], [800, 1200]);
  assert.equal(w.head + wide.slice(800, wide.length - 1200) + w.tail, wide);
  assert.equal(w.left!.chars, wide.length - 2000);
  assert.ok(w.left!.lines >= 36 && w.left!.lines <= 38, `${w.left!.lines} whole lines between them`);
  // 20 short lines and then one long one: over the characters, under the lines
  const mixed = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") + "\n" + "z".repeat(5000), m = clipText(mixed);
  assert.deepEqual([m.head.split("\n").length, m.tail.length], [8, 1200]);
  assert.equal(m.head + mixed.slice(m.head.length, mixed.length - 1200) + m.tail, mixed);
});

test("a long change is its first and last rows; a long line is cut", () => {
  const row = (i: number): DiffRow => ({ kind: i % 2 ? "add" : "del", text: `row ${i}` });
  const thirty = Array.from({ length: 30 }, (_, i) => row(i));
  assert.deepEqual(clipRows(thirty), { head: thirty, tail: [], left: null });
  assert.deepEqual(clipRows([]), { head: [], tail: [], left: null });
  const many = Array.from({ length: 500 }, (_, i) => row(i)), c = clipRows(many);
  assert.deepEqual([c.head, c.tail, c.left], [many.slice(0, 18), many.slice(-8), { lines: 474, chars: 0 }]);
  assert.equal(leftText(c.left!), "474 lines left out");
  const long: DiffRow[] = [{ kind: "add", text: "x".repeat(5000) }, { kind: "skip", count: 9 }, { kind: "same", text: "short" }], l = clipRows(long);
  assert.deepEqual([l.head.length, (l.head[0] as { text: string }).text.length, l.head[1], l.head[2], l.left], [3, 401, long[1], long[2], { lines: 0, chars: 4600 }]);
  assert.equal(leftText(l.left!), "4,600 characters left out");
  assert.equal(leftText({ lines: 1, chars: 10 }), "1 line left out");
});

test("an open card draws its first edits, and says how many it has not drawn", () => {
  const edits = Array.from({ length: 30 }, (_, i) => ({ old_string: `a${i}`, new_string: `b${i}` }));
  const ps = parts(tool("MultiEdit", { file_path: SUM, edits }, "nope", { isError: true }));
  assert.equal(ps.length, 32);
  const few = shownParts(ps, false);
  assert.deepEqual([few.parts.length, few.left, EDITS], [14, 18, 12]);
  assert.deepEqual(brief(few.parts).filter((b) => !b.startsWith("change")), ["path internal/calc/sum.go +30 -30", "text Result (failed)"], "what is not a change stays");
  assert.equal(brief(few.parts)[12], "change Edit 12 of 30 +1 -1");
  assert.deepEqual(shownParts(ps, true), { parts: ps, left: 0 });
  const two = parts(tool("Edit", { file_path: SUM, old_string: "a", new_string: "b" }, "ok"));
  assert.deepEqual(shownParts(two, false), { parts: two, left: 0 });
});
