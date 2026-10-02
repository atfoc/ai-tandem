package prompts

import (
	"strings"
	"testing"
)

func TestNoPlaceholdersLeft(t *testing.T) {
	for name, s := range map[string]string{"Claude": Claude(), "Pi": Pi()} {
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
		t.Error("Claude() contains the tools section")
	}
}

func TestPiIsClaude(t *testing.T) {
	if Pi() != Claude() {
		t.Fatal("Pi() must be the same whiteboard prompt as Claude(); MCP tools are not listed in either")
	}
}

func TestBoardContext(t *testing.T) {
	want := "<ui-context>\nactive_board: arch (b_aaaaaaaa)\n</ui-context>"
	if got := BoardContext("arch", "b_aaaaaaaa"); got != want {
		t.Errorf("BoardContext = %q, want %q", got, want)
	}
}

func TestInstructionsDescribeReferences(t *testing.T) {
	s := Claude()
	for _, want := range []string{"active_board", "<selection ids=", "<point x=", "get_view"} {
		if !strings.Contains(s, want) {
			t.Errorf("instructions lack %q", want)
		}
	}
	if strings.Contains(s, "what the user has selected, and the visible area") {
		t.Error("instructions still say the selection is sent with every message")
	}
}
