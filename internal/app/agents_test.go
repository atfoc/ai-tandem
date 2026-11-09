package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/claude"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/usable"
)

// The snapshot lists the agents the set finds, as an array even when there are none; an app with
// no set lists every kind.
func TestSnapshotAgentsFollowTheSet(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	if got := e.a.APISnapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Cursor, model.Pi}) {
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
	if got := e.a.APISnapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Claude, model.Pi}) {
		t.Fatalf("agents = %v", got)
	}
	have["cursor"] = true
	delete(have, "claude")
	set.Refresh()
	if got := e.a.APISnapshot().Agents; !reflect.DeepEqual(got, []model.AgentKind{model.Cursor, model.Pi}) {
		t.Fatalf("agents after a change = %v", got)
	}
	have = map[string]bool{}
	set.Refresh()
	b, err := json.Marshal(e.a.APISnapshot())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"agents":[]`) {
		t.Fatalf("snapshot with no usable agent: %s", b)
	}
}

// accounts is a usable.Extra with fixed accounts: kinds in order, the unusable ones with a reason.
type accounts struct {
	kinds []model.AgentKind
	why   map[model.AgentKind]error
}

func (x accounts) Kinds() []model.AgentKind      { return x.kinds }
func (x accounts) Check(a model.AgentKind) error { return x.why[a] }
func (x accounts) Name(a model.AgentKind) string { return "Claude · " + string(a) }

// Every Claude account has a catalog in the snapshot, usable or not: the one it reported, else
// Claude Code's built-in list. The fixed kinds keep theirs.
func TestSnapshotCatalogsOfAccounts(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	work, home := model.AliasKind("a_00000001"), model.AliasKind("a_00000002")
	all := func(bin string) (string, error) { return "/bin/" + bin, nil }
	set := usable.NewWith(map[model.AgentKind]string{model.Claude: "claude", model.Cursor: "cursor", model.Pi: "pi"}, all)
	set.SetExtra(accounts{kinds: []model.AgentKind{work, home}, why: map[model.AgentKind]error{home: errors.New("Not logged in")}})
	e.a.Agents = set

	reported := &model.Catalog{Models: []model.CatalogModel{{ID: "work-model"}}, Default: model.ModelChoice{Model: "work-model"}}
	e.must(e.st.Update(func(s *model.State) error {
		s.SetCatalog(work, reported)
		return nil
	}))

	snap := e.a.APISnapshot()
	if !reflect.DeepEqual(snap.Agents, []model.AgentKind{model.Claude, model.Cursor, model.Pi, work}) {
		t.Fatalf("agents = %v", snap.Agents)
	}
	c := snap.Catalogs
	if len(c) != 5 || c[model.Cursor] != nil || c[model.Pi] != nil {
		t.Fatalf("catalogs = %v", c)
	}
	if !reflect.DeepEqual(*c[model.Claude], claude.Catalog) {
		t.Errorf("claude's catalog = %+v, want the built-in list", c[model.Claude])
	}
	if !reflect.DeepEqual(c[work], reported) || c[work] == reported {
		t.Errorf("the account's catalog = %+v, want a copy of the one it reported", c[work])
	}
	if c[home] == nil || !reflect.DeepEqual(*c[home], claude.Catalog) || c[home] == c[model.Claude] {
		t.Errorf("the unusable account's catalog = %+v, want its own copy of the built-in list", c[home])
	}
}
