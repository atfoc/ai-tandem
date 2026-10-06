package runs

import (
	"strings"
	"testing"
)

func engBlockText(outcome, summary, report string) string {
	return "<result>\n<outcome>" + outcome + "</outcome>\n<summary>" + summary + "</summary>\n<report>\n" + report + "\n</report>\n</result>"
}

// The result block grammar on the cases the agent tests found (preamble, quoted tags, fences)
// and on what must not count as a block.
func TestResultGrammar(t *testing.T) {
	fence := "```"
	quoted := "The template is:\n\n" + fence + "xml\n<report>\nplaceholder\n</report>\n<result>pending</result>\n" + fence + "\n\nThat is all."
	cases := []struct {
		name string
		text string
		want *resultBlock
	}{
		{"the block alone", engBlockText("completed", "It works.", "All of it."),
			&resultBlock{"completed", "It works.", "All of it."}},
		{"a preamble, and white space after the block", "I am done.\n\nHere is the result:\n\n" + engBlockText("failed", "No tool.", "frobnicate is not installed.") + "\n\n  \n",
			&resultBlock{"failed", "No tool.", "frobnicate is not installed."}},
		{"compact, and white space inside the tags", "<result><outcome> completed </outcome><summary> s </summary><report> r </report></result>",
			&resultBlock{"completed", "s", "r"}},
		{"a report that quotes </report> and <result> in a fence", engBlockText("completed", "Quoted it.", quoted),
			&resultBlock{"completed", "Quoted it.", quoted}},
		{"a report that holds a whole block", engBlockText("completed", "outer", "It said:\n"+engBlockText("failed", "inner", "inner report")),
			&resultBlock{"completed", "outer", "It said:\n" + engBlockText("failed", "inner", "inner report")}},
		{"a summary that names the tags", engBlockText("completed", "The file has `<report>` and `<result>` elements.", "the body"),
			&resultBlock{"completed", "The file has `<report>` and `<result>` elements.", "the body"}},
		{"a block in a code fence before the real one",
			"The layout I was asked for is:\n\n" + fence + "\n" + engBlockText("completed", "two or three sentences", "the full report") + "\n" + fence + "\n\nAnd my result:\n\n" + engBlockText("failed", "Could not.", "Why not."),
			&resultBlock{"failed", "Could not.", "Why not."}},
		{"a report with a code fence", engBlockText("completed", "Added it.", "The code:\n\n"+fence+"go\nfunc f() {}\n"+fence+"\n\nand the test output."),
			&resultBlock{"completed", "Added it.", "The code:\n\n" + fence + "go\nfunc f() {}\n" + fence + "\n\nand the test output."}},

		{"text after the block", engBlockText("completed", "s", "r") + "\n\nLet me know if you need more.", nil},
		{"the only block is in a code fence", "Result:\n\n" + fence + "\n" + engBlockText("completed", "s", "r") + "\n" + fence, nil},
		{"a wrong outcome", engBlockText("Completed", "s", "r"), nil},
		{"another outcome", engBlockText("done", "s", "r"), nil},
		{"an empty summary", engBlockText("completed", "  \n ", "r"), nil},
		{"no report", "<result>\n<outcome>completed</outcome>\n<summary>s</summary>\n</result>", nil},
		{"no block", "All done, the tests pass.", nil},
		{"a question at the end", "How would you like me to proceed?", nil},
		{"empty", "", nil},
	}
	for _, c := range cases {
		got := parseResult(c.text)
		switch {
		case c.want == nil && got != nil:
			t.Errorf("%s: parsed %+v, want no block", c.name, *got)
		case c.want != nil && got == nil:
			t.Errorf("%s: no block", c.name)
		case c.want != nil && *got != *c.want:
			t.Errorf("%s:\n got %+v\nwant %+v", c.name, *got, *c.want)
		}
	}
}

// The task prompt shows the block's layout in plain tags. An agent that only echoes its
// instructions must not have that example read as its result when text follows it.
func TestResultGrammarOnThePromptItself(t *testing.T) {
	p := engTaskPromptText(engTaskPrompt{ID: "T01", Title: "x", Brief: "b", Goal: "g", Git: true, Writes: true})
	if b := parseResult(p); b != nil {
		t.Errorf("the task prompt parses as a result: %+v", *b)
	}
	if b := parseResult(engRepairMessage); b != nil {
		t.Errorf("the repair message parses as a result: %+v", *b)
	}
	if !strings.Contains(p, "<outcome>completed</outcome>") {
		t.Error("the task prompt does not show the block")
	}
}
