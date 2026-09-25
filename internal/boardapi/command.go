package boardapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// ServeCommand serves POST /agent/{token}/{tool}: the body is the JSON arguments. Always 200 with
// a text/plain body; errors start with "ERROR: " so the agent sees them in the command output.
func (r *Relay) ServeCommand(w http.ResponseWriter, req *http.Request) {
	text, isErr := r.command(req)
	if isErr {
		text = "ERROR: " + text
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	io.WriteString(w, text)
	if !strings.HasSuffix(text, "\n") {
		io.WriteString(w, "\n")
	}
}

func (r *Relay) command(req *http.Request) (string, bool) {
	if req.Method != http.MethodPost {
		return "use POST", true
	}
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return "could not read the arguments: " + err.Error(), true
	}
	args := json.RawMessage(strings.TrimSpace(string(body)))
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if !json.Valid(args) {
		return "the arguments are not valid JSON", true
	}
	return r.Call(req.PathValue("token"), req.PathValue("tool"), args)
}
