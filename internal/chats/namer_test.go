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
			want: []string{"--no-session", "--no-extensions", "--no-context-files",
				"--no-tools", "--no-skills", "--no-prompt-templates", "--no-approve", "-p",
				"--model", "deepseek-flash", "--system-prompt", namerPrompt, request},
		},
		{
			name: "without model",
			want: []string{"--no-session", "--no-extensions", "--no-context-files",
				"--no-tools", "--no-skills", "--no-prompt-templates", "--no-approve", "-p",
				"--system-prompt", namerPrompt, request},
		},
	}
	for _, c := range cases {
		n := PiNamer{Model: c.model}
		got := n.Args(text)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: Args() = %q, want %q", c.name, got, c.want)
		}
		// The namer gets the user's first message and no permission gate: it must have no tools.
		noTools := false
		for _, a := range got[:len(got)-1] {
			noTools = noTools || a == "--no-tools"
		}
		if !noTools {
			t.Errorf("%s: Args() = %q lacks --no-tools: the namer would run with pi's bash, read, write and edit", c.name, got)
		}
	}
}

func TestPiNamerNameFails(t *testing.T) {
	// A missing binary is an error; the chat keeps its empty title.
	if _, err := (PiNamer{Bin: "ai-whiteboard-test-no-such-pi-binary"}).Name("hello"); err == nil {
		t.Fatal("Name with a missing binary succeeded")
	}
}
