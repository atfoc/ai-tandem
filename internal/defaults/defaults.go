// Package defaults keeps the sticky per-group defaults for new chats: the agent, the folder (for
// all agents), the model and effort (per agent) and the subagent settings (for all agents). A
// group that has no value of its own takes the ungrouped group's. They are this server's own:
// nothing is kept for another server.
package defaults

import (
	"encoding/json"
	"os"
	"slices"

	"ai-whiteboard/internal/model"
)

// AgentOrder is the fixed order agents are offered in, everywhere: Claude, Cursor, then pi.
// It never depends on what was used last.
var AgentOrder = []model.AgentKind{model.Claude, model.Cursor, model.Pi}

// Agent returns the agent a new chat in group g starts with: the group's, then the ungrouped
// group's, then the first of AgentOrder. A kind not in usable is skipped at every step. usable
// nil = all of AgentOrder. "" when none fits.
func Agent(d model.Defaults, g string, usable []model.AgentKind) model.AgentKind {
	if usable == nil {
		usable = AgentOrder
	}
	stored := []model.AgentKind{d.Groups[g].Local().Agent, d.Groups[model.Ungrouped].Local().Agent}
	for _, a := range append(stored, AgentOrder...) {
		if a != "" && slices.Contains(usable, a) {
			return a
		}
	}
	return ""
}

// Resolve returns the folder, model and effort for a new chat of agent a in group g.
// fallbackCwd is the server's default folder, which also stands in for a stored folder that is
// no longer there; cat is the agent's catalog (its Default is the last resort). a == "" gives
// the folder only.
func Resolve(d model.Defaults, g string, a model.AgentKind, fallbackCwd string, cat *model.Catalog) (cwd string, mc model.ModelChoice) {
	gd, ud := d.Groups[g].Local(), d.Groups[model.Ungrouped].Local()

	cwd = firstNonEmpty(gd.Cwd, ud.Cwd, fallbackCwd)
	if _, err := os.Stat(cwd); err != nil {
		cwd = fallbackCwd
	}
	if a == "" {
		return cwd, model.ModelChoice{}
	}

	// "Set" means a model was recorded; a folder-only change leaves no model choice behind.
	if c := gd.ByAgent[a]; c.Model != "" {
		mc = c
	} else if c := ud.ByAgent[a]; c.Model != "" {
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

// Sub returns the subagent settings a new chat in group g starts with: the group's, then the
// ungrouped group's, then model.DefaultSubLimits. A stored value outside the range
// (model.SubLimits.Check) is skipped.
func Sub(d model.Defaults, g string) model.SubLimits {
	for _, l := range []*model.SubLimits{d.Groups[g].Local().Subagents, d.Groups[model.Ungrouped].Local().Subagents} {
		if l != nil && l.Check() == nil {
			return *l
		}
	}
	return model.DefaultSubLimits()
}

// RecordChange stores what the user just changed in a chat's composer, for group g. Empty fields
// in the change are left alone.
func RecordChange(d *model.Defaults, g string, a model.AgentKind, cwd string, change model.ModelChoice) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd, had := gd.Servers[model.LocalServer]
	apply(&sd, a, cwd, change)
	if had || !empty(sd) {
		setLocal(&gd, sd)
	}
	d.Groups[g] = gd
}

// RecordAgent stores a as the agent a new chat in group g starts with. a == "" is ignored.
func RecordAgent(d *model.Defaults, g string, a model.AgentKind) {
	if a == "" {
		return
	}
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Local()
	sd.Agent = a
	setLocal(&gd, sd)
	d.Groups[g] = gd
}

// RecordSub stores l as the subagent settings a new chat in group g starts with.
func RecordSub(d *model.Defaults, g string, l model.SubLimits) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Local()
	sd.Subagents = &l
	setLocal(&gd, sd)
	d.Groups[g] = gd
}

// SeedGroup gives a new group a copy of the ungrouped group's defaults, and a new subgroup
// (parent != "") a copy of its parent's; a parent without defaults counts as the ungrouped group.
// A copy: a later change in the source does not reach g.
func SeedGroup(d *model.Defaults, g, parent string) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	src := d.Groups[model.Ungrouped]
	if pd, ok := d.Groups[parent]; parent != "" && ok {
		src = pd
	}
	d.Groups[g] = copyGroup(src)
}

// Copy returns a deep copy of d: nothing in it is shared with d. Its Groups is never nil.
func Copy(d model.Defaults) model.Defaults {
	out := model.Defaults{Groups: make(map[string]model.GroupDefaults, len(d.Groups))}
	for k, v := range d.Groups {
		out.Groups[k] = copyGroup(v)
	}
	return out
}

