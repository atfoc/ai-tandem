// Package prompts builds the whiteboard instructions given to the agents.
package prompts

import (
	_ "embed"
	"strings"
)

//go:embed whiteboard.md
var whiteboard string

// render fills the two placeholders of whiteboard.md.
func render(access, tools string) string {
	s := strings.ReplaceAll(whiteboard, "{{ACCESS}}", access)
	s = strings.ReplaceAll(s, "{{TOOLS}}", tools)
	return strings.TrimSpace(s)
}

// Claude is the board-chat whiteboard prompt: --append-system-prompt for Claude and pi, and the
// first message of a Cursor board chat. The board tools themselves come from MCP; this text does
// not list them.
func Claude() string {
	return render("with the `board` MCP tools", "")
}

// Pi is the same whiteboard prompt as Claude. Kept as a name for the pi spawner and for Cursor's
// first-message block.
func Pi() string {
	return Claude()
}

// BoardContext is the <ui-context> block that names a board chat's board. The page sends a
// fuller one (with @-mentioned boards); the server falls back to this when it sends none.
func BoardContext(name, id string) string {
	return "<ui-context>\nactive_board: " + name + " (" + id + ")\n</ui-context>"
}
