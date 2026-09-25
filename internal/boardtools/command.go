package boardtools

import (
	"encoding/json"
	"regexp"
	"strings"
)

var commandRe = regexp.MustCompile(`^curl -s --data-binary @- http://127\.0\.0\.1:(\d+)/agent/([0-9a-f]{32})/([a-z_]+) <<'JSON'\n([\s\S]*?)\nJSON\s*$`)

// ParseCommand accepts exactly the form the instructions teach:
//
//	curl -s --data-binary @- http://127.0.0.1:<port>/agent/<token>/<tool> <<'JSON'
//	<json>
//	JSON
//
// and nothing else (no other flags, no chaining, one heredoc, valid JSON inside).
func ParseCommand(cmd string) (token, tool string, args json.RawMessage, ok bool) {
	m := commandRe.FindStringSubmatch(strings.TrimSpace(cmd))
	if m == nil {
		return "", "", nil, false
	}
	if !isTool(m[3]) || !json.Valid([]byte(m[4])) {
		return "", "", nil, false
	}
	// Belt and braces: the regexp already rules these out.
	first, _, _ := strings.Cut(m[0], "<<'JSON'")
	for _, bad := range []string{";", "&", "|", "`", "$(", ">", "<"} {
		if strings.Contains(first, bad) {
			return "", "", nil, false
		}
	}
	return m[2], m[3], json.RawMessage(m[4]), true
}

func isTool(name string) bool {
	for _, t := range Tools {
		if t.Name == name {
			return true
		}
	}
	return false
}
