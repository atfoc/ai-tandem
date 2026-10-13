// The two subagent settings of a chat (model.SubLimits) as the manager enforces them: the depth,
// which says down to which level an agent has the spawn family, and the cap on the chat's running
// subagents. The cap on running turns is another thing: cap.go.
package chats

import "fmt"

// subLimits returns the depth and the cap that hold for c: its own settings. A branch is a chat
// object of its own with its source's settings, and the cap is counted per branch, by decision:
// what runs on another branch of the chat does not count. c.mu held.
func subLimits(c *Chat) (depth, limit int) {
	l := c.meta.SubLimits()
	return l.Depth, l.Cap
}

// subLevel is the level of c's subagent sid: 1 for one the chat's agent started, and one more
// for each subagent between it and the chat (the chain of Subagent.Parent). 0 for "", the chat's
// agent. c.mu held.
func subLevel(c *Chat, sid string) int {
	n := 0
	for sid != "" && n <= len(c.subs) {
		s := c.subs[sid]
		if s == nil {
			break
		}
		n++
		sid = s.meta.Parent
	}
	return n
}

// noSpawnText is what a caller without the spawn family is told when it calls tool, one of the
// family: level is the caller's (0 = the chat's agent) and depth the chat's.
func noSpawnText(tool string, level, depth int) string {
	if depth == 0 {
		return tool + " is not available: subagents are off in this chat"
	}
	return fmt.Sprintf("%s is not available to a subagent at level %d: this chat's subagent depth is %d", tool, level, depth)
}

// SubDepthError is a spawn the chat's depth does not allow: subagents are off, or the caller is
// a subagent at the chat's deepest level.
type SubDepthError struct {
	Level int // the caller's level; 0 = the chat's agent
	Depth int // the chat's depth
}

func (e *SubDepthError) Error() string { return noSpawnText("spawn_subagent", e.Level, e.Depth) }

// SubCapError is a spawn that would take the chat over its cap on running subagents. Nothing was
// started and nothing is queued: the text says what the calling agent can do.
type SubCapError struct {
	Cap     int // the chat's cap
	Running int // its subagents running now, at every level, waiting ones included
}

func (e *SubCapError) Error() string {
	return fmt.Sprintf("this chat's cap on running subagents is %d and %d are running, at every level: "+
		"nothing was started and the spawn is not queued. End your turn to wait for a result of a subagent "+
		"you started, stop one of yours with stop_subagent, or do the work yourself.", e.Cap, e.Running)
}
