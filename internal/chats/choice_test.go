package chats

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"ai-whiteboard/internal/agent"
	"ai-whiteboard/internal/model"
)

// ---- fixtures -------------------------------------------------------------

// piCatalog has a model with room, one too small for the conversation piTalked makes, and one
// whose window is not known.
var piCatalog = &model.Catalog{
	Models: []model.CatalogModel{
		{ID: "big", Label: "Big", Efforts: []string{"low", "high"}, DefaultEffort: "low", ContextWindow: 200_000},
		{ID: "small", Label: "Small", ContextWindow: 32_000},
		{ID: "unsized"},
	},
	Default: model.ModelChoice{Model: "big", Effort: "low"},
}

// piCtx is the context use of the chat piTalked makes: more than "small" takes (32000 - piReserve).
const piCtx = 20_000

// piTalked makes a pi chat on "big" with two finished turns, the second of which reported piCtx
// tokens of context.
func (e *env) piTalked() (string, *fakeAgent) {
	e.t.Helper()
	e.storeCatalog(model.Pi, piCatalog)
	id, a := e.talked(model.Pi, "", 1)
	e.send(id, "ask 2", "")
	a.emit(e.t, agent.Event{Kind: agent.EvUsage, CtxIn: piCtx, CtxOut: 10, CtxWindow: 200_000},
		agent.Event{Kind: agent.EvText, Text: "reply 2"}, agent.Event{Kind: agent.EvTurnEnd, Point: "p2"})
	if m := e.meta(id); m.Model != "big" || m.Effort != "low" || m.Usage.CtxIn != piCtx {
		e.t.Fatalf("the pi chat %+v", m)
	}
	return id, a
}

// usedTurn runs a finished turn on the chat that reports ctxIn tokens of context.
func (e *env) usedTurn(id string, a *fakeAgent, ctxIn int) {
	e.t.Helper()
	e.send(id, "ask more", "")
	a.emit(e.t, agent.Event{Kind: agent.EvUsage, CtxIn: ctxIn, CtxOut: 10, CtxWindow: 1000},
		agent.Event{Kind: agent.EvText, Text: "more"}, agent.Event{Kind: agent.EvTurnEnd, Point: "pm"})
}

// defaultsOf is the stored new-chat defaults: a copy, that a later change of the store's does not
// reach.
func (e *env) defaultsOf() (d model.Defaults) {
	e.t.Helper()
	var raw []byte
	var err error
	e.st.Read(func(s *model.State) { raw, err = json.Marshal(s.Defaults) })
	if err == nil {
		err = json.Unmarshal(raw, &d)
	}
	if err != nil {
		e.t.Fatalf("copy the defaults: %v", err)
	}
	return d
}

// ---- the guard ------------------------------------------------------------

func TestWindowGuard(t *testing.T) {
	small := &model.CatalogModel{ID: "small", Label: "Small", ContextWindow: 32_000}
	const limit = 32_000 - piReserve
	cases := []struct {
		name      string
		kind      model.AgentKind
		ctxIn     int
		cur, next string
		cm        *model.CatalogModel
		refused   bool
	}{
		{"at the limit", model.Pi, limit, "big", "small", small, false},
		{"one over", model.Pi, limit + 1, "big", "small", small, true},
		{"nothing known of the conversation", model.Pi, 0, "big", "small", small, false},
		{"claude", model.Claude, limit + 1, "big", "small", small, false},
		{"cursor", model.Cursor, limit + 1, "big", "small", small, false},
		{"the same model", model.Pi, limit + 1, "small", "small", small, false},
		{"unknown window", model.Pi, limit + 1, "big", "unsized", &model.CatalogModel{ID: "unsized"}, false},
		{"no row", model.Pi, limit + 1, "big", "small", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := windowGuard(tc.kind, tc.ctxIn, tc.cur, tc.next, tc.cm)
			if !tc.refused {
				if err != nil {
					t.Fatalf("refused: %v", err)
				}
				return
			}
			if !errors.Is(err, ErrWindow) {
				t.Fatalf("not refused: %v", err)
			}
			want := ErrWindow.Error() + ": Small takes 32000 tokens and the conversation holds about 15617; pick a larger model"
			if err.Error() != want {
				t.Fatalf("the refusal reads %q\nwant %q", err, want)
			}
		})
	}
	// A row without a label is named by its id.
	err := windowGuard(model.Pi, 30_000, "big", "tiny", &model.CatalogModel{ID: "tiny", ContextWindow: 20_000})
	if !errors.Is(err, ErrWindow) || !strings.Contains(err.Error(), ": tiny takes 20000 tokens") {
		t.Fatalf("a row without a label: %v", err)
	}

	if got := ctxOf(model.ChatMeta{Usage: model.Usage{CtxIn: 5}, SourceCtx: 9}); got != 9 {
		t.Fatalf("ctxOf with the larger source: %d", got)
	}
	if got := ctxOf(model.ChatMeta{Usage: model.Usage{CtxIn: 12}, SourceCtx: 9}); got != 12 {
		t.Fatalf("ctxOf with the larger own: %d", got)
	}
}

