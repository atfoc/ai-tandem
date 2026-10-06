package boardtools

// offsetArg is the paging argument of the tools whose answer can be long.
var offsetArg = map[string]any{"type": "integer", "description": "Where to continue a long answer; the previous answer says the value"}

// tierEnum is the tier argument of the task tools.
func tierEnum(desc string) map[string]any {
	return map[string]any{"type": "string", "enum": []any{"deep", "standard", "light"}, "description": desc}
}

var taskProps = props{
	"title":        str("Short imperative title"),
	"brief":        str("Markdown: what to do and why, what exists that it builds on, exact names and shapes of anything shared with other tasks, what is out of scope, how the result is to be verified."),
	"kind":         str("A one-word label for the kind of work, e.g. research, design, implement, review, verify, fix"),
	"writes":       map[string]any{"type": "boolean", "description": "true: the task changes files, and its changes become part of the run's result (in a git run they are merged). false: it only reports and leaves nothing behind."},
	"depends_on":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Ids of the tasks that must be done before this one starts. Its agent is given the summary of each and where its report is."},
	"tier":         tierEnum("How capable an agent the task gets. deep: its result is a decision that other work is built on, or nothing after it checks it. standard: work from a precise brief whose result a build, a test or a later task checks. light: gathering facts or following a recipe, cheap to do again."),
	"tier_reason":  str("One sentence: why this tier is enough for this task"),
	"needs_report": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Those of depends_on whose full report the agent must read before it can start: they are put in front of it whole. Name as few as the task can work from."},
}

func withID(p props) props {
	out := props{"id": str("Task id, e.g. T03")}
	for k, v := range p {
		out[k] = v
	}
	return out
}

