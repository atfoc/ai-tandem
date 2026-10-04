// Package boardtools holds the board tool list shared by the agent adapters,
// the prompts and the board API. It imports nothing from this project.
package boardtools

// Tool is one board tool an agent can call.
type Tool struct {
	Name        string
	Description string
	Schema      map[string]any // JSON schema of the arguments
	Summary     string         // one-line argument summary for the Cursor instructions
}

// props is the properties map of an object schema.
type props map[string]any

// obj is an object schema with the given properties and required names.
func obj(p props, required ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": map[string]any(p)}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

// str is a string schema; the optional description is used when not empty.
func str(description string) map[string]any {
	s := map[string]any{"type": "string"}
	if description != "" {
		s["description"] = description
	}
	return s
}

// arr is an array schema whose items follow the given schema.
func arr(items map[string]any) map[string]any {
	return map[string]any{"type": "array", "items": items}
}

// ref is the schema of an element reference.
var ref = map[string]any{"type": "object", "description": `{"key":"db"} or {"id":"<element id>"}`}

const boardDesc = "board id (from list_boards or <ui-context>); omit for this chat's board"

// Tools is the board tool list, in the order agents see it.
var Tools = []Tool{
	{
		Name:        "list_boards",
		Description: "List the whiteboards: name, id, group, which one is this chat's board and which one is on screen. Names are not unique; the other tools take the id.",
		Schema:      obj(props{}),
		Summary:     "{}",
	},
	{
		Name:        "read_board",
		Description: "Read a board as text: one line per element with type, key, id, label, position/size, and for arrows what they connect.",
		Schema:      obj(props{"board": str(boardDesc)}),
		Summary:     `{"board"?: "<board id>"}`,
	},
	{
		Name:        "get_view",
		Description: "What the user sees right now: the board on screen, the visible area and the selected elements.",
		Schema:      obj(props{}),
		Summary:     "{}",
	},
	{
		Name: "apply",
		Description: "Create and update elements on a board in one atomic step (one undo step for the user). " +
			"create items: {type: rectangle|ellipse|diamond|text|arrow|line|frame, key, x, y, width, height, label, text (text elements), " +
			"strokeColor, backgroundColor, fillStyle, strokeStyle, roundness: 'round'|'sharp', fontSize, start/end (arrows: a ref), groupWith: [refs]}. " +
			"A create whose key already exists updates that element instead. " +
			"update items: {ref, x, y, moveBy: [dx,dy], width, height, label, text, strokeColor, backgroundColor, start, end, ifVersion}. " +
			"Returns created key→id, updated ids and conflicts." +
			" New elements default to sharp corners, roughness 0 and the normal font.",
		Schema: obj(props{
			"board": str(boardDesc),
			"create": arr(map[string]any{
				"type":        "object",
				"description": "an element to create; also takes roughness (0, 1 or 2) and fontFamily: hand|normal|code",
			}),
			"update": arr(obj(props{"ref": ref})),
		}),
		Summary: `{"board"?: "<board id>", "create"?: [{type, key, x, y, width, height, label, ...}], "update"?: [{ref, ...}]}`,
	},
	{
		Name:        "delete_elements",
		Description: "Delete elements from a board. cascade: also delete arrows bound to them.",
		Schema: obj(props{
			"board":   str(boardDesc),
			"refs":    arr(ref),
			"cascade": map[string]any{"type": "boolean"},
			"reason":  str("one short sentence shown to the user"),
		}, "refs"),
		Summary: `{"board"?: "<board id>", "refs": [{"key"|"id": ...}], "cascade"?: bool, "reason"?: "..."}`,
	},
	{
		Name:        "create_board",
		Description: "Create a new empty board in the same group as this chat's board. Only when the user asks for a new board. Returns its name and id.",
		Schema:      obj(props{"name": str("")}, "name"),
		Summary:     `{"name": "<board name>"}`,
	},
	{
		Name:        "show_board",
		Description: "Bring a board to the user's screen and scroll to some elements. Only when the user asked to see something.",
		Schema: obj(props{
			"board": str(boardDesc),
			"refs":  arr(ref),
		}),
		Summary: `{"board"?: "<board id>", "refs"?: [{"key"|"id": ...}]}`,
	},
}

// SpawnFamily is the MCP spawn-family list. These are MCP tools on the server named
// "board", not board-engine operations: they must not go through Relay.Call / IsTool.
// Listing is filtered per chat and caller at the MCP handler; Claude --allowedTools
// reads the same names (mcp__board__<name>).
var SpawnFamily = []Tool{
	{
		Name: "spawn_subagent",
		Description: "Start one subagent run and return immediately with a receipt naming its sid. " +
			"The run continues in the background, and there is nothing to call for its result: " +
			"when the subagent finishes, the app sends you the result as a message, in a " +
			"<subagent-results> block written by the app, not by the user. " +
			"After spawning, end your turn when you have nothing else to do; " +
			"do not poll, sleep or run commands to wait for a subagent. " +
			"Parallel spawn_subagent calls need distinct descriptions so their arguments differ. " +
			"Every spawn is asynchronous: there is no background parameter.",
		Schema: obj(props{
			"prompt":      str("the task for the subagent"),
			"description": str("short label for the subagent row; give parallel spawns distinct descriptions"),
			"agent": map[string]any{
				"type":        "string",
				"description": "claude, cursor, or pi; omit for this chat's agent",
				"enum":        []any{"claude", "cursor", "pi"},
			},
			"model":  str("model id for the requested agent; omit for this chat's current model"),
			"effort": str("effort/thinking level; omit for this chat's current effort"),
		}, "prompt"),
		Summary: `{"prompt": "...", "description"?: "...", "agent"?: "claude|cursor|pi", "model"?: "...", "effort"?: "..."}`,
	},
	{
		Name:        "stop_subagent",
		Description: "Cancel one running subagent by sid.",
		Schema:      obj(props{"sid": str("subagent id from spawn_subagent")}, "sid"),
		Summary:     `{"sid": "<sid>"}`,
	},
}

// IsTool reports whether name is one of Tools (board-engine operations only).
func IsTool(name string) bool {
	for _, t := range Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// IsSpawnFamily reports whether name is one of SpawnFamily.
func IsSpawnFamily(name string) bool {
	for _, t := range SpawnFamily {
		if t.Name == name {
			return true
		}
	}
	return false
}
