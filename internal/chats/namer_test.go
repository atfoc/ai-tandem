package chats

import (
	"reflect"
	"testing"
)

func TestPiNamerArgs(t *testing.T) {
	const text = "draw a flow chart"
	request := "Request to name:\n<<<\n" + text + "\n>>>\nTitle:"
	cases := []struct {
		name  string
		model string
		want  []string
	}{
		{
			name:  "with model",
			model: "deepseek-flash",
			want: []string{"--no-session", "--no-extensions", "--no-context-files", "--no-approve", "-p",
				"--model", "deepseek-flash", "--system-prompt", namerPrompt, request},
		},
		{
			name: "without model",
			want: []string{"--no-session", "--no-extensions", "--no-context-files", "--no-approve", "-p",
				"--system-prompt", namerPrompt, request},
		},
	}
	for _, c := range cases {
		n := PiNamer{Model: c.model}
		if got := n.Args(text); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: Args() = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestPiNamerNameFails(t *testing.T) {
	// A missing binary is an error; the chat keeps its empty title.
	if _, err := (PiNamer{Bin: "ai-whiteboard-test-no-such-pi-binary"}).Name("hello"); err == nil {
		t.Fatal("Name with a missing binary succeeded")
	}
}