// RunTools is the run tool list: MCP tools on the server named "board", answered inside the
// server (they need no window). RunToolsFor says who gets which.
var RunTools = []Tool{
	{
		Name:        "get_run",
		Description: "The run as it is now: its status and limits, every task with its status and the summary of its result, what is running, the earlier orchestrator turns and, for the orchestrator, what happened since it last looked. The notes are not included: get_notes returns them.",
		Schema:      obj(props{"offset": offsetArg}),
		Summary:     `{"offset"?: n}`,
	},
	{
		Name:        "get_task",
		Description: "Everything about one task: its status, dependencies, attempts and agents, the commits it produced, its error if it failed, its brief, and the result and report of its agent. A long brief or report is cut; the answer says how to read the rest with part and offset.",
		Schema: obj(props{
			"id":      str("Task id, e.g. T03"),
			"part":    map[string]any{"type": "string", "enum": []any{"brief", "report"}, "description": "Only the brief, or only the report, in full"},
			"attempt": map[string]any{"type": "integer", "description": "An earlier attempt instead of the latest one"},
			"offset":  offsetArg,
		}, "id"),
		Summary: `{"id": "T03", "part"?: "brief|report", "attempt"?: n, "offset"?: n}`,
	},
	{
		Name:        "get_agent",
		Description: "What one agent of the run has been doing: its status and the most recent things it said and did. Use it to see the progress of a running task or to find out why one failed.",
		Schema: obj(props{
			"agent": str("Agent name, e.g. T03-work, T03-a2-work (attempt 2), T03-merge, turn-007"),
			"last":  map[string]any{"type": "integer", "description": "How many recent steps to return (default 15, at most 60)"},
		}, "agent"),
		Summary: `{"agent": "T03-work", "last"?: n}`,
	},
	{
		Name:        "get_notes",
		Description: "The run's notes: the orchestrator's memory across its instances (what the goal requires, the definition of done, the facts established, the approach, decisions, open questions). They are the best summary of where the run stands.",
		Schema: obj(props{
			"version": map[string]any{"type": "integer", "description": "An earlier version instead of the current one"},
			"offset":  offsetArg,
		}),
		Summary: `{"version"?: n, "offset"?: n}`,
	},
	{
		Name:        "set_notes",
		Description: "Replaces the whole of the run's notes, your memory across orchestrator instances: what the goal requires, the definition of done and how it will be checked, facts established and by which task, the approach and what is planned next, decisions and why, open questions and risks. For the first version and for reorganising them; to change one part use edit_notes.",
		Schema:      obj(props{"notes": str("Markdown")}, "notes"),
		Summary:     `{"notes": "..."}`,
	},
	{
		Name:        "edit_notes",
		Description: "Replaces one section of the notes and leaves the rest as it is. The section is everything under the heading you name, up to the next heading of the same or a higher level. A heading the notes do not have is added at the end as a new section; empty text removes the section.",
		Schema: obj(props{
			"heading": str("The heading of the section, without the # marks"),
			"text":    str("Markdown: the new content of the section, without its heading. Empty to remove the section."),
		}, "heading", "text"),
		Summary: `{"heading": "...", "text": "..."}`,
	},
	{
		Name:        "add_task",
		Description: "Adds a task and returns its id. It starts after your turn ends, once every task it depends on is done. Its agent knows the brief, the summaries of the tasks it depends on, the full reports of those named in needs_report, and where the goal is, for context; nothing else.",
		Schema:      obj(taskProps, "title", "brief", "kind", "writes", "tier", "tier_reason"),
		Summary:     `{"title": "...", "brief": "...", "kind": "...", "writes": bool, "tier": "deep|standard|light", "tier_reason": "...", "depends_on"?: ["T01"], "needs_report"?: ["T01"]}`,
	},
	{
		Name:        "update_task",
		Description: "Changes a task that has not started (or one that failed or was cancelled, before you retry it). Give only the fields to change. A running task must be cancelled first; a done task is final.",
		Schema:      obj(withID(taskProps), "id"),
		Summary:     `{"id": "T03", "title"?: "...", "brief"?: "...", "kind"?: "...", "writes"?: bool, "tier"?: "deep|standard|light", "tier_reason"?: "...", "depends_on"?: [...], "needs_report"?: [...]}`,
	},
	{
		Name:        "cancel_task",
		Description: "Cancels a task. A running task's agent is stopped and its work is not merged. Tasks that depend on a cancelled task cannot start until you change or cancel them too.",
		Schema:      obj(props{"id": str("Task id, e.g. T03"), "reason": str("Why, for the record")}, "id", "reason"),
		Summary:     `{"id": "T03", "reason": "..."}`,
	},
	{
		Name:        "retry_task",
		Description: "Queues a failed or cancelled task again as a new attempt with a new agent: in a git run from a fresh checkout of the integration branch, without git in the run's folder as the earlier attempt left it. Change its brief first (update_task) if the brief was the problem; give a higher tier if the task was too hard for its agent.",
		Schema: obj(props{"id": str("Task id, e.g. T03"), "reason": str("Why it should work this time"),
			"tier": tierEnum("The tier of the new attempt, if it should differ")}, "id", "reason"),
		Summary: `{"id": "T03", "reason": "...", "tier"?: "deep|standard|light"}`,
	},
	{
		Name:        "wait_for",
		Description: "Says which tasks you are waiting for. After this turn you are started again when they have ended (all of them, or the first one with mode any), and in any case when a task fails, when nothing is left running, and when the person changes the run or leaves a message through a chat. Other tasks that finish meanwhile do not start you; you are told about them then. It holds until your next turn starts; calling it again replaces it.",
		Schema: obj(props{
			"tasks": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Ids of pending or running tasks whose results you need before you can decide anything more"},
			"mode":  map[string]any{"type": "string", "enum": []any{"all", "any"}, "description": "Default all"},
		}, "tasks"),
		Summary: `{"tasks": ["T03", "T04"], "mode"?: "all|any"}`,
	},
	{
		Name:        "finish_run",
		Description: "Ends the run. No further orchestrator instance is started. Refused while tasks are pending or running.",
		Schema: obj(props{
			"outcome": map[string]any{"type": "string", "enum": []any{"achieved", "not_achieved"}},
			"summary": str("Markdown for the person who started the run: what was built, how it was verified, and anything they should know."),
		}, "outcome", "summary"),
		Summary: `{"outcome": "achieved|not_achieved", "summary": "..."}`,
	},
	{
		Name:        "tell_orchestrator",
		Description: "Leaves a message for the run's orchestrator in the person's name: guidance, a correction, a new requirement, an answer to a question in its notes. The orchestrator reads it when its next turn starts, which is at once when no turn is running. It does not answer you: get_run shows later what it did. Pass on only what the person asked you to.",
		Schema:      obj(props{"text": str("The message, markdown, at most 4,000 characters")}, "text"),
		Summary:     `{"text": "..."}`,
	},
}

// Who gets which run tools. A task agent, a merge agent and every subagent get none.
var (
	orchestratorOnly = map[string]bool{"set_notes": true, "edit_notes": true, "wait_for": true, "finish_run": true}
	chatOnly         = map[string]bool{"tell_orchestrator": true}
)

// RunToolsFor is the run tool list of a run's orchestrator (orchestrator true) or of a user's
// chat on a run. declared is whether the run's wake mode is declared: only then is there a
// wait_for.
func RunToolsFor(orchestrator, declared bool) []Tool {
	out := make([]Tool, 0, len(RunTools))
	for _, t := range RunTools {
		if (orchestrator && chatOnly[t.Name]) || (!orchestrator && orchestratorOnly[t.Name]) || (t.Name == "wait_for" && !declared) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// IsRunTool reports whether name is one of RunTools.
func IsRunTool(name string) bool {
	for _, t := range RunTools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// IsRunRead reports whether name is a run tool that changes nothing.
func IsRunRead(name string) bool {
	return name == "get_run" || name == "get_task" || name == "get_agent" || name == "get_notes"
}

// OrchestratorTools is the run tool list of a run's orchestrator: every run tool but
// tell_orchestrator. wait_for is in it: a run whose wake mode is not declared does not list it
// (RunToolsFor) and refuses it.
func OrchestratorTools() []Tool { return RunToolsFor(true, true) }

// RunChatTools is the run tool list of a person's chat on a run: every run tool but set_notes,
// edit_notes, wait_for and finish_run.
func RunChatTools() []Tool { return RunToolsFor(false, false) }
