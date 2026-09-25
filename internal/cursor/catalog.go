package cursor

import (
	"encoding/json"
	"regexp"
	"strings"

	"ai-whiteboard/internal/model"
)

// sessionResult is the part of session/new's (and session/load's) result the handshake uses.
type sessionResult struct {
	SessionID     string         `json:"sessionId"`
	ConfigOptions []configOption `json:"configOptions"`
}

// reportedModel is the currentValue of the "model" config option in a session/new or
// session/load result: with the parameterized model picker, a bare model id. "" when absent.
func reportedModel(res json.RawMessage) string {
	var r sessionResult
	if json.Unmarshal(res, &r) != nil {
		return ""
	}
	for _, o := range r.ConfigOptions {
		if o.ID == "model" {
			return o.CurrentValue
		}
	}
	return ""
}

// trailingEffortRe matches a reasoning word at the end of a display name ("Gemini 3.8 Flash High").
var trailingEffortRe = regexp.MustCompile(`(?i)\s+(extra\s+high|xhigh|high|medium|low|minimal|max)$`)

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// catalogModel returns the catalog entry for id, or nil.
func catalogModel(c *model.Catalog, id string) *model.CatalogModel {
	if c == nil || id == "" {
		return nil
	}
	for i := range c.Models {
		if c.Models[i].ID == id {
			return &c.Models[i]
		}
	}
	return nil
}

// setDefault sets c.Default to model id with its DefaultEffort when id is in the list, else to the
// first model in the list with its DefaultEffort.
func setDefault(c *model.Catalog, id string) {
	if c == nil || len(c.Models) == 0 {
		return
	}
	m := catalogModel(c, id)
	if m == nil {
		m = &c.Models[0]
	}
	c.Default = model.ModelChoice{Model: m.ID, Effort: m.DefaultEffort}
}

// modelListResult is cursor/list_available_models' result with the parameterized model picker on.
type modelListResult struct {
	Models []struct {
		Value         string         `json:"value"`
		Name          string         `json:"name"`
		ConfigOptions []configOption `json:"configOptions"`
	} `json:"models"`
}

// ParseModelList reads cursor/list_available_models' result into a catalog, in the list's order.
// Default is left empty: see setDefault. Returns nil when unparseable or empty.
func ParseModelList(res json.RawMessage) *model.Catalog {
	var r modelListResult
	if json.Unmarshal(res, &r) != nil || len(r.Models) == 0 {
		return nil
	}
	c := &model.Catalog{}
	for _, m := range r.Models {
		if m.Value == "" {
			continue
		}
		label := m.Name
		if label == "" {
			label = m.Value
		}
		if l := strings.TrimSpace(trailingEffortRe.ReplaceAllString(label, "")); l != "" {
			label = l
		}
		cm := model.CatalogModel{ID: m.Value, Label: label}
		for _, o := range m.ConfigOptions {
			switch {
			case o.Category == "thought_level" && o.ID != "thinking" && cm.Efforts == nil:
				for _, v := range o.Options {
					if v.Value == "" {
						continue
					}
					cm.Efforts = append(cm.Efforts, v.Value)
					if v.Name != "" {
						if cm.EffortLabels == nil {
							cm.EffortLabels = map[string]string{}
						}
						cm.EffortLabels[v.Value] = v.Name
					}
				}
				if len(cm.Efforts) > 0 {
					cm.DefaultEffort = o.CurrentValue
				}
			case o.ID == "context":
				_, cm.ContextWindow = largestContext(o.values())
			}
		}
		c.Models = append(c.Models, cm)
	}
	if len(c.Models) == 0 {
		return nil
	}
	return c
}
