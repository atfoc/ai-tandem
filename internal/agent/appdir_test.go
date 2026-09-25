package agent

import (
	"encoding/json"
	"testing"
)

func TestTouchesAppDir(t *testing.T) {
	home := "/Users/me"
	root := "/Users/me/.ai-whiteboard"
	cases := []struct {
		input string
		want  bool
	}{
		{`{"file_path":"/Users/me/.ai-whiteboard/boards/b_1/drawing.excalidraw"}`, true},
		{`{"command":"cat ~/.ai-whiteboard/state.json"}`, true},
		{`{"command":"find . -name .ai-whiteboard"}`, true},
		{`{"file_path":"\/Users\/me\/.ai-whiteboard\/x"}`, true},
		{`{"file_path":"/Users/me/projects/app/main.go"}`, false},
		{`{"command":"ls ~/Documents"}`, false},
		{``, false},
	}
	for _, c := range cases {
		if got := TouchesAppDir(json.RawMessage(c.input), root, home); got != c.want {
			t.Errorf("TouchesAppDir(%s) = %v, want %v", c.input, got, c.want)
		}
	}
}