// flatDefaults is what a group's entry of an old state file may hold and today's does not: its
// folder, choices and run defaults outside "servers", and the server the group used last.
type flatDefaults struct {
	Cwd     string                                `json:"cwd"`
	ByAgent map[model.AgentKind]model.ModelChoice `json:"byAgent"`
	Server  json.RawMessage                       `json:"server"`
}

func (f flatDefaults) empty() bool { return f.Cwd == "" && len(f.ByAgent) == 0 }

// LocalOnly takes out of d everything a group does not remember for this server: every key of a
// group's Servers but model.LocalServer. changed reports that there was one.
func LocalOnly(d *model.Defaults) (changed bool) {
	for g, gd := range d.Groups {
		if _, local := gd.Servers[model.LocalServer]; len(gd.Servers) == 0 || local && len(gd.Servers) == 1 {
			continue
		}
		next := model.GroupDefaults{}
		if sd, ok := gd.Servers[model.LocalServer]; ok {
			setLocal(&next, sd)
		}
		d.Groups[g] = next
		changed = true
	}
	return changed
}

// Migrate brings the defaults of an old state file into d. raw is the file, d what was loaded from
// it. Each group's flat folder and choices move under its key model.LocalServer, and
// "last" (the choices used most recently anywhere) fills what the ungrouped group lacks there. A
// value d already has is never overwritten. Each group is read on its own, as "last" is: a group
// whose flat values cannot be read has none to move, and the others and "last" move all the same.
// What a group held for another server goes (LocalOnly), and so does the server the file names as
// the one a group used last, which d has no place for. changed reports that the file held any of
// these, so it has to be written again.
func Migrate(raw []byte, d *model.Defaults) (changed bool) {
	var old struct {
		Defaults struct {
			Recent json.RawMessage            `json:"last"`
			Groups map[string]json.RawMessage `json:"groups"`
		} `json:"defaults"`
	}
	if json.Unmarshal(raw, &old) != nil {
		return LocalOnly(d)
	}
	for g, entry := range old.Defaults.Groups {
		var f flatDefaults
		if json.Unmarshal(entry, &f) != nil {
			continue
		}
		if len(f.Server) > 0 {
			changed = true
		}
		if f.empty() {
			continue
		}
		fill(d, g, f)
		changed = true
	}
	if len(old.Defaults.Recent) > 0 {
		var last flatDefaults
		_ = json.Unmarshal(old.Defaults.Recent, &last) // a "last" that is no object holds nothing to keep
		if !last.empty() {
			fill(d, model.Ungrouped, last)
		}
		changed = true
	}
	return LocalOnly(d) || changed
}

// fill puts f's values into what group g remembers where it has none: the folder when empty, an
// agent's choice when that agent has no model.
func fill(d *model.Defaults, g string, f flatDefaults) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Local()
	if sd.Cwd == "" {
		sd.Cwd = f.Cwd
	}
	for a, c := range f.ByAgent {
		cur := sd.ByAgent[a]
		lacks := cur == (model.ModelChoice{}) || cur.Model == "" && c.Model != ""
		if !lacks || c == (model.ModelChoice{}) {
			continue
		}
		if sd.ByAgent == nil {
			sd.ByAgent = map[model.AgentKind]model.ModelChoice{}
		}
		sd.ByAgent[a] = c
	}
	if !empty(sd) {
		setLocal(&gd, sd)
	}
	d.Groups[g] = gd
}

// setLocal makes sd what the group remembers.
func setLocal(gd *model.GroupDefaults, sd model.ServerDefaults) {
	if gd.Servers == nil {
		gd.Servers = map[string]model.ServerDefaults{}
	}
	gd.Servers[model.LocalServer] = sd
}

func empty(sd model.ServerDefaults) bool {
	return sd.Agent == "" && sd.Cwd == "" && len(sd.ByAgent) == 0 && sd.Subagents == nil
}

func copyGroup(g model.GroupDefaults) model.GroupDefaults {
	out := model.GroupDefaults{}
	if g.Servers != nil {
		out.Servers = make(map[string]model.ServerDefaults, len(g.Servers))
		for k, v := range g.Servers {
			out.Servers[k] = copyServer(v)
		}
	}
	return out
}

func copyServer(sd model.ServerDefaults) model.ServerDefaults {
	out := model.ServerDefaults{Agent: sd.Agent, Cwd: sd.Cwd}
	if sd.Subagents != nil {
		l := *sd.Subagents
		out.Subagents = &l
	}
	if sd.ByAgent != nil {
		out.ByAgent = make(map[model.AgentKind]model.ModelChoice, len(sd.ByAgent))
		for k, v := range sd.ByAgent {
			out.ByAgent[k] = v
		}
	}
	return out
}

func apply(t *model.ServerDefaults, a model.AgentKind, cwd string, change model.ModelChoice) {
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
