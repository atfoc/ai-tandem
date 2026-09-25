package cursor

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"ai-whiteboard/internal/model"
)

// configOption is one of a session's config options ("model", "effort", "context", "thinking",
// "fast", ...), or one of a model's parameters in cursor/list_available_models.
type configOption struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Category     string `json:"category"`
	CurrentValue string `json:"currentValue"`
	Options      []struct {
		Value string `json:"value"`
		Name  string `json:"name"`
	} `json:"options"`
}

func (o configOption) values() []string {
	out := make([]string, 0, len(o.Options))
	for _, v := range o.Options {
		out = append(out, v.Value)
	}
	return out
}

// setOption calls session/set_config_option and returns the configOptions of the response.
func setOption(conn *Conn, sid, id, value string) ([]configOption, error) {
	res, err := conn.Call("session/set_config_option", map[string]any{"sessionId": sid, "configId": id, "value": value})
	if err != nil {
		return nil, err
	}
	var r struct {
		ConfigOptions []configOption `json:"configOptions"`
	}
	if err := json.Unmarshal(res, &r); err != nil {
		return nil, fmt.Errorf("session/set_config_option: %w", err)
	}
	return r.ConfigOptions, nil
}

// applyChoice applies the app's policy to a session: set the model (a bare id), then, from the
// options that set returns, thinking → "true", context → the largest value, and the effort option
// (the thought_level option other than thinking) → effort, or the model's DefaultEffort from cat
// when effort is not one of its values. Options that are absent are not set; fast and every other
// option are never touched. It runs on every spawn, because Cursor restores the shared last-used
// params, not the chat's (docs/research/cursor-effort-load.md).
func applyChoice(conn *Conn, sid string, cat *model.Catalog, modelID, effort string) error {
	opts, err := setOption(conn, sid, "model", modelID)
	if err != nil {
		return err
	}
	var thinking, context, level *configOption
	for i := range opts {
		o := &opts[i]
		switch {
		case o.ID == "thinking":
			thinking = o
		case o.ID == "context":
			context = o
		case o.Category == "thought_level" && level == nil:
			level = o
		}
	}
	if thinking != nil {
		if _, err := setOption(conn, sid, thinking.ID, "true"); err != nil {
			return err
		}
	}
	if context != nil {
		if v, _ := largestContext(context.values()); v != "" {
			if _, err := setOption(conn, sid, context.ID, v); err != nil {
				return err
			}
		}
	}
	if level != nil {
		v := effort
		if !contains(level.values(), v) {
			v = ""
			if m := catalogModel(cat, modelID); m != nil {
				v = m.DefaultEffort
			}
		}
		if v != "" {
			if _, err := setOption(conn, sid, level.ID, v); err != nil {
				return err
			}
		}
	}
	return nil
}

// contextSize parses a Cursor context option value ("272k", "1m", case insensitive) into tokens.
// It returns false when the value cannot be parsed.
func contextSize(v string) (int, bool) {
	s := strings.ToLower(strings.TrimSpace(v))
	if len(s) < 2 {
		return 0, false
	}
	mult := 0
	switch s[len(s)-1] {
	case 'k':
		mult = 1_000
	case 'm':
		mult = 1_000_000
	default:
		return 0, false
	}
	f, err := strconv.ParseFloat(s[:len(s)-1], 64)
	if err != nil || f <= 0 {
		return 0, false
	}
	return int(f * float64(mult)), true
}

// largestContext returns the value with the largest parsed context size, never by list order.
// It returns "" (and 0) when no value parses.
func largestContext(values []string) (string, int) {
	best, size := "", 0
	for _, v := range values {
		if n, ok := contextSize(v); ok && n > size {
			best, size = v, n
		}
	}
	return best, size
}
