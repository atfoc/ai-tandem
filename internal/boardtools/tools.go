// Package boardtools holds the board tool list shared by the agent adapters,
// the prompts and the board API. It imports nothing from this project.
package boardtools

import "strings"

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
		Description: "List the whiteboards: name, id, group and which one is this chat's board. Names are not unique; the other tools take the id.",
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
		Name: "get_view",
		Description: "What the user sees right now: the board on screen, the visible area and the selected elements. " +
			"Needs a window that shows this chat's board; if none does, it says so, and read_board still works.",
		Schema:  obj(props{}),
		Summary: "{}",
	},
	{
		Name: "get_image",
		Description: "Look at a board as a picture (PNG): what a human sees, with colours, layout and overlaps, which read_board does not show. " +
			"The result is an image plus one line of text with the scope used, the bounds of what is drawn in board coordinates and the element count. " +
			"scope picks what is drawn: selection (the elements the user has selected; needs a window that shows the board; " +
			"for any other board, or with no window open, use all, refs or rect), all (everything on the board, the default when nothing is selected), " +
			"refs (the elements in refs, with their bound text; a frame's children and the elements an arrow joins are not added), " +
			"rect (the elements completely inside rect, in board coordinates, a rotated one by its rotated box; one that sticks out is left out; " +
			"the bound text of a contained shape or arrow is drawn with it; rect compares exact coordinates while read_board prints rounded numbers, so leave a margin). " +
			"refs is used only with scope refs and rect only with scope rect; with any other scope they are ignored. " +
			"A selected frame is drawn without its children: select or name them as well to see them. " +
			"Without scope: the selection if the board is on the user's screen and something is selected on it, else all. " +
			"scale is 1 by default, above 0 and at most 2 (a larger value is used as 2; below 1 gives a smaller picture); background false makes the picture transparent. " +
			"A picture over 8192 px on its longest side or over 32 megapixels is refused with its size: ask again for a smaller scope or scale. " +
			"Errors: NO_SELECTION, EMPTY, UNKNOWN_REF, TOO_LARGE, BAD_ARGS, RENDER_FAILED.",
		Schema: obj(props{
			"board": str(boardDesc),
			"scope": map[string]any{
				"type":        "string",
				"description": "selection | all | refs | rect; omit for the selection if there is one, else all",
				"enum":        []any{"selection", "all", "refs", "rect"},
			},
			"refs": arr(ref),
			"rect": obj(props{
				"x":      map[string]any{"type": "number"},
				"y":      map[string]any{"type": "number"},
				"width":  map[string]any{"type": "number"},
				"height": map[string]any{"type": "number"},
			}, "x", "y", "width", "height"),
			"scale":      map[string]any{"type": "number", "description": "pixel scale, 1 by default, above 0 and at most 2"},
			"background": map[string]any{"type": "boolean", "description": "draw the board background; true by default"},
		}),
		Summary: `{"board"?: "<board id>", "scope"?: "selection|all|refs|rect", "refs"?: [{"key"|"id": ...}], "rect"?: {x, y, width, height}, "scale"?: 0-2, "background"?: bool}`,
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
		Name: "show_board",
		Description: "Bring a board to the user's screen and scroll to some elements. Only when the user asked to see something. " +
			"Needs a window that shows this chat's board; if none does, it says so, and your changes are saved in the board all the same.",
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
// reads the same names (mcp__board__<name>). The texts here are what the chat's agent reads; a
// subagent that has the family (a chat whose subagent depth is above 1) reads SpawnFamilyForSub.
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
			"Every spawn is asynchronous: there is no background parameter. " +
			"To name a model or effort, first call list_subagent_models: it lists the model ids and efforts each agent accepts.",
		Schema: obj(props{
			"prompt":      str("the task for the subagent"),
			"description": str("short label for the subagent row; give parallel spawns distinct descriptions"),
			"agent": map[string]any{
				"type":        "string",
				"description": "claude, cursor, or pi; omit for this chat's agent",
				"enum":        []any{"claude", "cursor", "pi"},
			},
			"model":  str(`model id for the requested agent, exactly as list_subagent_models lists it; omit for this chat's current model when the agent is this chat's own and that model and this chat's effort still fit its list, else for the default of a new chat of that agent (list_subagent_models shows which after "Model omitted ->")`),
			"effort": str(`effort/thinking level the model accepts, as list_subagent_models lists it; omit with a model named for this chat's current effort, or the model's default effort when this chat has none or the agent's list shows the model does not offer it; omit with no model named for the effort list_subagent_models shows after "Model omitted ->"`),
		}, "prompt"),
		Summary: `{"prompt": "...", "description"?: "...", "agent"?: "claude|cursor|pi", "model"?: "...", "effort"?: "..."}`,
	},
	{
		Name:        "stop_subagent",
		Description: "Cancel one running subagent that you started, by sid. Every subagent it has started is cancelled with it.",
		Schema:      obj(props{"sid": str("subagent id from your own spawn_subagent call")}, "sid"),
		Summary:     `{"sid": "<sid>"}`,
	},
	{
		Name: "list_subagent_models",
		Description: "List the models spawn_subagent accepts for one agent: each model's id, the efforts it accepts " +
			"and its default effort, and what spawn_subagent uses when model and effort are omitted. " +
			"Call it only when you are about to name a model or effort in spawn_subagent; a spawn that names neither needs no lookup. " +
			"Copy a model id exactly as listed. " +
			"A long list is answered with an overview or with ids alone instead of full rows: call again with filter to narrow it.",
		Schema: obj(props{
			"agent": map[string]any{
				"type":        "string",
				"description": "claude, cursor, or pi; omit for this chat's agent",
				"enum":        []any{"claude", "cursor", "pi"},
			},
			"filter": str("words to narrow the list, for example \"opus\" or \"openrouter/openai\": a model is listed when every word occurs in its id or its label, in any letter case and any order; omit to list all"),
		}),
		Summary: `{"agent"?: "claude|cursor|pi", "filter"?: "..."}`,
	},
}

