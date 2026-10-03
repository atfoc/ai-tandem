package claude

import (
	"encoding/json"
	"errors"
	"fmt"

	"ai-whiteboard/internal/model"
)

// initModel is one entry of the CLI's initialize answer (`response.models`). Keys the app does not
// store (fast mode, auto mode, adaptive thinking, ...) are read past.
type initModel struct {
	Value         string   `json:"value"`
	ResolvedModel string   `json:"resolvedModel"`
	DisplayName   string   `json:"displayName"`
	Description   string   `json:"description"`
	Efforts       []string `json:"supportedEffortLevels"`
}

// CatalogFromInitialize turns the CLI's answer to an `initialize` control request — the whole
// control_response line — into a catalog, or reports that it is unusable. Each call builds a new
// value; the built-in list is only read (its default model).
//
// Rules, in this order: an entry whose display name is present and equal to its value is one the
// CLI made up for an unlisted model name and is dropped. The `default` entry is not a row when
// another entry resolves to the same model (the first such one stands for it and is the catalog
// default); with no such entry it stays a row but is not the default. Otherwise the default is the
// built-in list's default model if it is among the rows and is not a kept `default` entry, else
// the first row (the second if the first is a kept `default` entry). A row's id is the
// CLI's value, its label the display name (the id when there is none), and its default effort
// "high" when offered, else "medium", else the first level. Rows carry no context window: the
// answer has none.
func CatalogFromInitialize(line []byte) (*model.Catalog, error) {
	var m struct {
		Response controlReply `json:"response"`
	}
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, fmt.Errorf("claude initialize: %w", err)
	}
	if m.Response.Subtype == "error" {
		if m.Response.Error == "" {
			return nil, errors.New("claude initialize: the CLI answered with an error and no reason")
		}
		return nil, fmt.Errorf("claude initialize: %s", m.Response.Error)
	}
	var body struct {
		Models []initModel `json:"models"`
	}
	if err := json.Unmarshal(m.Response.Response, &body); err != nil {
		return nil, fmt.Errorf("claude initialize: %w", err)
	}
	if len(body.Models) == 0 {
		return nil, errors.New("claude initialize: no models")
	}
	var entries []initModel
	for _, e := range body.Models {
		if e.Value == "" {
			return nil, errors.New("claude initialize: a model has no value")
		}
		if e.DisplayName == e.Value { // made up by the CLI for an unlisted model name
			continue
		}
		entries = append(entries, e)
	}
	if len(entries) == 0 {
		return nil, errors.New("claude initialize: no usable models")
	}

	// The default entry's twin: the first other entry that resolves to the same model.
	defaultAt, twinAt := -1, -1
	for i, e := range entries {
		if e.Value == "default" {
			defaultAt = i
			break
		}
	}
	if defaultAt >= 0 && entries[defaultAt].ResolvedModel != "" {
		for i, e := range entries {
			if i != defaultAt && e.ResolvedModel == entries[defaultAt].ResolvedModel {
				twinAt = i
				break
			}
		}
	}

	cat := &model.Catalog{}
	keptDefault := ""
	for i, e := range entries {
		if i == defaultAt && twinAt >= 0 {
			continue
		}
		if i == defaultAt {
			keptDefault = e.Value
		}
		cat.Models = append(cat.Models, catalogRow(e))
	}

	pick := ""
	switch {
	case twinAt >= 0:
		pick = entries[twinAt].Value
	case hasRow(cat, Catalog.Default.Model) && Catalog.Default.Model != keptDefault:
		pick = Catalog.Default.Model
	default:
		pick = cat.Models[0].ID
		if pick == keptDefault && len(cat.Models) > 1 {
			pick = cat.Models[1].ID
		}
	}
	for _, r := range cat.Models {
		if r.ID == pick {
			cat.Default = model.ModelChoice{Model: r.ID, Effort: r.DefaultEffort}
		}
	}
	return cat, nil
}

func hasRow(cat *model.Catalog, id string) bool {
	for _, r := range cat.Models {
		if r.ID == id {
			return true
		}
	}
	return false
}

func catalogRow(e initModel) model.CatalogModel {
	r := model.CatalogModel{ID: e.Value, Label: e.DisplayName, Note: e.Description}
	if r.Label == "" {
		r.Label = e.Value
	}
	if len(e.Efforts) > 0 {
		r.Efforts = append([]string(nil), e.Efforts...)
		r.DefaultEffort = r.Efforts[0]
		for _, want := range []string{"medium", "high"} { // "high" wins over "medium"
			for _, l := range r.Efforts {
				if l == want {
					r.DefaultEffort = want
				}
			}
		}
	}
	return r
}
