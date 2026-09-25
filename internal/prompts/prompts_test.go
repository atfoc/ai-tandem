package prompts

import (
	"strings"
	"testing"

	"ai-whiteboard/internal/boardtools"
)

func TestNoPlaceholdersLeft(t *testing.T) {
	for name, s := range map[string]string{"Claude": Claude(), "CursorInstructions": CursorInstructions()} {
		if strings.Contains(s, "{{") {
			t.Errorf("%s contains an unfilled placeholder", name)
		}
	}
}

func TestClaude(t *testing.T) {
	s := Claude()
	if !strings.Contains(s, "with the `board` MCP tools") {
		t.Error("Claude() lacks the MCP access phrase")
	}
	if strings.Contains(s, "How to call the board tools") {
		t.Error("Claude() contains the Cursor tools section")
	}
}

func TestCursorInstructions(t *testing.T) {
	s := CursorInstructions()
	if !strings.HasPrefix(s, "<whiteboard-instructions>") {
		t.Error("does not start with <whiteboard-instructions>")
	}
	if !strings.HasSuffix(s, "</whiteboard-instructions>") {
		t.Error("does not end with </whiteboard-instructions>")
	}
	if !strings.Contains(s, "by running board commands") {
		t.Error("lacks the command access phrase")
	}
	if !strings.Contains(s, "curl -s --data-binary @- <BOARD_API>/<tool> <<'JSON'") {
		t.Error("lacks the curl command line")
	}
	for _, tool := range boardtools.Tools {
		if !strings.Contains(s, tool.Name) {
			t.Errorf("lacks tool %s", tool.Name)
		}
		line := "- " + tool.Name + " — " + tool.Summary + " — " + tool.Description
		if !strings.Contains(s, line) {
			t.Errorf("lacks the line for tool %s", tool.Name)
		}
	}
}
