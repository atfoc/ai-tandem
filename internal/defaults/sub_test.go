package defaults

import (
	"encoding/json"
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

// The sticky subagent settings: kept per group and per server, for all agents.

func TestSubNothingRecorded(t *testing.T) {
	t.Parallel()
	want := model.SubLimits{Depth: 1, Cap: 100}
	for what, d := range map[string]model.Defaults{
		"no defaults at all":     {},
		"a group with no server": {Groups: map[string]model.GroupDefaults{"g1": {}}},
		"a server part without the settings": {Groups: map[string]model.GroupDefaults{
			"g1": model.LocalDefaults(model.ServerDefaults{Cwd: "/w"}), model.Ungrouped: model.LocalDefaults(model.ServerDefaults{Agent: model.Pi})}},
	} {
		if got := Sub(d, "g1", local); got != want {
			t.Errorf("%s: %+v, want %+v", what, got, want)
		}
	}
}

// D11: the group's own for the server, then the ungrouped group's for that server, then depth 1
// and cap 100. Another server's part is never read, and neither is another group's.
func TestSubGroupThenUngroupedThenDefault(t *testing.T) {
	t.Parallel()
	var d model.Defaults
	RecordSub(&d, model.Ungrouped, local, model.SubLimits{Depth: 2, Cap: 25})
	RecordSub(&d, model.Ungrouped, "srv_far", model.SubLimits{Depth: 3, Cap: 5})
	for what, c := range map[string]struct {
		g, server string
		want      model.SubLimits
	}{
		"the ungrouped group":                     {model.Ungrouped, local, model.SubLimits{Depth: 2, Cap: 25}},
		"a group with none":                       {"g1", local, model.SubLimits{Depth: 2, Cap: 25}},
		"a group with none, on the other server":  {"g1", "srv_far", model.SubLimits{Depth: 3, Cap: 5}},
		"a server nothing was recorded for":       {"g1", "srv_new", model.SubLimits{Depth: 1, Cap: 100}},
		"a server that has not said who it is":    {"g1", "", model.SubLimits{Depth: 1, Cap: 100}},
		"the ungrouped group, on an unknown part": {model.Ungrouped, "srv_new", model.SubLimits{Depth: 1, Cap: 100}},
	} {
		if got := Sub(d, c.g, c.server); got != c.want {
			t.Errorf("%s: %+v, want %+v", what, got, c.want)
		}
	}

	// The group's own comes first, per server, and stays in the group. Off is a value like any other.
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 0, Cap: 100})
	if got := Sub(d, "g1", local); got != (model.SubLimits{Depth: 0, Cap: 100}) {
		t.Errorf("g1 after its own choice: %+v", got)
	}
	if got := Sub(d, "g1", "srv_far"); got != (model.SubLimits{Depth: 3, Cap: 5}) {
		t.Errorf("g1 on the other server after its choice for this one: %+v", got)
	}
	if got := Sub(d, "g2", local); got != (model.SubLimits{Depth: 2, Cap: 25}) {
		t.Errorf("g2 after g1's choice: %+v", got)
	}
	if got := Sub(d, model.Ungrouped, local); got != (model.SubLimits{Depth: 2, Cap: 25}) {
		t.Errorf("the ungrouped group after g1's choice: %+v", got)
	}
}

// A stored value outside the range (a state file edited by hand) is never handed out: the next
// one in the order is.
func TestSubSkipsAValueOutsideTheRange(t *testing.T) {
	t.Parallel()
	for what, bad := range map[string]model.SubLimits{
		"a depth above the most": {Depth: model.MaxSubDepth + 1, Cap: 10},
		"a depth below 0":        {Depth: -1, Cap: 10},
		"a cap of 0":             {Depth: 1, Cap: 0},
		"a cap above the most":   {Depth: 1, Cap: model.MaxSubCap + 1},
	} {
		d := model.Defaults{Groups: map[string]model.GroupDefaults{
			"g1":            model.LocalDefaults(model.ServerDefaults{Subagents: &bad}),
			model.Ungrouped: model.LocalDefaults(model.ServerDefaults{Subagents: &model.SubLimits{Depth: 3, Cap: 7}}),
		}}
		if got := Sub(d, "g1", local); got != (model.SubLimits{Depth: 3, Cap: 7}) {
			t.Errorf("%s in the group: %+v, want the ungrouped group's", what, got)
		}
		d.Groups[model.Ungrouped] = model.LocalDefaults(model.ServerDefaults{Subagents: &bad})
		if got := Sub(d, "g1", local); got != model.DefaultSubLimits() {
			t.Errorf("%s in both: %+v, want the defaults", what, got)
		}
	}
}

