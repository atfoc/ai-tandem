package chats

import (
	"encoding/json"
	"log"
	"time"

	"ai-whiteboard/internal/model"
)

// spawnClaimRetry is how long SpawnSubagent waits for a racing tool_use item before
// recording a pending link. Chat.mu is not held across this sleep.
const spawnClaimRetry = 20 * time.Millisecond

// pendingSpawnLink is an app-spawned sub waiting for a matching spawn tool item in the
// chat's own thread.
type pendingSpawnLink struct {
	sid   string
	canon string
}

func isSpawnToolName(name string) bool {
	return name == "mcp__board__spawn_subagent" || name == "spawn_subagent"
}

func isPendingSpawnItem(it model.Item) bool {
	return it.Kind == "tool" && isSpawnToolName(it.Name) && it.Result == nil && !it.Denied && it.Subagent == ""
}

func isEmptyJSON(v any) bool {
	if v == nil {
		return true
	}
	s, ok := v.(string)
	return ok && s == ""
}

// canonicalSpawnArgs is a stable JSON object of the spawn request fields that the claim
// matches against: prompt plus non-empty optional description/agent/model/effort.
func canonicalSpawnArgs(req SpawnSubRequest) string {
	out := map[string]any{"prompt": req.Prompt}
	if req.Description != "" {
		out["description"] = req.Description
	}
	if req.Kind != "" {
		out["agent"] = string(req.Kind)
	}
	if req.Model != "" {
		out["model"] = req.Model
	}
	if req.Effort != "" {
		out["effort"] = req.Effort
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// canonicalToolInput is the same stable form of a tool item's Input. Empty optional
// fields are omitted so {"prompt":"x"} matches an item that also omitted description.
func canonicalToolInput(input json.RawMessage) string {
	var m map[string]any
	if len(input) == 0 || json.Unmarshal(input, &m) != nil {
		return ""
	}
	out := map[string]any{}
	if p, ok := m["prompt"]; ok && !isEmptyJSON(p) {
		out["prompt"] = p
	}
	for _, k := range []string{"description", "agent", "model", "effort"} {
		if v, ok := m[k]; ok && !isEmptyJSON(v) {
			out[k] = v
		}
	}
	b, _ := json.Marshal(out)
	return string(b)
}

// findOldestSpawnClaim returns the tool id of the oldest pending, unclaimed spawn item
// whose arguments canonically equal canon. c.mu held.
func findOldestSpawnClaim(c *Chat, canon string) string {
	if c.tr == nil || canon == "" {
		return ""
	}
	_, items := c.tr.Snapshot()
	for _, it := range items {
		if !isPendingSpawnItem(it) {
			continue
		}
		if canonicalToolInput(it.Input) != canon {
			continue
		}
		return it.ToolID
	}
	return ""
}

// tryClaim links sid to the oldest matching unclaimed spawn item. c.mu held.
func (m *Manager) tryClaim(c *Chat, sid, canon string, out *outbox) bool {
	s := c.subs[sid]
	if s == nil {
		return false
	}
	if s.meta.Tool != "" {
		return true
	}
	toolID := findOldestSpawnClaim(c, canon)
	if toolID == "" {
		return false
	}
	s.meta.Tool = toolID
	if c.subByTool == nil {
		c.subByTool = map[string]string{}
	}
	c.subByTool[toolID] = sid
	m.link(c, c.tr, "", toolID, sid, out)
	m.saveSub(c, s)
	out.emitSub(c, s.meta)
	return true
}

// retrySpawnClaim waits briefly then retries the claim. Chat.mu is not held across the
// sleep. If still missing, a pending link is recorded for later reconciliation.
// gone is true when the chat was deleted.
func (m *Manager) retrySpawnClaim(chatID, sid, canon string) (tool string, gone bool) {
	time.Sleep(spawnClaimRetry)
	c, err := m.lock(chatID)
	if err != nil {
		return "", true
	}
	var out outbox
	m.tryClaim(c, sid, canon, &out)
	s := c.subs[sid]
	if s != nil {
		tool = s.meta.Tool
		if tool == "" {
			c.pendingLinks = append(c.pendingLinks, pendingSpawnLink{sid: sid, canon: canon})
			log.Printf("chats: spawn %s/%s: no matching spawn tool item; running unlinked", chatID, sid)
		}
	}
	c.mu.Unlock()
	m.send(out)
	return tool, false
}

// reconcileSpawnLinks re-attempts FIFO matching of pending unlinked spawns against new
// spawn tool items in the chat's own thread. c.mu held.
func (m *Manager) reconcileSpawnLinks(c *Chat, out *outbox) {
	if c.tr == nil || len(c.pendingLinks) == 0 {
		return
	}
	keep := c.pendingLinks[:0]
	for _, p := range c.pendingLinks {
		if m.tryClaim(c, p.sid, p.canon, out) {
			continue
		}
		if c.subs[p.sid] == nil {
			continue
		}
		keep = append(keep, p)
	}
	c.pendingLinks = keep
}
