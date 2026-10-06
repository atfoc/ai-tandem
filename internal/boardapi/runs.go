package boardapi

import (
	"encoding/json"

	"ai-whiteboard/internal/boardtools"
	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// This file is the MCP endpoint's rule for a caller whose chat belongs to a run (ChatMeta.Run):
// a run's agents and the chats people open on it. It is the access control of runs. The
// adapters' own tool lists are only allow lists, so whatever is listed here can be called
// unasked, and whatever dispatch lets through runs.
//
//	caller                               run tools                    spawn family   board tools
//	orchestrator                         RunService.Tools (12; 11     no             no
//	                                     without wait_for when the
//	                                     wake mode is not declared)
//	task agent, merge agent              none                         yes            no
//	a person's chat on the run           RunService.Tools (9)         yes            no
//	a subagent of any of them            none                         none           none
//
// A caller whose chat is on no run is handled as it always was, and is refused every run tool.

// RunCaller is who calls a run tool.
type RunCaller struct {
	Run      string          // the run's id
	Chat     string          // the caller's chat: an agent's chat id, or the id of a person's chat on the run
	Role     model.AgentRole // orchestrator, task or merge; empty for a person's chat
	Subagent bool            // the caller is a subagent of that chat
}

// RunService is what the endpoint needs from the runs: runs.Service implements it. Tools and Call
// are answered inside the server; they never go through the board-tool bridge.
type RunService interface {
	// Tools is the run tool list of tools/list for the caller.
	Tools(c RunCaller) []boardtools.Tool
	// Call runs one run tool and returns the text for the agent; a refusal comes back as text
	// with isErr true.
	Call(c RunCaller, name string, args json.RawMessage) (text string, isErr bool)
}

// runCallerOf is the caller as the run service knows it. The chat is the top-level one: a branch
// of a person's chat acts for its chat.
func runCallerOf(c chats.Caller) RunCaller {
	return RunCaller{Run: c.Meta.Run, Chat: c.Chat, Role: c.Meta.Role, Subagent: c.Subagent}
}

// runListed is tools/list for a caller whose chat belongs to a run.
func (r *Relay) runListed(caller chats.Caller) []boardtools.Tool {
	if caller.Subagent {
		return nil
	}
	switch caller.Meta.Role {
	case model.RoleOrchestrator:
		return r.runToolsOf(caller)
	case model.RoleTask, model.RoleMerge:
		return boardtools.SpawnFamily
	case "":
		tools := r.runToolsOf(caller)
		return append(tools, boardtools.SpawnFamily...)
	}
	return nil // a role this endpoint does not know gets nothing
}

// runToolsOf is the run service's list for the caller, with nothing in it that is not a run tool:
// whatever the service answers, no board tool is listed for a chat on a run.
func (r *Relay) runToolsOf(caller chats.Caller) []boardtools.Tool {
	if r.Runs == nil {
		return nil
	}
	listed := r.Runs.Tools(runCallerOf(caller))
	out := make([]boardtools.Tool, 0, len(listed)+len(boardtools.SpawnFamily))
	for _, t := range listed {
		if boardtools.IsRunTool(t.Name) {
			out = append(out, t)
		}
	}
	return out
}

// runDispatch authorizes and routes one tools/call of a caller whose chat belongs to a run.
func (r *Relay) runDispatch(caller chats.Caller, name string, args json.RawMessage) (text string, isErr bool) {
	spawn, board, run := boardtools.IsSpawnFamily(name), boardtools.IsTool(name), boardtools.IsRunTool(name)
	if !spawn && !board && !run {
		return "unknown tool " + name, true
	}
	if caller.Subagent {
		return name + " is not available to subagents", true
	}
	role := caller.Meta.Role
	switch {
	case board:
		return name + " is not available on this chat", true
	case spawn:
		if role != model.RoleTask && role != model.RoleMerge && role != "" {
			return name + " is not available to this agent", true
		}
		return r.callSpawnFamily(caller, name, args)
	}
	if role != model.RoleOrchestrator && role != "" {
		return name + " is not available to this agent", true
	}
	if r.Runs == nil {
		return name + " is not available on this chat", true
	}
	return r.Runs.Call(runCallerOf(caller), name, args)
}
