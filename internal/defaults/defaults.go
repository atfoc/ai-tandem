// Package defaults keeps the sticky per-group defaults for new chats: the folder (per group, for
// all agents) and the model and effort (per group and per agent).
package defaults

import (
	"os"
	"slices"

	"ai-whiteboard/internal/model"
)

// AgentOrder is the fixed order agents are offered in, everywhere: Claude, then Cursor.
// It never depends on what was used last.
var AgentOrder = []model.AgentKind{model.Claude, model.Cursor}

// Resolve returns the folder, model and effort for a new chat of agent a in group g.
// fallbackCwd is the server's default folder; cat is the agent's catalog (its Default is the last resort).
func Resolve(d model.Defaults, g string, a model.AgentKind, fallbackCwd string, cat *model.Catalog) (cwd string, mc model.ModelChoice) {
	gd := d.Groups[g]

	cwd = firstNonEmpty(gd.Cwd, d.Last.Cwd, fallbackCwd)
	if _, err := os.Stat(cwd); err != nil {
		cwd = fallbackCwd
	}

	// "Set" means a model was recorded; a folder-only change leaves no model choice behind.
	if c := gd.ByAgent[a]; c.Model != "" {
		mc = c
	} else if c := d.Last.ByAgent[a]; c.Model != "" {
		mc = c
	} else if cat != nil {
		mc = cat.Default
	}

	if cat != nil {
		m := findModel(cat, mc.Model)
		if m == nil {
			mc = cat.Default
			m = findModel(cat, mc.Model)
		}
		if m != nil && !slices.Contains(m.Efforts, mc.Effort) {
			// Never hand out an effort the model lacks: use its default effort, or none.
			mc.Effort = ""
			if len(m.Efforts) > 0 {
				mc.Effort = m.DefaultEffort
			}
		}
	}
	return cwd, mc
}

// RecordChange stores what the user just changed in a chat's composer, for group g and "last".
// Empty fields in the change are left alone.
func RecordChange(d *model.Defaults, g string, a model.AgentKind, cwd string, change model.ModelChoice) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	apply(&gd, a, cwd, change)
	d.Groups[g] = gd
	apply(&d.Last, a, cwd, change)
}

// SeedGroup gives a new group the defaults used most recently anywhere, and a new subgroup
// (parent != "") its parent's defaults.
func SeedGroup(d *model.Defaults, g, parent string) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	src := d.Last
	if pd, ok := d.Groups[parent]; parent != "" && ok {
		src = pd
	}
	cp := model.GroupDefaults{Cwd: src.Cwd}
	if src.ByAgent != nil {
		cp.ByAgent = make(map[model.AgentKind]model.ModelChoice, len(src.ByAgent))
		for k, v := range src.ByAgent {
			cp.ByAgent[k] = v
		}
	}
	d.Groups[g] = cp
}

func apply(t *model.GroupDefaults, a model.AgentKind, cwd string, change model.ModelChoice) {
	if cwd != "" {
		t.Cwd = cwd
	}
	cur := t.ByAgent[a]
	if change.Model != "" {
		cur.Model = change.Model
	}
	if change.Effort != "" {
		cur.Effort = change.Effort
	}
	if cur == (model.ModelChoice{}) {
		return // nothing recorded for this agent; don't store an empty choice
	}
	if t.ByAgent == nil {
		t.ByAgent = map[model.AgentKind]model.ModelChoice{}
	}
	t.ByAgent[a] = cur
}

func findModel(cat *model.Catalog, id string) *model.CatalogModel {
	for i := range cat.Models {
		if cat.Models[i].ID == id {
			return &cat.Models[i]
		}
	}
	return nil
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
