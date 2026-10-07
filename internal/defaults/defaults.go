// Package defaults keeps the sticky per-group defaults for new chats and runs: the server (per
// group) and, per group and server, the agent, the folder (for all agents), the model and effort
// (per agent) and the run defaults. A group that has no value of its own takes the ungrouped group's.
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

// Server returns the server a new chat or run in group g starts on: the group's, then the
// ungrouped group's, then model.LocalServer. A stored value for which known returns false is
// skipped. known nil = only model.LocalServer is known.
func Server(d model.Defaults, g string, known func(string) bool) string {
	for _, s := range []string{d.Groups[g].Server, d.Groups[model.Ungrouped].Server} {
		if s == "" {
			continue
		}
		if known == nil && s == model.LocalServer || known != nil && known(s) {
			return s
		}
	}
	return model.LocalServer
}

// Agent returns the agent a new chat in group g on server starts with: the group's for server,
// then the ungrouped group's for server, then the first of AgentOrder. A kind not in usable is
// skipped at every step. usable nil = all of AgentOrder. "" when none fits.
func Agent(d model.Defaults, g, server string, usable []model.AgentKind) model.AgentKind {
	if usable == nil {
		usable = AgentOrder
	}
	stored := []model.AgentKind{d.Groups[g].On(server).Agent, d.Groups[model.Ungrouped].On(server).Agent}
	for _, a := range append(stored, AgentOrder...) {
		if a != "" && slices.Contains(usable, a) {
			return a
		}
	}
	return ""
}

// Resolve returns the folder, model and effort for a new chat of agent a in group g on server.
// fallbackCwd is the server's default folder; cat is the agent's catalog (its Default is the last
// resort). Whether the folder exists is checked for the local server only. a == "" gives the
// folder only.
func Resolve(d model.Defaults, g, server string, a model.AgentKind, fallbackCwd string, cat *model.Catalog) (cwd string, mc model.ModelChoice) {
	gd, ud := d.Groups[g].On(server), d.Groups[model.Ungrouped].On(server)

	cwd = firstNonEmpty(gd.Cwd, ud.Cwd, fallbackCwd)
	if server == model.LocalServer {
		if _, err := os.Stat(cwd); err != nil {
			cwd = fallbackCwd
		}
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

// Run returns a copy of what the run started last in group g on server used, else of what the one
// in the ungrouped group used; nil when none was.
func Run(d model.Defaults, g, server string) *model.RunDefaults {
	if rd := d.Groups[g].On(server).Run; rd != nil {
		return copyRun(rd)
	}
	return copyRun(d.Groups[model.Ungrouped].On(server).Run)
}

// RecordChange stores what the user just changed in a chat's composer, for group g on server.
// Empty fields in the change are left alone.
func RecordChange(d *model.Defaults, g, server string, a model.AgentKind, cwd string, change model.ModelChoice) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd, had := gd.Servers[server]
	apply(&sd, a, cwd, change)
	if had || !empty(sd) {
		setServer(&gd, server, sd)
	}
	d.Groups[g] = gd
}

// RecordAgent stores a as the agent a new chat in group g on server starts with. a == "" is ignored.
func RecordAgent(d *model.Defaults, g, server string, a model.AgentKind) {
	if a == "" {
		return
	}
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Servers[server]
	sd.Agent = a
	setServer(&gd, server, sd)
	d.Groups[g] = gd
}

// RecordServer stores server as the one a new chat or run in group g starts on. server == "" is ignored.
func RecordServer(d *model.Defaults, g, server string) {
	if server == "" {
		return
	}
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	gd.Server = server
	d.Groups[g] = gd
}

// RecordRun stores a copy of rd as what the run started last in group g on server used.
func RecordRun(d *model.Defaults, g, server string, rd model.RunDefaults) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Servers[server]
	sd.Run = copyRun(&rd)
	setServer(&gd, server, sd)
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

// flatDefaults is a group's entry as state files had it before the defaults were kept per server.
type flatDefaults struct {
	Cwd     string                                `json:"cwd"`
	ByAgent map[model.AgentKind]model.ModelChoice `json:"byAgent"`
	Run     *model.RunDefaults                    `json:"run"`
}

func (f flatDefaults) empty() bool { return f.Cwd == "" && len(f.ByAgent) == 0 && f.Run == nil }

// Migrate brings the defaults of an old state file into d. raw is the file, d what was loaded from
// it. Each group's flat folder, choices and run defaults move to its part for the local server,
// and "last" (the choices used most recently anywhere) fills what the ungrouped group's part for
// the local server lacks. A value d already has is never overwritten. Each group is read on its
// own, as "last" is: a group whose flat values cannot be read has none to move, and the others
// and "last" move all the same. changed reports that the file held "last" or a flat value, so it
// has to be written again.
func Migrate(raw []byte, d *model.Defaults) (changed bool) {
	var old struct {
		Defaults struct {
			Recent json.RawMessage            `json:"last"`
			Groups map[string]json.RawMessage `json:"groups"`
		} `json:"defaults"`
	}
	if json.Unmarshal(raw, &old) != nil {
		return false
	}
	for g, entry := range old.Defaults.Groups {
		var f flatDefaults
		if json.Unmarshal(entry, &f) != nil || f.empty() {
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
	return changed
}

// fill puts f's values into group g's part for the local server where that part has none: the
// folder when empty, an agent's choice when that agent has no model, the run defaults when nil.
func fill(d *model.Defaults, g string, f flatDefaults) {
	if d.Groups == nil {
		d.Groups = map[string]model.GroupDefaults{}
	}
	gd := d.Groups[g]
	sd := gd.Servers[model.LocalServer]
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
	if sd.Run == nil {
		sd.Run = copyRun(f.Run)
	}
	if !empty(sd) {
		setServer(&gd, model.LocalServer, sd)
	}
	d.Groups[g] = gd
}

func setServer(gd *model.GroupDefaults, server string, sd model.ServerDefaults) {
	if gd.Servers == nil {
		gd.Servers = map[string]model.ServerDefaults{}
	}
	gd.Servers[server] = sd
}

func empty(sd model.ServerDefaults) bool {
	return sd.Agent == "" && sd.Cwd == "" && len(sd.ByAgent) == 0 && sd.Run == nil
}

func copyGroup(g model.GroupDefaults) model.GroupDefaults {
	out := model.GroupDefaults{Server: g.Server}
	if g.Servers != nil {
		out.Servers = make(map[string]model.ServerDefaults, len(g.Servers))
		for k, v := range g.Servers {
			out.Servers[k] = copyServer(v)
		}
	}
	return out
}

func copyServer(sd model.ServerDefaults) model.ServerDefaults {
	out := model.ServerDefaults{Agent: sd.Agent, Cwd: sd.Cwd, Run: copyRun(sd.Run)}
	if sd.ByAgent != nil {
		out.ByAgent = make(map[model.AgentKind]model.ModelChoice, len(sd.ByAgent))
		for k, v := range sd.ByAgent {
			out.ByAgent[k] = v
		}
	}
	return out
}

// copyRun is a deep copy of rd, its tiers included; nil for nil.
func copyRun(rd *model.RunDefaults) *model.RunDefaults {
	if rd == nil {
		return nil
	}
	cp := *rd
	if rd.Tiers != nil {
		tiers := *rd.Tiers
		cp.Tiers = &tiers
	}
	return &cp
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