// SpawnFamilyFor is SpawnFamily as it is listed on a server that can start only agents: the agent
// parameter's enum, its description and the summary name these alone. With none the parameter is
// left out. SpawnFamily is not changed.
func SpawnFamilyFor(agents []string) []Tool {
	enum := make([]any, len(agents))
	for i, a := range agents {
		enum[i] = a
	}
	desc := strings.Join(agents, ", ")
	if n := len(agents); n > 1 {
		desc = strings.Join(agents[:n-1], ", ") + ", or " + agents[n-1]
	}
	out := make([]Tool, len(SpawnFamily))
	for i, t := range SpawnFamily {
		old, ok := t.Schema["properties"].(map[string]any)
		if _, has := old["agent"]; !ok || !has {
			out[i] = t
			continue
		}
		ps := make(map[string]any, len(old))
		for k, v := range old {
			ps[k] = v
		}
		if len(agents) == 0 {
			delete(ps, "agent")
			t.Summary = strings.Replace(t.Summary, `"agent"?: "claude|cursor|pi", `, "", 1)
		} else {
			ps["agent"] = map[string]any{
				"type":        "string",
				"description": desc + "; omit for this chat's agent",
				"enum":        enum,
			}
			t.Summary = strings.Replace(t.Summary, "claude|cursor|pi", strings.Join(agents, "|"), 1)
		}
		schema := make(map[string]any, len(t.Schema))
		for k, v := range t.Schema {
			schema[k] = v
		}
		schema["properties"] = ps
		t.Schema = schema
		out[i] = t
	}
	return out
}

// subWords are the words of the spawn family's texts that name the caller as "this chat", with
// what a subagent reads in their place: what a spawn takes where it names nothing is the calling
// subagent's own, not the chat's. Longer phrases come first.
var subWords = strings.NewReplacer(
	"omit for this chat's current model when the agent is this chat's own and that model and this chat's effort still fit its list",
	"omit for your own model when the agent is your own and that model and your own effort still fit its list",
	"omit with a model named for this chat's current effort, or the model's default effort when this chat has none",
	"omit with a model named for your own effort, or the model's default effort when you have none",
	"omit for this chat's agent", "omit for your own agent",
)

// subNote is what the spawn_subagent description adds for a subagent: when its own work counts
// as finished.
const subNote = " You are a subagent yourself: while subagents you spawned are still running, ending your turn does not finish you. " +
	"Whoever started you gets your result only after you have had theirs, and it is the last message you write then."

// SpawnFamilyForSub is SpawnFamilyFor as a subagent that may spawn is listed it: the same tools
// and parameters, with the texts that speak of "this chat" speaking of the subagent itself.
func SpawnFamilyForSub(agents []string) []Tool {
	out := SpawnFamilyFor(agents)
	for i, t := range out {
		t.Description = subWords.Replace(t.Description)
		if t.Name == "spawn_subagent" {
			t.Description += subNote
		}
		schema := make(map[string]any, len(t.Schema))
		for k, v := range t.Schema {
			schema[k] = v
		}
		if old, ok := t.Schema["properties"].(map[string]any); ok {
			ps := make(map[string]any, len(old))
			for name, v := range old {
				if p, ok := v.(map[string]any); ok {
					if d, ok := p["description"].(string); ok {
						q := make(map[string]any, len(p))
						for k, v := range p {
							q[k] = v
						}
						q["description"] = subWords.Replace(d)
						v = q
					}
				}
				ps[name] = v
			}
			schema["properties"] = ps
		}
		t.Schema = schema
		out[i] = t
	}
	return out
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