func TestChoose(t *testing.T) {
	e := newEnv(t)
	e.storeCatalog(model.Claude, &model.Catalog{Models: []model.CatalogModel{
		{ID: "wide", Efforts: []string{"low", "high", "max"}, DefaultEffort: "high", ContextWindow: 1000},
		{ID: "narrow", Efforts: []string{"low", "medium"}, DefaultEffort: "medium", ContextWindow: 500},
		{ID: "plain"},
	}})
	e.st.Update(func(s *model.State) error { s.Cursor = nil; return nil }) // Cursor's list is not known
	mc := func(m, ef string) model.ModelChoice { return model.ModelChoice{Model: m, Effort: ef} }
	cases := []struct {
		name          string
		kind          model.AgentKind
		cur           model.ModelChoice
		model, effort string
		want          model.ModelChoice
		row           string // the id of the row returned, "" for none
		err           string
	}{
		{"nothing chosen", model.Claude, mc("wide", "max"), "", "", mc("wide", "max"), "wide", ""},
		{"nothing chosen, a model the list lost", model.Claude, mc("old", "max"), "", "", mc("old", "max"), "", ""},
		{"a model that offers the effort", model.Claude, mc("wide", "low"), "narrow", "", mc("narrow", "low"), "narrow", ""},
		{"a model that lacks the effort", model.Claude, mc("wide", "max"), "narrow", "", mc("narrow", "medium"), "narrow", ""},
		{"a model without efforts", model.Claude, mc("wide", "max"), "plain", "", mc("plain", ""), "plain", ""},
		{"the same model", model.Claude, mc("wide", "max"), "wide", "", mc("wide", "max"), "wide", ""},
		{"an effort alone", model.Claude, mc("wide", "max"), "", "low", mc("wide", "low"), "wide", ""},
		{"a model and an effort", model.Claude, mc("wide", "max"), "narrow", "low", mc("narrow", "low"), "narrow", ""},
		{"an unknown model", model.Claude, mc("wide", "max"), "nope", "", mc("wide", "max"), "", `unknown model "nope"`},
		{"an effort the model lacks", model.Claude, mc("wide", "max"), "", "medium", mc("wide", "max"), "", `wide has no effort "medium"`},
		{"an effort the chosen model lacks", model.Claude, mc("wide", "max"), "narrow", "max", mc("wide", "max"), "", `narrow has no effort "max"`},
		{"an effort on a model without efforts", model.Claude, mc("wide", "max"), "plain", "low", mc("wide", "max"), "", `plain has no effort "low"`},
		{"an effort alone on a model the list lost", model.Claude, mc("old", "max"), "", "low", mc("old", "max"), "", `unknown model "old"`},
		{"no catalog", model.Cursor, mc("a", "x"), "anything", "any", mc("anything", "any"), "", ""},
		{"no catalog, a model alone", model.Cursor, mc("a", "x"), "anything", "", mc("anything", "x"), "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			next, cm, err := e.m.choose(tc.kind, tc.cur, tc.model, tc.effort)
			if tc.err != "" {
				if err == nil || err.Error() != tc.err {
					t.Fatalf("error %v, want %q", err, tc.err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			row := ""
			if cm != nil {
				row = cm.ID
			}
			if next != tc.want || row != tc.row {
				t.Fatalf("choice %+v with the row %q, want %+v with %q", next, row, tc.want, tc.row)
			}
		})
	}
}

// Every refusal of choose is an ErrBadChoice with its own text, which is what a route answers 400 for.
func TestChooseRefusalsAreBadChoices(t *testing.T) {
	e := newEnv(t)
	cur := model.ModelChoice{Model: "sonnet", Effort: "high"}
	for _, tc := range [][2]string{{"nope", ""}, {"", "bogus"}, {"haiku", "high"}} {
		if _, _, err := e.m.choose(model.Claude, cur, tc[0], tc[1]); !errors.Is(err, ErrBadChoice) || err.Error() == ErrBadChoice.Error() {
			t.Fatalf("choose %q, %q: %v", tc[0], tc[1], err)
		}
	}
	id := e.create(model.Claude, gOne, "").ID
	if err := e.m.Configure(id, ConfigReq{Model: "nope"}); !errors.Is(err, ErrBadChoice) || err.Error() != `unknown model "nope"` {
		t.Fatalf("Configure with an unknown model: %v", err)
	}
}
