package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// The snapshot lists the agents the set finds, as an array even when there are none; an app with
// no set lists every kind.
func TestSnapshotAgentsFollowTheSet(t *testing.T) {
	e := newEnv(t)
	if got := e.a.Snapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Cursor, model.Pi}) {
		t.Fatalf("agents with no set = %v", got)
	}

	have := map[string]bool{"claude": true, "pi": true}
	look := func(bin string) (string, error) {
		if !have[bin] {
			return "", errors.New("not found")
		}
		return "/bin/" + bin, nil
	}
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"}, look)
	e.a.Agents = set
	if got := e.a.Snapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Pi}) {
		t.Fatalf("agents = %v", got)
	}
	have["cursor"] = true
	delete(have, "claude")
	set.Refresh()
	if got := e.a.Snapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Cursor, model.Pi}) {
		t.Fatalf("agents after a change = %v", got)
	}
	have = map[string]bool{}
	set.Refresh()
	b, err := json.Marshal(e.a.Snapshot())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"agents":[]`) {
		t.Fatalf("snapshot with no usable agent: %s", b)
	}
}