// The settings are one more value of a server's part: recording them leaves the other values
// alone, recording the others leaves them alone, and a part that holds nothing else is kept.
func TestRecordSubAndTheOtherDefaults(t *testing.T) {
	t.Parallel()
	var d model.Defaults
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 2, Cap: 10}) // into no map at all
	if got := d.Groups["g1"]; !reflect.DeepEqual(got, model.LocalDefaults(model.ServerDefaults{Subagents: &model.SubLimits{Depth: 2, Cap: 10}})) {
		t.Fatalf("the first record: %+v", got)
	}
	// A change that names nothing keeps a part that holds the settings alone.
	RecordChange(&d, "g1", local, model.Claude, "", model.ModelChoice{})
	if got := d.Groups["g1"].On(local).Subagents; got == nil || *got != (model.SubLimits{Depth: 2, Cap: 10}) {
		t.Fatalf("after a change that names nothing: %+v", d.Groups["g1"])
	}

	RecordServer(&d, "g1", local)
	RecordAgent(&d, "g1", local, model.Pi)
	RecordChange(&d, "g1", local, model.Claude, "/w", model.ModelChoice{Model: "opus", Effort: "max"})
	RecordRun(&d, "g1", local, runDefaults(model.Claude, "opus"))
	want := model.ServerDefaults{Agent: model.Pi, Cwd: "/w", ByAgent: map[model.AgentKind]model.ModelChoice{model.Claude: {Model: "opus", Effort: "max"}},
		Subagents: &model.SubLimits{Depth: 2, Cap: 10}}
	rd := runDefaults(model.Claude, "opus")
	want.Run = &rd
	if got := d.Groups["g1"].On(local); !reflect.DeepEqual(got, want) || d.Groups["g1"].Server != local {
		t.Fatalf("after the other records: %+v, want %+v", got, want)
	}

	// The settings are for all agents: the agent of a chat is no part of them, and a new record
	// replaces both numbers.
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 0, Cap: 100})
	want.Subagents = &model.SubLimits{Depth: 0, Cap: 100}
	if got := d.Groups["g1"].On(local); !reflect.DeepEqual(got, want) {
		t.Fatalf("after a second record: %+v, want %+v", got, want)
	}
	if len(d.Groups) != 1 || len(d.Groups["g1"].Servers) != 1 {
		t.Fatalf("a record reached another group or server: %+v", d)
	}
}

// What is stored is a value of its own: a record does not write into what an earlier reader of
// the defaults holds (a value that is in a ServerDefaults is never changed).
func TestRecordSubPutsANewValue(t *testing.T) {
	t.Parallel()
	var d model.Defaults
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 2, Cap: 10})
	held := d.Groups["g1"].On(local).Subagents
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 3, Cap: 50})
	if *held != (model.SubLimits{Depth: 2, Cap: 10}) {
		t.Fatalf("the value read before the record changed: %+v", *held)
	}
	if now := d.Groups["g1"].On(local).Subagents; now == held || *now != (model.SubLimits{Depth: 3, Cap: 50}) {
		t.Fatalf("after the record: %+v", now)
	}
}

