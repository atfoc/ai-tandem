package cursor

import (
	"encoding/json"
	"regexp"
	"strings"

	"ai-whiteboard/internal/model"
)

// newSessionResult is the part of session/new's (and session/load's) result the catalog uses.
type newSessionResult struct {
	SessionID     string `json:"sessionId"`
	ConfigOptions []struct {
		ID           string `json:"id"`
		CurrentValue string `json:"currentValue"`
		Options      []struct {
			Value string `json:"value"`
			Name  string `json:"name"`
		} `json:"options"`
	} `json:"configOptions"`
	Models *struct {
		CurrentModelID  string `json:"currentModelId"`
		AvailableModels []struct {
			ModelID string `json:"modelId"`
			Name    string `json:"name"`
		} `json:"availableModels"`
	} `json:"models"`
}

// trailingEffortRe matches a reasoning word at the end of a display name ("Gemini 3.8 Flash High").
var trailingEffortRe = regexp.MustCompile(`(?i)\s+(extra\s+high|xhigh|high|medium|low|minimal|max)$`)

// ParseCatalog reads session/new's result. The "model" config option's values look like
// "gpt-5.4-mini[reasoning=medium]"; models.availableModels gives display names.
func ParseCatalog(res json.RawMessage) *model.Catalog {
	var r newSessionResult
	if json.Unmarshal(res, &r) != nil {
		return nil
	}
	var values []string
	current := ""
	for _, o := range r.ConfigOptions {
		if o.ID != "model" {
			continue
		}
		for _, v := range o.Options {
			if v.Value != "" {
				values = append(values, v.Value)
			}
		}
		current = o.CurrentValue
		break
	}
	names := map[string]string{}
	if r.Models != nil {
		for _, m := range r.Models.AvailableModels {
			names[m.ModelID] = m.Name
		}
		if len(values) == 0 {
			for _, m := range r.Models.AvailableModels {
				if m.ModelID != "" {
					values = append(values, m.ModelID)
				}
			}
		}
		if current == "" {
			current = r.Models.CurrentModelID
		}
	}
	if len(values) == 0 {
		return nil
	}

	c := &model.Catalog{Values: values}
	index := map[string]int{}
	for _, v := range values {
		base, params := split(v)
		i, ok := index[base]
		if !ok {
			label := names[v]
			if label == "" {
				label = names[base]
			}
			if label == "" {
				label = base
			}
			if l := strings.TrimSpace(trailingEffortRe.ReplaceAllString(label, "")); l != "" {
				label = l
			}
			i = len(c.Models)
			index[base] = i
			c.Models = append(c.Models, model.CatalogModel{ID: base, Label: label})
		}
		if e := effortOf(params); e != "" && !contains(c.Models[i].Efforts, e) {
			c.Models[i].Efforts = append(c.Models[i].Efforts, e)
		}
	}
	if current != "" {
		base, params := split(current)
		c.Default = model.ModelChoice{Model: base, Effort: effortOf(params)}
	}
	return c
}

// ValueFor picks the exact option value for a base model and effort.
func ValueFor(c *model.Catalog, base, effort string) string {
	if c == nil || base == "" {
		return ""
	}
	for _, v := range c.Values {
		if b, p := split(v); b == base && effortOf(p) == effort {
			return v
		}
	}
	for _, v := range c.Values {
		if b, _ := split(v); b == base {
			return v
		}
	}
	return ""
}

// effortKeys are the names Cursor gives a model's reasoning effort, depending on the model.
var effortKeys = []string{"reasoning", "reasoning_effort", "effort"}

// effortOf returns the effort in a value's parameters, whatever Cursor calls it.
func effortOf(params map[string]string) string {
	for _, k := range effortKeys {
		if e := params[k]; e != "" {
			return e
		}
	}
	return ""
}

// split("gpt-5.4-mini[reasoning=medium]") → ("gpt-5.4-mini", map{"reasoning":"medium"})
func split(v string) (string, map[string]string) {
	params := map[string]string{}
	i := strings.IndexByte(v, '[')
	if i < 0 || !strings.HasSuffix(v, "]") {
		return v, params
	}
	for _, kv := range strings.Split(v[i+1:len(v)-1], ",") {
		k, val, _ := strings.Cut(kv, "=")
		if k = strings.TrimSpace(k); k != "" {
			params[k] = strings.TrimSpace(val)
		}
	}
	return v[:i], params
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
