// Package prompts builds the whiteboard instructions given to the agents.
package prompts

import (
	_ "embed"
	"strings"

	"ai-whiteboard/internal/boardtools"
)

//go:embed whiteboard.md
var whiteboard string

// render fills the two placeholders of whiteboard.md.
func render(access, tools string) string {
	s := strings.ReplaceAll(whiteboard, "{{ACCESS}}", access)
	s = strings.ReplaceAll(s, "{{TOOLS}}", tools)
	return strings.TrimSpace(s)
}

// Claude is the --append-system-prompt text for Claude board chats.
func Claude() string {
	return render("with the `board` MCP tools", "")
}

// Pi is the --append-system-prompt text for pi board chats. The board tools reach pi as the
// app's `board` MCP server's tools, exactly like Claude; the section names them as the model
// sees them (mcp__board__<name>).
func Pi() string {
	return render("with the `board` MCP tools", piTools())
}

// CursorInstructions is the first-message block for Cursor board chats.
func CursorInstructions() string {
	return "<whiteboard-instructions>\n" +
		render("by running board commands", cursorTools()) +
		"\n</whiteboard-instructions>"
}

// BoardContext is the <ui-context> block that names a board chat's board. The page sends a
// fuller one (with @-mentioned boards); the server falls back to this when it sends none.
func BoardContext(name, id string) string {
	return "<ui-context>\nactive_board: " + name + " (" + id + ")\n</ui-context>"
}

// piTools renders how pi calls the board tools. They are MCP tools, so the model sees them
// under the board server's namespace (mcp__board__<name>); it calls them directly, with the
// tool's arguments as JSON. It lists every boardtools.Tools entry under its emitted MCP name so
// every agent gets the same tool list.
func piTools() string {
	var b strings.Builder
	b.WriteString(`## How to call the board tools

You have the board tools as MCP tools. Call each one directly, with the tool's arguments as
JSON. Do not run shell commands and do not open URLs; nothing goes through a command line.

Tools (name — arguments — what it does):
`)
	for _, t := range boardtools.Tools {
		b.WriteString("- mcp__board__" + t.Name + " — " + t.Summary + " — " + t.Description + "\n")
	}
	return b.String()
}

// cursorTools renders how Cursor calls the board tools, listing every
// boardtools.Tools entry so all agents get the same tool list.
func cursorTools() string {
	var b strings.Builder
	b.WriteString(`## How to call the board tools

You have no board MCP server. Call a board tool by running exactly this shell command, with the
tool's arguments as JSON between the markers, and nothing else in the command:

    curl -s --data-binary @- <BOARD_API>/<tool> <<'JSON'
    {"board": "b_x7k2m9qa", "create": [ … ]}
    JSON

` + "`<BOARD_API>`" + ` is the URL in the ` + "`<board-api>`" + ` block of the latest message. Run one tool per command.
Never chain commands with ` + "`;`, `&&` or `|`" + `, and never add flags. The command prints the result.

Tools (name — arguments — what it does):
`)
	for _, t := range boardtools.Tools {
		b.WriteString("- " + t.Name + " — " + t.Summary + " — " + t.Description + "\n")
	}
	return b.String()
}
