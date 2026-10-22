package claude

import (
	"encoding/json"

	"ai-whiteboard/internal/agent"
)

// Translator turns the lines of a Claude stream-json output into agent events as a chat process's
// read loop does (translate), with no process: for stand-ins that play recorded streams (the chat
// manager's tests). Control lines (control_request, control_response) and lines that are not JSON
// give nothing.
type Translator struct{ p *proc }

// NewTranslator is a translator at the start of a process: no task, no message seen yet.
func NewTranslator() *Translator {
	p := &proc{}
	p.initMaps()
	return &Translator{p: p}
}

// Line is the events of one output line, in the order the read loop would send them.
func (t *Translator) Line(line []byte) []agent.Event {
	var m map[string]any
	if json.Unmarshal(line, &m) != nil {
		return nil
	}
	switch m["type"] {
	case "control_request", "control_response":
		return nil
	}
	return t.p.translate(m)
}
