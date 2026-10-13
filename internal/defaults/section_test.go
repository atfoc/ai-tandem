package defaults

import (
	"encoding/json"
	"reflect"
	"testing"

	"ai-whiteboard/internal/model"
)

// What a state file of before holds for another server is dropped when it is read: every group
// keeps the key "local" alone and no server it used last, the file is to be written again, and a
// second read of what was written changes nothing.
func TestSectionDefaultsKeepLocalAlone(t *testing.T) {
	t.Parallel()
	const old = `{"version":1,"defaults":{"groups":{
 "__ungrouped__":{"server":"inst-far","servers":{
   "local":{"agent":"pi","cwd":"/w","byAgent":{"claude":{"model":"opus","effort":"max"}},"subagents":{"depth":2,"cap":10},
            "run":{"agent":"claude","maxParallel":8,"maxTurns":60,"maxCost":0}},
   "inst-far":{"agent":"cursor","cwd":"/far","run":{"agent":"cursor","maxParallel":2,"maxTurns":10,"maxCost":0}}}},
 "g_far":{"server":"inst-far","servers":{"inst-far":{"cwd":"/far"},"inst-other":{"agent":"claude"}}},
 "g_sticky":{"server":"local","servers":{"local":{"cwd":"/one"}}},
 "g_local":{"servers":{"local":{"cwd":"/two"}}},
 "g_empty":{}}}}`
	const want = `{"groups":{
 "__ungrouped__":{"servers":{"local":{"agent":"pi","cwd":"/w","byAgent":{"claude":{"model":"opus","effort":"max"}},"subagents":{"depth":2,"cap":10}}}},
 "g_far":{},
 "g_sticky":{"servers":{"local":{"cwd":"/one"}}},
 "g_local":{"servers":{"local":{"cwd":"/two"}}},
 "g_empty":{}}}`
	d, changed := load(t, old)
	if !changed {
		t.Error("a file with another server's values: changed = false")
	}
	sameJSON(t, "after the read", d, want)

	b, err := json.Marshal(model.State{Version: 1, Defaults: d})
	if err != nil {
		t.Fatal(err)
	}
	again, changed := load(t, string(b))
	if changed {
		t.Errorf("what was written is changed again: %s", b)
	}
	if !reflect.DeepEqual(again, d) {
		t.Errorf("a second read: %+v, want %+v", again, d)
	}

	// Each of the two alone makes the file one to write again: a server a group used last, and a
	// key of another server.
	for what, raw := range map[string]string{
		"a server used last": `{"version":1,"defaults":{"groups":{"g1":{"server":"local","servers":{"local":{"cwd":"/w"}}}}}}`,
		"another server's":   `{"version":1,"defaults":{"groups":{"g1":{"servers":{"local":{"cwd":"/w"},"inst-far":{"cwd":"/far"}}}}}}`,
	} {
		d, changed := load(t, raw)
		if !changed {
			t.Errorf("%s: changed = false", what)
		}
		sameJSON(t, what, d, `{"groups":{"g1":{"servers":{"local":{"cwd":"/w"}}}}}`)
	}
}

// LocalOnly leaves defaults that hold nothing of another server as they are, and says so.
func TestSectionLocalOnly(t *testing.T) {
	t.Parallel()
	var none model.Defaults
	if LocalOnly(&none) || none.Groups != nil {
		t.Errorf("no defaults at all: changed, or %+v", none)
	}
	var d model.Defaults
	RecordAgent(&d, "g1", model.Pi)
	d.Groups["g_empty"] = model.GroupDefaults{}
	was := Copy(d)
	if LocalOnly(&d) || !reflect.DeepEqual(d, was) {
		t.Errorf("local values alone: %+v, want %+v unchanged", d, was)
	}
	d.Groups["g1"].Servers["inst-far"] = model.ServerDefaults{Cwd: "/far"}
	d.Groups["g2"] = model.GroupDefaults{Servers: map[string]model.ServerDefaults{"inst-far": {Cwd: "/far"}}}
	was.Groups["g2"] = model.GroupDefaults{}
	if !LocalOnly(&d) || !reflect.DeepEqual(d, was) {
		t.Errorf("after another server's values went: %+v, want %+v", d, was)
	}
	if LocalOnly(&d) {
		t.Error("a second call changed something")
	}
}
