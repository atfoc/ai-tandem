package chats

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// A catalog event from a Claude chat process is stored under Claude and broadcast.
func TestClaudeCatalogEventPersistsAndBroadcasts(t *testing.T) {
	e := newEnv(t)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "hello", "")
	a := e.claude.last(t)
	cat := model.Catalog{
		Models:  []model.CatalogModel{{ID: "cl-new", Label: "Claude new", Efforts: levels, DefaultEffort: "high"}},
		Default: model.ModelChoice{Model: "cl-new", Effort: "high"},
	}
	a.emit(t, agent.Event{Kind: agent.EvCatalog, Catalog: &cat})

	ev := evs.wait(t, func(ev map[string]any) bool { return ev["type"] == "catalog" && ev["agent"] == "claude" })
	raw, _ := json.Marshal(ev["catalog"])
	var sent model.Catalog
	if err := json.Unmarshal(raw, &sent); err != nil || !reflect.DeepEqual(sent, cat) {
		t.Fatalf("broadcast catalog %s (%v)", raw, err)
	}
	e.st.Read(func(s *model.State) {
		if c := s.Catalog(model.Claude); c == nil || !reflect.DeepEqual(*c, cat) {
			t.Fatalf("claude catalog not persisted under Claude: %+v", c)
		}
		if _, ok := s.Catalogs[model.Cursor]; ok {
			t.Fatalf("the claude catalog event wrote the Cursor slot: %+v", s.Catalogs)
		}
		if _, ok := s.Catalogs[model.Pi]; ok {
			t.Fatalf("the claude catalog event wrote the pi slot: %+v", s.Catalogs)
		}
	})
	if got := e.m.catalog(model.Claude); got == nil || got.Default.Model != "cl-new" {
		t.Fatalf("lookup after the event: %+v", got)
	}
}

// A catalog event from an app-spawned subagent process changes nothing: not the store, and
// nothing is broadcast.
func TestSubagentCatalogEventIsDropped(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Claude, storedClaude)
	evs := listen(t, e.br)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{Model: "cl-only"})
	sa := e.spawn(v.ID, SpawnSubRequest{Prompt: "go"})
	child := waitChild(t, e.claude, 1)
	evs.drain(t, e.br)

	other := model.Catalog{
		Models:  []model.CatalogModel{{ID: "from-child", Label: "From child"}},
		Default: model.ModelChoice{Model: "from-child"},
	}
	// The events of a process are handled in order: once the turn end is, the catalog event was.
	child.emit(t, agent.Event{Kind: agent.EvCatalog, Catalog: &other}, agent.Event{Kind: agent.EvText, Text: "done"}, agent.Event{Kind: agent.EvTurnEnd})
	got, err := e.m.WaitSubagents(v.ID, []string{sa.ID}, 5*time.Second)
	if err != nil || len(got) != 1 || got[0].Status != model.SubCompleted {
		t.Fatalf("subagent %+v %v", got, err)
	}
	if n := len(ofType(evs.drain(t, e.br), "catalog")); n != 0 {
		t.Errorf("%d catalog broadcasts for a subagent's catalog event", n)
	}
	e.st.Read(func(s *model.State) {
		if c := s.Catalog(model.Claude); c == nil || !reflect.DeepEqual(*c, *storedClaude) {
			t.Errorf("claude catalog after a subagent's event: %+v", c)
		}
		if len(s.Catalogs) != 1 {
			t.Errorf("stored catalogs %v, want Claude's alone", s.Catalogs)
		}
	})
}