// A new group starts with what a new group gets for the other defaults: a copy of the ungrouped
// group's, a subgroup a copy of its parent's, on every server. A copy: later changes on either
// side stay there. Copy carries the settings too, and shares nothing.
func TestSubIsCarriedByEveryCopy(t *testing.T) {
	t.Parallel()
	var d model.Defaults
	RecordSub(&d, model.Ungrouped, local, model.SubLimits{Depth: 2, Cap: 25})
	RecordSub(&d, model.Ungrouped, "srv_far", model.SubLimits{Depth: 0, Cap: 5})
	SeedGroup(&d, "g1", "")
	if got := d.Groups["g1"]; !reflect.DeepEqual(got, d.Groups[model.Ungrouped]) {
		t.Fatalf("a new group: %+v, want %+v", got, d.Groups[model.Ungrouped])
	}
	sharesNothing(t, "a new group", d.Groups["g1"], d.Groups[model.Ungrouped])

	RecordSub(&d, model.Ungrouped, local, model.SubLimits{Depth: 3, Cap: 100})
	if got := Sub(d, "g1", local); got != (model.SubLimits{Depth: 2, Cap: 25}) {
		t.Errorf("the group after a change in the ungrouped group: %+v", got)
	}
	RecordSub(&d, "g1", local, model.SubLimits{Depth: 1, Cap: 50})
	if got := Sub(d, model.Ungrouped, local); got != (model.SubLimits{Depth: 3, Cap: 100}) {
		t.Errorf("the ungrouped group after a change in the group: %+v", got)
	}

	SeedGroup(&d, "g1a", "g1")
	if got, far := Sub(d, "g1a", local), Sub(d, "g1a", "srv_far"); got != (model.SubLimits{Depth: 1, Cap: 50}) || far != (model.SubLimits{Depth: 0, Cap: 5}) {
		t.Errorf("a subgroup: %+v here and %+v on the other server, want its parent's", got, far)
	}
	sharesNothing(t, "a subgroup", d.Groups["g1a"], d.Groups["g1"])

	cp := Copy(d)
	if !reflect.DeepEqual(cp, d) {
		t.Fatalf("copy = %+v, want %+v", cp, d)
	}
	for g := range d.Groups {
		sharesNothing(t, g, cp.Groups[g], d.Groups[g])
	}
}

// The stored shape: "subagents" in a server's part, with both numbers written, a depth of 0 too.
// A part without it is as it was before the settings existed, and reads as none stored.
func TestSubStoredShape(t *testing.T) {
	t.Parallel()
	var d model.Defaults
	RecordChange(&d, model.Ungrouped, local, model.Claude, "/w", model.ModelChoice{Model: "opus"})
	sameJSON(t, "before any record", d, `{"groups":{"__ungrouped__":{"servers":{"local":{"cwd":"/w","byAgent":{"claude":{"model":"opus"}}}}}}}`)
	RecordSub(&d, model.Ungrouped, local, model.SubLimits{Depth: 0, Cap: 25})
	RecordSub(&d, "g1", "inst-far", model.SubLimits{Depth: 3, Cap: 100})
	const stored = `{"groups":{
 "__ungrouped__":{"servers":{"local":{"cwd":"/w","byAgent":{"claude":{"model":"opus"}},"subagents":{"depth":0,"cap":25}}}},
 "g1":{"servers":{"inst-far":{"subagents":{"depth":3,"cap":100}}}}}}`
	sameJSON(t, "after two records", d, stored)

	var back model.Defaults
	if err := json.Unmarshal([]byte(stored), &back); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back, d) {
		t.Fatalf("read back: %+v, want %+v", back, d)
	}
	// A state file from before the settings: nothing is stored, and nothing is added by a read.
	old, changed := load(t, after)
	if changed {
		t.Fatal("a state file in the per-server shape was migrated")
	}
	for g, gd := range old.Groups {
		for k, sd := range gd.Servers {
			if sd.Subagents != nil {
				t.Errorf("%s on %s has settings nobody chose: %+v", g, k, sd.Subagents)
			}
		}
	}
	sameJSON(t, "an old state file, written again", struct {
		Version  int            `json:"version"`
		Defaults model.Defaults `json:"defaults"`
	}{1, old}, after)
}
