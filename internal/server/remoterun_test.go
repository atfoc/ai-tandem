package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/runs"
	"ai-whiteboard/internal/servers/standin"
	"ai-whiteboard/internal/store"
	"ai-whiteboard/internal/usable"
)

// The routes of the runs of other servers, through the real handler, on the rig of
// remotechat_test.go: the stand-in is the run's server, this server has a real run service, and
// the relay keeps the run records.

const (
	runA   = "r_aaaa0001"
	runB   = "r_bbbb0002"
	agentA = "4a000000-0000-4000-8000-00000000000a" // the chat of an agent of runA, as its server names it
)

// runThere is a run's view as its server sends it: started, with that server's group and its
// own archive action.
func runThere(id string) model.RunView {
	return model.RunView{
		ID: id, Name: "Run " + id[2:4], Group: "g_there", Agent: model.Claude, Cwd: "/home/standin/work", Git: true,
		Tiers:   model.RunTiers{Deep: model.ModelChoice{Model: "standin-model"}},
		Created: time.Date(2026, 10, 6, 9, 0, 0, 0, time.UTC), Started: time.Date(2026, 10, 6, 9, 1, 0, 0, time.UTC),
		Status: model.RunRunning, Turns: 1,
	}
}

// wireRuns gives the server a run service, as the program wires it, and writes a run record for
// each of the runs the stand-in has. It returns the service for the relay's options.
func (f *far) wireRuns(t *testing.T, s *Server, have []model.RunView) remotes.LocalRuns {
	t.Helper()
	rs := runs.New(runs.Deps{Store: s.App.St, Emit: s.Bridge, DefaultCwd: s.App.DefaultCwd, HaltWait: 300 * time.Millisecond})
	if err := rs.Load(); err != nil {
		t.Fatal(err)
	}
	rs.Chats = s.App.Chats
	s.App.Chats.Runs = rs
	s.App.Runs, s.Relay.Runs = rs, rs
	f.rs = rs
	t.Cleanup(func() { rs.Shutdown(5 * time.Second) })
	paths := store.NewPaths(f.root)
	if err := os.MkdirAll(paths.RemoteRuns, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, v := range have {
		raw, _ := json.Marshal(remotes.RunRecord{ID: v.ID, Entry: f.entry, Group: model.Ungrouped, View: v})
		if err := os.WriteFile(paths.RemoteRunFile(v.ID), raw, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return rs
}

// usualRuns is what the stand-in answers on the run routes without a handler of the test: a
// server that has the runs of f.runs, starts every run it is asked to, and finds every folder.
func (f *far) usualRuns() map[string]http.HandlerFunc {
	// view answers with the run after change, as the routes of a run do.
	view := func(change func(v *model.RunView, r *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("id")
			f.mu.Lock()
			v, has := f.runs[id]
			if has && change != nil {
				change(&v, r)
				f.runs[id] = v
			}
			f.mu.Unlock()
			if !has {
				writeError(w, http.StatusNotFound, runs.ErrNotFound.Error())
				return
			}
			writeJSON(w, v)
		}
	}
	return map[string]http.HandlerFunc{
		"GET /api/runs/{id}": view(nil),
		"PATCH /api/runs/{id}": view(func(v *model.RunView, r *http.Request) {
			var body struct{ Name string }
			json.NewDecoder(r.Body).Decode(&body)
			v.Name, v.UserNamed = body.Name, true
		}),
		"POST /api/runs/{id}/stop":      view(func(v *model.RunView, _ *http.Request) { v.Status = model.RunStopped }),
		"POST /api/runs/{id}/resume":    view(func(v *model.RunView, _ *http.Request) { v.Status = model.RunRunning }),
		"POST /api/runs/{id}/archive":   view(func(v *model.RunView, _ *http.Request) { v.Archive = model.Archive{Archived: true, Op: "a_there"} }),
		"POST /api/runs/{id}/unarchive": view(func(v *model.RunView, _ *http.Request) { v.Archive = model.Archive{} }),
		"GET /api/runs/{id}/detail": func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			agents := map[string]any{}
			for _, a := range f.agents {
				agents[a] = map[string]any{"role": "task"}
			}
			f.mu.Unlock()
			writeJSON(w, map[string]any{"run": r.PathValue("id"), "version": 4, "agents": agents})
		},
		"DELETE /api/runs/{id}": func(w http.ResponseWriter, r *http.Request) {
			f.mu.Lock()
			delete(f.runs, r.PathValue("id"))
			f.mu.Unlock()
			ok(w)
		},
		// The start call: the run is made with the call's values and started.
		"PUT /api/runs/{id}": func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Name, Cwd string
				Agent     model.AgentKind
				Tiers     model.RunTiers
			}
			json.NewDecoder(r.Body).Decode(&body)
			v := runThere(r.PathValue("id"))
			v.Name, v.Agent, v.Cwd, v.Tiers, v.Group = body.Name, body.Agent, body.Cwd, body.Tiers, "g_remote"
			f.mu.Lock()
			f.runs[v.ID] = v
			f.mu.Unlock()
			writeJSON(w, map[string]any{"ok": true, "started": true, "made": true, "run": v})
		},
		"GET /api/runs/check": func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, runs.DraftFacts{Cwd: r.URL.Query().Get("cwd"), Git: true})
		},
	}
}

// runNow is the run as GET /api/state lists it; ok is false when it lists none with the id.
func (f *far) runNow(p *bridgetest.Page, id string) (rv model.RunView, ok bool) {
	f.t.Helper()
	var snap struct{ Runs []model.RunView }
	if err := json.Unmarshal([]byte(mustOK(f.t, f, p, "GET", "/api/state", "")), &snap); err != nil {
		f.t.Fatal(err)
	}
	n := 0
	for _, r := range snap.Runs {
		if r.ID == id {
			rv, n = r, n+1
		}
	}
	if n > 1 {
		f.t.Fatalf("the snapshot lists the run %s %d times", id, n)
	}
	return rv, n == 1
}

// groupArchived says whether GET /api/state shows the group archived.
func (f *far) groupArchived(p *bridgetest.Page, id string) bool {
	f.t.Helper()
	var snap struct{ Groups []model.Group }
	json.Unmarshal([]byte(mustOK(f.t, f, p, "GET", "/api/state", "")), &snap)
	for _, x := range snap.Groups {
		if x.ID == id {
			return x.Archived
		}
	}
	f.t.Fatalf("no group %s", id)
	return false
}

// learnAgent makes the page read the run's detail, whose answer names the agent's chat: from
// then on the relay knows the chat as the run's.
func (f *far) learnAgent(p *bridgetest.Page, run, chat string) {
	f.t.Helper()
	f.mu.Lock()
	f.agents = []string{chat}
	f.mu.Unlock()
	f.good(p, "GET", "/api/runs/"+run+"/detail", "")
	if got, ok := f.rm.AgentChat(chat); !ok || got != run {
		f.t.Fatalf("the relay knows the chat %s as the run %q's, %v", chat, got, ok)
	}
}

// remoteDraft makes a draft run in the group and puts it on the entry.
func (f *far) remoteDraft(p *bridgetest.Page, group string) model.RunView {
	f.t.Helper()
	d := decode[model.RunView](f.t, mustOK(f.t, f, p, "POST", "/api/runs", form("group", group)))
	return decode[model.RunView](f.t, mustOK(f.t, f, p, "PATCH", "/api/runs/"+d.ID, form("server", f.entry)))
}

// runRoute says whether a registered pattern is a route of one run: /api/runs/{id} or below.
func runRoute(pattern string) bool {
	_, path, _ := strings.Cut(pattern, " ")
	return path == "/api/runs/{id}" || strings.HasPrefix(path, "/api/runs/{id}/")
}

// sameRoutes fails unless the table holds exactly the routes of the mux that one says are its.
func sameRoutes(t *testing.T, what string, mux, table []string, one func(string) bool, n int) {
	t.Helper()
	var want []string
	for _, p := range mux {
		if one(p) {
			want = append(want, p)
		}
	}
	got := slices.Clone(table)
	for _, p := range got {
		if !one(p) {
			t.Errorf("the table holds %q, which is no route of one %s", p, what)
		}
	}
	sort.Strings(want)
	sort.Strings(got)
	if !slices.Equal(want, got) {
		t.Fatalf("the mux has the %s routes\n%s\nand the table\n%s", what, strings.Join(want, "\n"), strings.Join(got, "\n"))
	}
	if len(got) != n {
		t.Fatalf("%d routes of one %s, want %d: is a row of the design's table missing?", len(got), what, n)
	}
	// Every route of the remote listener's table that is one of them has a row too.
	for _, p := range RemoteRoutes {
		if one(p) && !slices.Contains(got, p) {
			t.Errorf("%q is served to an API client and has no row", p)
		}
	}
}

// The table of a run record's routes holds exactly the routes the mux has for one run: a run
// route that is added to the mux without a row here would reach the run service for a record,
// which knows no such run.
func TestRunRecordRoutesAreTheRunRoutesOfTheMux(t *testing.T) {
	s := newEnv(t).s
	sameRoutes(t, "run", s.routes().patterns, s.runRecordRoutes().patterns, runRoute, 19)
}

// The table of the routes of a run agent's chat holds exactly the routes the mux has for one
// chat: one without a row would reach the chat manager, which knows no such chat.
func TestRunAgentRoutesAreTheChatRoutesOfTheMux(t *testing.T) {
	s := newEnv(t).s
	sameRoutes(t, "chat", s.routes().patterns, s.runAgentRoutes().patterns, chatRoute, 17)
}

// Each row of the run record's table: what the stand-in gets, and what the page gets.
func TestRunRecordRoutes(t *testing.T) {
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA), runThere(runB)}})
	p, other := f.page("P"), f.page("Q")
	g := f.group(p, "Work", "")
	f.events()
	at := "/api/runs/" + runA
	// mine fails unless v is the record's view of runA: the id, this server's place and the
	// entry, and nothing of the other server's place or archive action.
	mine := func(what string, v map[string]any, group string) {
		t.Helper()
		if v["id"] != runA || v["group"] != group || v["server"] != f.entry || v["archiveOp"] == "a_there" || v["started"] == nil {
			t.Fatalf("%s: %v", what, v)
		}
	}

	// GET: passed on; the record takes the view.
	there := runThere(runA)
	there.Turns, there.Attention = 7, 2
	f.answer("GET /api/runs/{id}", http.StatusOK, there)
	got := f.good(p, "GET", at, "")
	if mine("the read", got, model.Ungrouped); got["turns"] != float64(7) || got["attention"] != float64(2) {
		t.Fatalf("the read: %v", got)
	}
	if c := f.last("GET /api/runs/{id}"); c.Path != at {
		t.Fatalf("the read there: %+v", c)
	}
	if rv, ok := f.runNow(p, runA); !ok || rv.Turns != 7 || rv.Server != f.entry || rv.Group != model.Ungrouped {
		t.Fatalf("the snapshot's run after the read: %+v, %v", rv, ok)
	}
	f.handle("GET /api/runs/{id}", nil)

	// PATCH: the group is this server's, the name is passed on alone, the rest is refused.
	f.untouched("a move", func() {
		mine("the move", f.good(p, "PATCH", at, form("group", g)), g)
		f.refuses(p, http.StatusNotFound, "", "PATCH", at, form("group", "g_none"))
	})
	got = f.good(p, "PATCH", at, form("name", "Mine", "group", model.Ungrouped))
	if mine("the rename", got, model.Ungrouped); got["name"] != "Mine" {
		t.Fatalf("the rename: %v", got)
	}
	if c := f.last("PATCH /api/runs/{id}"); c.Body != `{"name":"Mine"}` || c.Path != at {
		t.Fatalf("the rename there: %+v", c)
	}
	f.untouched("a started run's choices", func() {
		for _, body := range []string{form("server", "local"), form("agent", "pi"), `{"tiers":{"deep":{"model":"m"}}}`, form("cwd", "/x"), `{"settings":{"maxTurns":3}}`, form("name", "n", "cwd", "/x")} {
			if text := f.refuses(p, http.StatusConflict, "", "PATCH", at, body); text != runs.ErrStarted.Error() {
				t.Errorf("PATCH %s: %q", body, text)
			}
		}
		// The goal draft and the start are answered here.
		if got := f.good(p, "PUT", at+"/draft", `{"text":"more"}`); got["ok"] != true {
			t.Errorf("the draft: %v", got)
		}
		mine("the start of a started run", f.good(p, "POST", at+"/start", form("goal", "again")), model.Ungrouped)
		mine("the start with no body", f.good(p, "POST", at+"/start", ""), model.Ungrouped)
		// The start call is an API client's.
		if text := f.refuses(p, http.StatusNotFound, "", "PUT", at, `{"goal":"x"}`); text != "not found" {
			t.Errorf("the start call of a page: %q", text)
		}
	})

	// Stop and resume: passed on with the body, answered with the record's view.
	got = f.good(p, "POST", at+"/stop", "")
	if mine("the stop", got, model.Ungrouped); got["status"] != "stopped" || f.last("POST /api/runs/{id}/stop").Body != "" {
		t.Fatalf("the stop: %v", got)
	}
	got = f.good(p, "POST", at+"/resume", `{"maxTurns":90}`)
	if mine("the resume", got, model.Ungrouped); got["status"] != "running" || f.last("POST /api/runs/{id}/resume").Body != `{"maxTurns":90}` {
		t.Fatalf("the resume: %v, sent %+v", got, f.last("POST /api/runs/{id}/resume"))
	}
	if status, out := f.call(p, "POST", at+"/resume", `{"maxTurns":`); status != http.StatusBadRequest {
		t.Fatalf("a resume whose body is no JSON: %d %s", status, out)
	}
	// Apply: answered as it came, a refusal too.
	f.answer("POST /api/runs/{id}/apply", http.StatusOK, map[string]any{"state": "applied", "branch": "main"})
	if got = f.good(p, "POST", at+"/apply", `{"branch":"main"}`); !reflect.DeepEqual(got, map[string]any{"state": "applied", "branch": "main"}) ||
		f.last("POST /api/runs/{id}/apply").Body != `{"branch":"main"}` {
		t.Fatalf("the apply: %v", got)
	}
	f.answer("POST /api/runs/{id}/apply", http.StatusConflict, map[string]any{"error": "the run is live"})
	if text := f.refuses(p, http.StatusConflict, "", "POST", at+"/apply", ""); text != "the run is live" {
		t.Fatalf("a refused apply: %q", text)
	}

	// The texts: passed on with the query, as they came.
	for i, row := range []struct{ pat, rest, query string }{
		{"GET /api/runs/{id}/goal", "/goal", ""},
		{"GET /api/runs/{id}/delivery", "/delivery", ""},
		{"GET /api/runs/{id}/tasks/{tid}/brief", "/tasks/T1/brief", "rev=2"},
		{"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/report", "/tasks/T1/attempts/2/report", ""},
		{"GET /api/runs/{id}/tasks/{tid}/attempts/{n}/changes", "/tasks/T1/attempts/2/changes", ""},
		{"GET /api/runs/{id}/notes/{v}", "/notes/3", ""},
	} {
		for _, status := range []int{http.StatusOK, http.StatusNotFound} {
			want := map[string]any{"row": float64(i), "text": "as it is there"}
			if status != http.StatusOK {
				want = map[string]any{"error": "nothing recorded yet"}
			}
			f.answer(row.pat, status, want)
			path := at + row.rest
			if row.query != "" {
				path += "?" + row.query
			}
			code, out := f.call(p, "GET", path, "")
			if code != status || !reflect.DeepEqual(decode[map[string]any](t, out), want) {
				t.Errorf("GET %s: %d %s, want %d %v", path, code, out, status, want)
			}
			if c := f.last(row.pat); c.Path != at+row.rest || !sameQuery(c.Query, row.query) {
				t.Errorf("GET %s there: %+v", path, c)
			}
		}
	}
	if _, ok := f.runNow(p, runA); !ok || !f.rm.HasRun(runA) {
		t.Fatal(`an answer "nothing recorded yet" removed the record`)
	}

	// The detail: the bytes that came, and the page that read follows the run.
	f.mu.Lock()
	f.agents = []string{agentA}
	f.mu.Unlock()
	if got = f.good(p, "GET", at+"/detail", ""); got["run"] != runA || got["version"] != float64(4) || field(got, "agents", agentA, "role") != "task" {
		t.Fatalf("the detail: %v", got)
	}
	f.events()
	patch := `{"type":"run_detail","run":"` + runA + `","version":5,"patch":{"turns":[{"n":2}]}}`
	f.st.Send(json.RawMessage(patch))
	evs := f.events(p, other)
	if !slices.Contains(evs[0], patch) || len(evs[1]) != 0 {
		t.Fatalf("the follower got %v, the other page %v", evs[0], evs[1])
	}
	// Unfollow: the page's follow ends here.
	if got = f.good(p, "POST", at+"/unfollow", ""); got["ok"] != true {
		t.Fatalf("the unfollow: %v", got)
	}
	f.st.Send(json.RawMessage(patch))
	if evs = f.events(p); len(evs[0]) != 0 {
		t.Fatalf("after the unfollow the page got %v", evs[0])
	}

	// Archive and unarchive: shown at once, passed on, with this server's action.
	if got = f.good(p, "POST", at+"/archive", ""); got["ok"] != true {
		t.Fatalf("the archive: %v", got)
	}
	rv, _ := f.runNow(p, runA)
	if !rv.Archived || rv.Op == "" || rv.Op == "a_there" || len(f.sent("POST /api/runs/{id}/archive")) != 1 {
		t.Fatalf("after the archive: %+v", rv.Archive)
	}
	f.good(p, "POST", at+"/unarchive", "")
	if rv, _ = f.runNow(p, runA); rv.Archived || rv.Op != "" || len(f.sent("POST /api/runs/{id}/unarchive")) != 1 {
		t.Fatalf("after the unarchive: %+v", rv.Archive)
	}

	// Delete: "this sidebar only" is refused while the server is connected; the delete is made
	// there, and the record goes.
	f.untouched("a local delete while connected", func() {
		if text := f.refuses(p, http.StatusConflict, "server_connected", "DELETE", at+"?local=1", ""); text != "Studio is connected: delete the run there." {
			t.Errorf("the refusal: %q", text)
		}
	})
	f.events()
	f.good(p, "DELETE", at, "")
	if _, ok := f.runNow(p, runA); ok || f.rm.HasRun(runA) || f.last("DELETE /api/runs/{id}").Path != at {
		t.Fatal("after the delete the record is there")
	}
	removed := 0
	for _, raw := range f.events(p)[0] {
		if typeOf(raw) == "run_removed" && strings.Contains(raw, runA) {
			removed++
		}
	}
	if removed != 1 {
		t.Fatalf("the page got run_removed %d times", removed)
	}
	// The id is no record's any more: the run service answers.
	if text := f.refuses(p, http.StatusNotFound, "", "GET", at, ""); text != runs.ErrNotFound.Error() {
		t.Fatalf("the read of a deleted record: %q", text)
	}
	if rv, ok := f.runNow(p, runB); !ok || rv.Server != f.entry {
		t.Fatalf("the other record: %+v, %v", rv, ok)
	}
}

// Each row of the table of a run agent's chat: the reads are passed on as they came, the page
// that read follows the chat, and every other route is refused with nothing sent.
func TestRunAgentRoutes(t *testing.T) {
	f := newFar(t, farOpt{chats: []model.ChatView{viewThere(recA)}, runs: []model.RunView{runThere(runA)}})
	p, other := f.page("P"), f.page("Q")
	at := "/api/chats/" + agentA
	// Before the relay has learned the chat, the id is nobody's.
	f.untouched("a chat nobody knows", func() {
		f.refuses(p, http.StatusNotFound, "", "GET", at, "")
	})
	f.learnAgent(p, runA, agentA)

	agent := viewThere(agentA)
	agent.Run, agent.Group, agent.Name = runA, "", "T01-work"
	f.mu.Lock()
	f.views[agentA] = agent
	f.mu.Unlock()
	if got := f.good(p, "GET", at, ""); got["id"] != agentA || got["run"] != runA || got["name"] != "T01-work" {
		t.Fatalf("the agent's chat: %v", got)
	}
	for i, row := range []struct{ pat, rest, query string }{
		{"GET /api/chats/{id}/items", "/items", "branch=main"},
		{"GET /api/chats/{id}/tree", "/tree", ""},
		{"GET /api/chats/{id}/subagents/{sid}/items", "/subagents/sub-1/items", "branch=b1"},
		{"GET /api/chats/{id}/context", "/context", "fresh=1"},
	} {
		for _, status := range []int{http.StatusOK, http.StatusConflict} {
			want := map[string]any{"row": float64(i), "status": float64(status)}
			if status != http.StatusOK {
				want["error"], want["code"] = "refused there", "busy"
			}
			f.answer(row.pat, status, want)
			code, out := f.call(p, "GET", at+row.rest+"?"+row.query, "")
			if code != status || !reflect.DeepEqual(decode[map[string]any](t, out), want) {
				t.Errorf("GET %s: %d %s, want %d %v", row.rest, code, out, status, want)
			}
			if c := f.last(row.pat); c.Path != at+row.rest || !sameQuery(c.Query, row.query) {
				t.Errorf("GET %s there: %+v", row.rest, c)
			}
		}
		f.handle(row.pat, nil)
	}
	// The page that read the items follows the chat: the events come as the bytes they are.
	f.events()
	ev := `{"type":"chat_items","chat":"` + agentA + `","branch":"main","version":4,"items":[{"kind":"text","text":"working"}]}`
	f.st.Send(json.RawMessage(ev))
	evs := f.events(p, other)
	if !slices.Contains(evs[0], ev) || len(evs[1]) != 0 {
		t.Fatalf("the follower got %v, the other page %v", evs[0], evs[1])
	}
	if got := f.good(p, "POST", at+"/unfollow", ""); got["ok"] != true {
		t.Fatalf("the unfollow: %v", got)
	}
	f.st.Send(json.RawMessage(ev))
	if evs = f.events(p); len(evs[0]) != 0 {
		t.Fatalf("after the unfollow the page got %v", evs[0])
	}

	// Everything else is refused here: the chat is a run's agent's.
	bodies := map[string]string{
		"POST /api/chats/{id}/messages":   `{"text":"hi"}`,
		"POST /api/chats/{id}/permission": `{"requestId":"r","allow":true}`,
		"PUT /api/chats/{id}/label":       `{"branch":"main","item":1,"text":"x"}`,
		"PUT /api/chats/{id}/draft":       `{"text":"x"}`,
		"PATCH /api/chats/{id}":           `{"name":"mine"}`,
		"POST /api/chats/{id}/fork":       `{"branch":"main","at":1}`,
	}
	passed := []string{"GET /api/chats/{id}", "GET /api/chats/{id}/items", "GET /api/chats/{id}/tree",
		"GET /api/chats/{id}/subagents/{sid}/items", "GET /api/chats/{id}/context", "POST /api/chats/{id}/unfollow"}
	refused := 0
	f.untouched("a refused route of an agent's chat", func() {
		for _, pat := range f.s.runAgentRoutes().patterns {
			if slices.Contains(passed, pat) {
				continue
			}
			refused++
			method, path, _ := strings.Cut(pat, " ")
			path = strings.NewReplacer("{id}", agentA).Replace(path)
			if text := f.refuses(p, http.StatusConflict, "", method, path, bodies[pat]); text != chats.ErrRunAgent.Error() {
				t.Errorf("%s: %q", pat, text)
			}
		}
	})
	if refused != 11 {
		t.Fatalf("%d routes were refused, want 11", refused)
	}
	// The chat record beside it is served by its own table, and the agent's chat is in no list.
	if got := f.good(p, "GET", "/api/chats/"+recA, ""); got["server"] != f.entry {
		t.Fatalf("the chat record: %v", got)
	}
	if _, listed := f.chatNow(p, agentA); listed {
		t.Fatal("the snapshot lists the agent's chat")
	}
	// With the run the chat is nobody's again.
	f.good(p, "DELETE", "/api/runs/"+runA, "")
	f.untouched("the chat of a deleted run", func() {
		f.refuses(p, http.StatusNotFound, "", "GET", at, "")
		f.refuses(p, http.StatusNotFound, "", "POST", at+"/messages", `{"text":"hi"}`)
	})
}

// A call that cannot be made, per case of the design's table, through the routes.
func TestRunCallsThatCannotBeMade(t *testing.T) {
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA), runThere(runB)},
		limits: remotes.Limits{Call: 300 * time.Millisecond, Start: 300 * time.Millisecond, RunDelete: 300 * time.Millisecond}})
	p := f.page("P")
	f.learnAgent(p, runA, agentA)
	at := "/api/runs/" + runA

	// Another answer than "no such run" is the server's own: handed on, and the run stays.
	f.answer("GET /api/runs/{id}/goal", http.StatusNotFound, map[string]any{"error": "no such task"})
	if text := f.refuses(p, http.StatusNotFound, "", "GET", at+"/goal", ""); text != "no such task" || !f.rm.HasRun(runA) {
		t.Fatalf("a refusal of the server: %q", text)
	}
	// No answer: 504, and the record stays, for a delete too.
	f.hang("POST /api/runs/{id}/stop")
	if text := f.refuses(p, http.StatusGatewayTimeout, "no_answer", "POST", at+"/stop", ""); text != "Studio did not answer." {
		t.Fatalf("no answer: %q", text)
	}
	f.hang("DELETE /api/runs/{id}")
	f.refuses(p, http.StatusGatewayTimeout, "no_answer", "DELETE", at, "")
	if _, ok := f.runNow(p, runA); !ok {
		t.Fatal("a delete with no answer removed the record")
	}
	f.handle("DELETE /api/runs/{id}", nil)
	// The server has the run no more: the record is marked, and stays listed.
	f.answer("GET /api/runs/{id}/detail", http.StatusNotFound, map[string]any{"error": runs.ErrNotFound.Error()})
	if text := f.refuses(p, http.StatusNotFound, "gone_there", "GET", "/api/runs/"+runB+"/detail", ""); text != "This run is no longer on Studio." {
		t.Fatalf("a run that is gone there: %q", text)
	}
	if rv, ok := f.runNow(p, runB); !ok || !rv.Gone {
		t.Fatalf("the gone record in the snapshot: %+v, %v", rv, ok)
	}
	f.untouched("the removal of a gone record", func() { f.good(p, "DELETE", "/api/runs/"+runB+"?local=1", "") })
	if _, ok := f.runNow(p, runB); ok {
		t.Fatal("the gone record is still listed")
	}

	// Not connected: 503 at once and nothing sent; the record stays listed with its last view.
	f.down()
	began := time.Now()
	f.untouched("calls with the server away", func() {
		for _, c := range [][2]string{{"GET", at}, {"GET", at + "/detail"}, {"GET", at + "/goal"}, {"POST", at + "/stop"},
			{"POST", at + "/apply"}, {"PATCH", at}, {"DELETE", at}, {"GET", "/api/chats/" + agentA}, {"GET", "/api/chats/" + agentA + "/items"}} {
			body := ""
			if c[0] == "PATCH" {
				body = `{"name":"x"}`
			}
			if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", c[0], c[1], body); text != "Studio is not connected." {
				t.Errorf("%s %s: %q", c[0], c[1], text)
			}
		}
		// What is this server's still works: the place, the start's answer, the mark.
		g := f.group(p, "Work", "")
		f.good(p, "PATCH", at, form("group", g))
		f.good(p, "POST", at+"/start", `{"goal":"x"}`)
		f.good(p, "POST", at+"/archive", "")
	})
	if took := time.Since(began); took > 5*time.Second {
		t.Fatalf("the calls with the server away took %v", took)
	}
	if rv, ok := f.runNow(p, runA); !ok || rv.Name != "Run aa" || !rv.Archived || rv.Gone {
		t.Fatalf("the record while its server is away: %+v, %v", rv, ok)
	}
	// "This sidebar only" is accepted now.
	f.good(p, "DELETE", at+"?local=1", "")
	if _, ok := f.runNow(p, runA); ok {
		t.Fatal("the record is listed after its removal")
	}
}

// On the remote listener a run record's id and the id of an agent's chat are nobody's: this
// server passes nothing on for its API clients, and tells them nothing of the record.
func TestRemoteListenerPassesNoRunOn(t *testing.T) {
	l := newListener(t)
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA)}, with: []func(*Server){l.set}})
	l.serve(f.s)
	p := f.page("P")
	f.learnAgent(p, runA, agentA)
	f.good(p, "GET", "/api/runs/"+runA, "") // the record answers a page

	f.untouched("an API client", func() {
		bodies := map[string]string{
			"PATCH /api/runs/{id}":            `{"name":"theirs"}`,
			"POST /api/chats/{id}/messages":   `{"text":"hi"}`,
			"POST /api/chats/{id}/permission": `{"requestId":"r","allow":true}`,
			"PUT /api/chats/{id}/label":       `{"branch":"main","item":1,"text":"x"}`,
			"PUT /api/chats/{id}/draft":       `{"text":"x"}`,
			"PATCH /api/chats/{id}":           `{"name":"theirs"}`,
			"POST /api/chats/{id}/fork":       `{"branch":"main","at":1}`,
		}
		for _, table := range []struct {
			id   string
			pats []string
		}{{runA, f.s.runRecordRoutes().patterns}, {agentA, f.s.runAgentRoutes().patterns}} {
			for _, pat := range table.pats {
				method, path, _ := strings.Cut(pat, " ")
				path = strings.NewReplacer("{id}", table.id, "{sid}", "sub-1", "{tid}", "T1", "{n}", "1", "{v}", "1").Replace(path)
				status, out := l.call(apiX, testSecret, method, path, bodies[pat])
				if strings.Contains(out, "Run aa") || strings.Contains(out, f.entry) || strings.Contains(out, "standin") {
					t.Errorf("%s on the remote listener tells of the record: %s", pat, out)
				}
				switch pat {
				case "POST /api/runs/{id}/unfollow", "POST /api/chats/{id}/unfollow":
					continue // ends a follow of any id, as for every item that is not there
				case "PUT /api/runs/{id}":
					// The API client's own start call: refused for what it lacks, as for any id.
					if status != http.StatusBadRequest || !strings.Contains(out, `"started":false`) {
						t.Errorf("a start call with a record's id: %d %s", status, out)
					}
					continue
				}
				if status != http.StatusNotFound {
					t.Errorf("%s on the remote listener: %d %s, want 404", pat, status, out)
				}
			}
		}
		// The API client's snapshot has no record.
		status, out := l.call(apiX, testSecret, "GET", "/api/state", "")
		if status != http.StatusOK || strings.Contains(out, runA) || strings.Contains(out, "standin") {
			t.Errorf("the API client's snapshot: %d %s", status, out)
		}
	})
	if rv, ok := f.runNow(p, runA); !ok || rv.Name != "Run aa" || rv.Archived {
		t.Fatalf("the record after the API client's calls: %+v, listed %v", rv, ok)
	}
}

// The known-client rule holds for the routes of both tables: a call that is no read, from a
// client without an open stream, is refused before the table and reaches no server.
func TestRunRecordRoutesNeedAKnownClient(t *testing.T) {
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA)}})
	p := f.page("P")
	f.learnAgent(p, runA, agentA)
	f.untouched("a client nobody knows", func() {
		for _, c := range [][3]string{
			{"POST", "/api/runs/" + runA + "/stop", ""}, {"PATCH", "/api/runs/" + runA, `{"name":"x"}`},
			{"DELETE", "/api/runs/" + runA, ""}, {"POST", "/api/runs/" + runA + "/archive", ""},
			{"POST", "/api/runs/" + runA + "/start", `{"goal":"x"}`}, {"POST", "/api/chats/" + agentA + "/unfollow", ""},
		} {
			for _, client := range []string{"nobody", ""} {
				status, out := f.doAs(client, c[0], c[1], c[2])
				if status != http.StatusConflict || !strings.Contains(out, "unknown_client") {
					t.Errorf("%s %s as %q: %d %s", c[0], c[1], client, status, out)
				}
			}
		}
	})
	if rv, ok := f.runNow(p, runA); !ok || rv.Archived || rv.Name != "Run aa" {
		t.Fatalf("the record after the refused calls: %+v, %v", rv, ok)
	}
	// The known page's call is made.
	f.good(p, "POST", "/api/runs/"+runA+"/stop", "")
}

// The start route: a remote draft's start is the relay's start call, a record's is answered
// here, and a draft of this server starts as before.
func TestStartOfARunOnAnotherServer(t *testing.T) {
	f := newFar(t, farOpt{local: true})
	p := f.page("P")
	g := f.group(p, "Work", "")

	// The draft: made here, put on the entry with that server's agent, model and folder.
	d := f.remoteDraft(p, g)
	if d.Server != f.entry || d.Agent != model.Claude || d.Cwd != "/home/standin/work" || d.Tiers.Deep.Model != "standin-model" || d.Status != model.RunDraft {
		t.Fatalf("the draft on the entry: %+v", d)
	}
	if n := len(f.sent("PUT /api/runs/{id}")); n != 0 {
		t.Fatalf("the stand-in got %d start calls before the start", n)
	}
	at := "/api/runs/" + d.ID
	// The folder is that server's: its check says what the view shows.
	f.answer("GET /api/runs/check", http.StatusOK, runs.DraftFacts{Cwd: "/srv/code", Git: true, Dirty: true})
	got := decode[model.RunView](t, mustOK(t, f, p, "PATCH", at, form("cwd", "~/code")))
	if c := f.last("GET /api/runs/check"); got.Cwd != "/srv/code" || !got.Git || !sameQuery(c.Query, "agent=claude&cwd=~/code") {
		t.Fatalf("the folder of the draft: %+v, asked %+v", got, c)
	}
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Server != f.entry || rv.Status != model.RunDraft || rv.Group != g {
		t.Fatalf("the draft in the snapshot: %+v, %v", rv, ok)
	}
	f.events()

	// A blank goal is refused before anything is sent.
	f.untouched("a start without a goal", func() {
		f.refuses(p, http.StatusBadRequest, "", "POST", at+"/start", `{"goal":"  "}`)
	})
	// The start: one start call there; the answer is the record's view.
	started := decode[model.RunView](t, mustOK(t, f, p, "POST", at+"/start", form("goal", "Write the note")))
	if started.ID != d.ID || started.Server != f.entry || started.Group != g || started.Started.IsZero() || started.Status != model.RunRunning || started.Cwd != "/srv/code" {
		t.Fatalf("the start's answer: %+v", started)
	}
	calls := f.sent("PUT /api/runs/{id}")
	if len(calls) != 1 || calls[0].Path != at {
		t.Fatalf("the start calls: %+v", calls)
	}
	var body map[string]any
	json.Unmarshal([]byte(calls[0].Body), &body)
	if body["goal"] != "Write the note" || body["cwd"] != "/srv/code" || body["agent"] != "claude" || body["group"] != nil || body["id"] != nil {
		t.Fatalf("the start call's body: %s", calls[0].Body)
	}
	// The run is a record under the draft's id, and the draft is gone: listed once.
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Server != f.entry || rv.Status != model.RunRunning || rv.Group != g || !f.rm.HasRun(d.ID) {
		t.Fatalf("the started run in the snapshot: %+v, %v", rv, ok)
	}
	if _, draft := f.rs.RemoteDraft(d.ID); draft {
		t.Fatal("the draft is still there after its start")
	}
	runEvents, removed := 0, 0
	for _, raw := range f.events(p)[0] {
		switch typeOf(raw) {
		case "run":
			runEvents++
		case "run_removed":
			removed++
		}
	}
	if runEvents == 0 || removed != 0 {
		t.Fatalf("the page got %d run events and %d run_removed", runEvents, removed)
	}
	// A repeat by the page: 200 with the view, nothing sent.
	f.untouched("a repeated start", func() {
		again := decode[model.RunView](t, mustOK(t, f, p, "POST", at+"/start", form("goal", "Write the note")))
		if again.ID != d.ID || again.Server != f.entry || again.Started.IsZero() {
			t.Errorf("the repeat's answer: %+v", again)
		}
	})

	// A draft of this server starts here: the run service answers, a refusal too, and nothing
	// is asked of the other server.
	own := decode[model.RunView](t, mustOK(t, f, p, "POST", "/api/runs", form("group", g)))
	f.untouched("the start of a run of this server", func() {
		if text := f.refuses(p, http.StatusBadRequest, "", "POST", "/api/runs/"+own.ID+"/start", `{"goal":""}`); text != runs.ErrNoGoal.Error() {
			t.Errorf("a start without a goal: %q", text)
		}
		f.refuses(p, http.StatusNotFound, "", "POST", "/api/runs/r_none0000/start", `{"goal":"x"}`)
	})

	// The server's refusal reaches the page with its sentence and code, and the draft stays.
	d2 := f.remoteDraft(p, g)
	f.answer("PUT /api/runs/{id}", http.StatusConflict, map[string]any{"started": false, "made": false, "error": "folder not found: /srv/gone", "code": "folder_missing"})
	if text := f.refuses(p, http.StatusConflict, "folder_missing", "POST", "/api/runs/"+d2.ID+"/start", form("goal", "x")); text != "folder not found: /srv/gone" {
		t.Fatalf("a refused start: %q", text)
	}
	// A server without run routes.
	f.answer("PUT /api/runs/{id}", http.StatusNotFound, map[string]any{"error": "not found"})
	if text := f.refuses(p, http.StatusConflict, "runs_unsupported", "POST", "/api/runs/"+d2.ID+"/start", form("goal", "x")); text != "Studio cannot run runs: update it." {
		t.Fatalf("a server without run routes: %q", text)
	}
	if rv, ok := f.runNow(p, d2.ID); !ok || rv.Status != model.RunDraft || rv.Start != "" || f.rm.HasRun(d2.ID) {
		t.Fatalf("the draft after the refused starts: %+v, %v", rv, ok)
	}
	// Away: 503, and the draft stays.
	f.down()
	if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/runs/"+d2.ID+"/start", form("goal", "x")); text != "Studio is not connected." {
		t.Fatalf("a start with the server away: %q", text)
	}
}

// The start call is not ended by the page that asked: the page leaves while the other server
// works, and the run is a record all the same.
func TestStartOutlivesThePageThatAsked(t *testing.T) {
	f := newFar(t, farOpt{local: true})
	p := f.page("P")
	d := f.remoteDraft(p, model.Ungrouped)
	arrived, free := make(chan struct{}), make(chan struct{})
	usual := f.usualRuns()["PUT /api/runs/{id}"]
	f.handle("PUT /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		select {
		case <-free:
			usual(w, r)
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		req, _ := http.NewRequestWithContext(ctx, "POST", f.url+"/api/runs/"+d.ID+"/start", strings.NewReader(`{"goal":"Write the note"}`))
		req.Header.Set(ClientHeader, p.ID)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
		done <- err
	}()
	<-arrived
	cancel()
	if err := <-done; err == nil {
		t.Fatal("the page's call ended with an answer")
	}
	time.Sleep(50 * time.Millisecond) // the server has seen the page leave
	close(free)
	f.wait("the run is a record", func() bool { return f.rm.HasRun(d.ID) })
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Server != f.entry || rv.Status != model.RunRunning {
		t.Fatalf("the run after the page left: %+v, %v", rv, ok)
	}
	if n := len(f.sent("PUT /api/runs/{id}")); n != 1 {
		t.Fatalf("the stand-in got %d start calls", n)
	}
}

// The errors of a draft run's server and of a chat on such a run have their statuses and codes,
// in the table and through the routes.
func TestRunServerErrors(t *testing.T) {
	for _, c := range []struct {
		err    error
		status int
		code   string
	}{
		{runs.ErrRunsUnsupported, http.StatusConflict, "runs_unsupported"},
		{runs.ErrRunHasChats, http.StatusConflict, "run_has_chats"},
		{runs.ErrStartUnconfirmed, http.StatusConflict, "start_unconfirmed"},
		{runs.ErrRemoteStart, http.StatusConflict, "remote_start"},
		{runs.ErrStarting, http.StatusConflict, "busy"},
		{chats.ErrRunNotStarted, http.StatusConflict, "run_not_started"},
		{chats.ErrServerUnknown, http.StatusBadRequest, ""},
		{chats.ErrServerUnusable, http.StatusConflict, "server_unusable"},
		{chats.ErrServerUnreachable, http.StatusServiceUnavailable, "server_unreachable"},
		{&usable.MissingError{Agent: model.Pi}, http.StatusConflict, "agent_missing"},
		{chats.ErrFolderMissing, http.StatusConflict, ""}, // the run's patch route gives it folder_missing
	} {
		for _, err := range []error{c.err, fmt.Errorf("patch: %w", c.err)} {
			for _, fallback := range []int{http.StatusBadRequest, http.StatusInternalServerError} {
				if got := statusOf(err, fallback); got != c.status || codeOf(err) != c.code {
					t.Errorf("%v: %d %q, want %d %q", err, got, codeOf(err), c.status, c.code)
				}
			}
		}
	}

	f := newFar(t, farOpt{local: true, limits: remotes.Limits{Start: 200 * time.Millisecond, Settle: 200 * time.Millisecond}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	// A draft of this server with a chat on it cannot go to another server.
	own := decode[model.RunView](t, mustOK(t, f, p, "POST", "/api/runs", form("group", g)))
	mustOK(t, f, p, "POST", "/api/chats", form("run", own.ID))
	f.untouched("refused choices", func() {
		f.refuses(p, http.StatusConflict, "run_has_chats", "PATCH", "/api/runs/"+own.ID, form("server", f.entry))
		free := decode[model.RunView](t, mustOK(t, f, p, "POST", "/api/runs", form("group", g)))
		if text := f.refuses(p, http.StatusBadRequest, "", "PATCH", "/api/runs/"+free.ID, form("server", noSuchServer)); text != chats.ErrServerUnknown.Error() {
			t.Errorf("a server that is not in the list: %q", text)
		}
	})
	d := f.remoteDraft(p, g)
	at := "/api/runs/" + d.ID
	// An agent that server does not have, and a chat on a run that has not started there.
	f.untouched("refused choices of a remote draft", func() {
		f.refuses(p, http.StatusConflict, "agent_missing", "PATCH", at, form("agent", "cursor"))
		f.refuses(p, http.StatusConflict, "run_not_started", "POST", "/api/chats", form("run", d.ID))
	})
	// A folder that server does not have.
	f.answer("GET /api/runs/check", http.StatusOK, runs.DraftFacts{Cwd: "/srv/gone", FolderMissing: true})
	if text := f.refuses(p, http.StatusConflict, "folder_missing", "PATCH", at, form("cwd", "/srv/gone")); !strings.Contains(text, "/srv/gone") {
		t.Fatalf("a folder that is not there: %q", text)
	}
	f.handle("GET /api/runs/check", nil)
	// A start with no answer, and none to the read after it: not known, and the choices are fixed.
	f.hang("PUT /api/runs/{id}")
	f.hang("GET /api/runs/{id}")
	f.refuses(p, http.StatusGatewayTimeout, "start_unconfirmed", "POST", at+"/start", form("goal", "Write the note"))
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Start != model.RemoteUnconfirmed || rv.Status != model.RunDraft {
		t.Fatalf("the draft after a start with no answer: %+v, %v", rv, ok)
	}
	f.refuses(p, http.StatusConflict, "start_unconfirmed", "PATCH", at, form("agent", "pi"))
	f.refuses(p, http.StatusConflict, "start_unconfirmed", "PATCH", at, form("server", "local"))
	// While the server is away the folder cannot be checked: the sentence names the server, as
	// that of a call for a started run on it does.
	d2 := f.remoteDraft(p, g)
	f.down()
	if text := f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "PATCH", "/api/runs/"+d2.ID, form("cwd", "/srv/other")); text != "Studio is not connected." {
		t.Errorf("a folder while the server is away: %q", text)
	}
}

// A start call got no answer, and the other server finishes the start after this one took its
// snapshot: it lists a run only when the start is done. The draft keeps its mark while the read
// of the run tells nothing, and the run's event puts the record in its place; with a read that
// says "no such run" the mark is cleared, and the event still makes the swap.
func TestRunStartThatEndsAfterTheSnapshot(t *testing.T) {
	f := newFar(t, farOpt{local: true, limits: remotes.Limits{Start: 200 * time.Millisecond, Settle: 200 * time.Millisecond}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	// started tells how many `run` events of the id, as a started run, the page got.
	started := func(id string) (n int) {
		t.Helper()
		for _, raw := range f.events(p)[0] {
			var ev struct {
				Type string
				Run  model.RunView
			}
			json.Unmarshal([]byte(raw), &ev)
			if ev.Type == "run" && ev.Run.ID == id && !ev.Run.Started.IsZero() && ev.Run.Status.Started() {
				n++
			}
		}
		return n
	}
	// finished is the other server's end of the start: it has the run, and says so.
	finished := func(id string) {
		t.Helper()
		v := runThere(id)
		f.mu.Lock()
		f.runs[id] = v
		f.mu.Unlock()
		f.st.Send(map[string]any{"type": "run", "run": v})
		f.wait("the run is a record", func() bool { return f.rm.HasRun(id) && !f.rm.Starting(id) })
	}
	// back reads the page up to the return of the entry: the lists of its snapshot come before.
	back := func() {
		for typeOf(p.NextRaw()) != "server_back" {
		}
	}
	reads := func(id string) (n int) {
		for _, c := range f.sent("GET /api/runs/{id}") {
			if c.Path == "/api/runs/"+id {
				n++
			}
		}
		return n
	}

	// 1. The start gets no answer, and neither does the read after it.
	d := f.remoteDraft(p, g)
	at := "/api/runs/" + d.ID
	f.hang("PUT /api/runs/{id}")
	f.hang("GET /api/runs/{id}")
	f.refuses(p, http.StatusGatewayTimeout, "start_unconfirmed", "POST", at+"/start", form("goal", "Write the note"))
	// 2. The stream drops and returns with a snapshot that does not have the run. The read that
	// settles the draft gets no answer: the mark stays.
	f.st.DropStreams()
	f.returned(2)
	f.wait("the snapshot's read of the run has ended", func() bool { return reads(d.ID) == 2 && !f.rm.Starting(d.ID) })
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Start != model.RemoteUnconfirmed || rv.Status != model.RunDraft || f.rm.HasRun(d.ID) {
		t.Fatalf("the draft after the snapshot without its run: %+v, %v", rv, ok)
	}
	back()
	f.events()
	// 3. The other server has finished the start, and sends the run.
	f.handle("GET /api/runs/{id}", nil)
	finished(d.ID)
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Status != model.RunRunning || rv.Started.IsZero() || rv.Server != f.entry || rv.Group != g || rv.Start != "" {
		t.Fatalf("the run after its event: %+v, %v", rv, ok)
	}
	if _, draft := f.rs.RemoteDraft(d.ID); draft {
		t.Fatal("the draft is still there after the run's event")
	}
	if n := started(d.ID); n != 1 {
		t.Fatalf("the page got %d events of the started run, want 1", n)
	}
	if n := reads(d.ID); n != 2 {
		t.Errorf("the swap at an event read the run: %d reads", n)
	}
	// 4. It is a started run: its server cannot be changed.
	if text := f.refuses(p, http.StatusConflict, "", "PATCH", at, form("server", "local")); text != runs.ErrStarted.Error() {
		t.Errorf("a server change of the started run: %q", text)
	}
	// 5. Its delete is made on its server.
	mustOK(t, f, p, "DELETE", at, "")
	if calls := f.sent("DELETE /api/runs/{id}"); len(calls) != 1 || calls[0].Path != at {
		t.Fatalf("the delete calls: %+v", calls)
	}
	if _, ok := f.runNow(p, d.ID); ok {
		t.Fatal("the deleted run is still listed")
	}

	// The read answers "no such run": the mark is cleared. The run's event makes the swap all
	// the same when the other server did start it.
	d2 := f.remoteDraft(p, g)
	f.hang("GET /api/runs/{id}")
	f.refuses(p, http.StatusGatewayTimeout, "start_unconfirmed", "POST", "/api/runs/"+d2.ID+"/start", form("goal", "Write the note"))
	f.handle("GET /api/runs/{id}", nil) // the stand-in has no such run
	f.st.DropStreams()
	f.returned(3)
	f.wait("the mark is cleared", func() bool {
		rv, ok := f.runNow(p, d2.ID)
		return ok && rv.Start == "" && !f.rm.Starting(d2.ID)
	})
	if rv, ok := f.runNow(p, d2.ID); !ok || rv.Status != model.RunDraft || f.rm.HasRun(d2.ID) {
		t.Fatalf("the draft after the read: %+v, %v", rv, ok)
	}
	back()
	f.events()
	finished(d2.ID)
	if rv, ok := f.runNow(p, d2.ID); !ok || rv.Status != model.RunRunning || rv.Server != f.entry {
		t.Fatalf("the second run after its event: %+v, %v", rv, ok)
	}
	if _, draft := f.rs.RemoteDraft(d2.ID); draft || started(d2.ID) != 1 {
		t.Fatal("the second draft is still there, or the page was not told once")
	}
	if n := len(f.sent("PUT /api/runs/{id}")); n != 2 {
		t.Errorf("the stand-in got %d start calls, want one for each draft", n)
	}
}

// While the start call of a draft is under way, what it sends is fixed and the draft cannot be
// deleted: 409 busy. A rename and the goal's draft text stay free. When the other server
// answers, the run is one record and no draft.
func TestRunChangedWhileItsStartIsMade(t *testing.T) {
	f := newFar(t, farOpt{local: true})
	p := f.page("P")
	g := f.group(p, "Work", "")
	d := f.remoteDraft(p, g)
	at := "/api/runs/" + d.ID
	arrived, free := make(chan struct{}), make(chan struct{})
	usual := f.usualRuns()["PUT /api/runs/{id}"]
	f.handle("PUT /api/runs/{id}", func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		select {
		case <-free:
			usual(w, r)
		case <-r.Context().Done():
		}
	})
	type answer struct {
		status int
		body   string
	}
	done := make(chan answer, 1)
	go func() {
		status, out := p.Do("POST", at+"/start", form("goal", "Write the note"))
		done <- answer{status, string(out)}
	}()
	<-arrived

	const busy = "The run is being started."
	for _, body := range []string{form("server", "local"), form("agent", "pi"), form("cwd", "/srv/other"),
		form("tiers", map[string]any{"deep": map[string]any{"effort": "high"}}), form("settings", map[string]any{"maxParallel": 2})} {
		if text := f.refuses(p, http.StatusConflict, "busy", "PATCH", at, body); text != busy {
			t.Errorf("PATCH %s while the start is made: %q", body, text)
		}
	}
	if text := f.refuses(p, http.StatusConflict, "busy", "DELETE", at, ""); text != busy {
		t.Errorf("DELETE while the start is made: %q", text)
	}
	if text := f.refuses(p, http.StatusConflict, "busy", "POST", at+"/start", form("goal", "Another")); text != busy {
		t.Errorf("a second start while the start is made: %q", text)
	}
	if rv := decode[model.RunView](t, mustOK(t, f, p, "PATCH", at, form("name", "Renamed"))); rv.Name != "Renamed" || rv.Status != model.RunDraft {
		t.Errorf("a rename while the start is made: %+v", rv)
	}
	mustOK(t, f, p, "PUT", at+"/draft", form("text", "typed on"))
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Server != f.entry || rv.Status != model.RunDraft || rv.Agent != d.Agent || rv.Cwd != d.Cwd {
		t.Fatalf("the draft while the start is made: %+v, %v", rv, ok)
	}

	close(free)
	if a := <-done; a.status != http.StatusOK {
		t.Fatalf("the start: %d %s", a.status, a.body)
	}
	if rv, ok := f.runNow(p, d.ID); !ok || rv.Status != model.RunRunning || rv.Server != f.entry || !f.rm.HasRun(d.ID) {
		t.Fatalf("the run after the answer: %+v, %v", rv, ok)
	}
	if _, draft := f.rs.RemoteDraft(d.ID); draft || len(f.rs.Views()) != 0 {
		t.Fatalf("the run service still has %d runs after the start", len(f.rs.Views()))
	}
	if n := len(f.sent("DELETE /api/runs/{id}")); n != 0 || len(f.sent("PUT /api/runs/{id}")) != 1 {
		t.Errorf("the stand-in got %d deletes and %d start calls", n, len(f.sent("PUT /api/runs/{id}")))
	}
}

// Removing an entry removes the unstarted chats people made on its runs with them: such a chat
// would be a chat on no run.
func TestEntryRemovalTakesTheChatsOnItsRuns(t *testing.T) {
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA)}})
	p := f.page("P")
	c := decode[model.ChatView](t, mustOK(t, f, p, "POST", "/api/chats", form("run", runA)))
	if cv, ok := f.chatNow(p, c.ID); !ok || cv.Run != runA || cv.Server != f.entry {
		t.Fatalf("the chat on the run: %+v, %v", cv, ok)
	}
	f.events()
	mustOK(t, f, p, "DELETE", "/api/servers/"+f.entry, "")
	f.wait("the run record is gone", func() bool { return !f.rm.HasRun(runA) })
	removed := map[string]int{}
	for _, raw := range p.Drain(300 * time.Millisecond) {
		var ev struct{ Type, ID string }
		json.Unmarshal([]byte(raw), &ev)
		if ev.Type == "chat_removed" || ev.Type == "run_removed" {
			removed[ev.Type+" "+ev.ID]++
		}
	}
	if removed["chat_removed "+c.ID] != 1 || removed["run_removed "+runA] != 1 {
		t.Errorf("the page got %v", removed)
	}
	if cv, ok := f.chatNow(p, c.ID); ok {
		t.Errorf("the chat on the removed run is still listed: %+v", cv)
	}
	if _, ok := f.runNow(p, runA); ok {
		t.Error("the run of the removed entry is still listed")
	}
	if people, _ := f.a.Chats.ChatsOfRun(runA); len(people) != 0 {
		t.Errorf("the chat manager still has %+v", people)
	}
}

// The archive, the unarchive and the delete of a group through the routes, with run records in
// it: the records go with the group, an unarchive of one record brings its groups back, and a
// delete with the server away deletes nothing (AC33).
func TestGroupRoutesWithRunRecords(t *testing.T) {
	onRun := viewThere(recA)
	onRun.Run, onRun.Group = runA, ""
	f := newFar(t, farOpt{chats: []model.ChatView{onRun}, runs: []model.RunView{runThere(runA), runThere(runB)}})
	p := f.page("P")
	g := f.group(p, "Work", "")
	sub := f.group(p, "Deep", g)
	f.good(p, "PATCH", "/api/runs/"+runA, form("group", g))
	f.good(p, "PATCH", "/api/runs/"+runB, form("group", sub))
	draft := decode[model.RunView](t, mustOK(t, f, p, "POST", "/api/runs", form("group", sub)))

	f.good(p, "POST", "/api/groups/"+g+"/archive", "")
	a, _ := f.runNow(p, runA)
	b, _ := f.runNow(p, runB)
	o, _ := f.runNow(p, draft.ID)
	if !a.Archived || !b.Archived || !o.Archived || a.Op == "" || a.Op != b.Op || a.Op != o.Op || !f.groupArchived(p, g) || !f.groupArchived(p, sub) {
		t.Fatalf("after the group's archive: %+v, %+v, %+v", a.Archive, b.Archive, o.Archive)
	}
	if n := len(f.sent("POST /api/runs/{id}/archive")); n != 2 {
		t.Fatalf("the stand-in got %d archive calls, want 2", n)
	}
	// One record comes back: with it the groups it is nested in, and nothing else in them.
	f.good(p, "POST", "/api/runs/"+runB+"/unarchive", "")
	a, _ = f.runNow(p, runA)
	b, _ = f.runNow(p, runB)
	if b.Archived || !a.Archived || f.groupArchived(p, g) || f.groupArchived(p, sub) {
		t.Fatalf("after the unarchive of one record: %+v, %+v", a.Archive, b.Archive)
	}
	// The group's unarchive brings back what its archive archived: the record that came back
	// alone and was archived again with the group, not what an earlier action archived.
	f.good(p, "POST", "/api/groups/"+g+"/archive", "")
	f.good(p, "POST", "/api/groups/"+g+"/unarchive", "")
	a, _ = f.runNow(p, runA)
	b, _ = f.runNow(p, runB)
	if o, _ = f.runNow(p, draft.ID); !a.Archived || b.Archived || !o.Archived || f.groupArchived(p, g) {
		t.Fatalf("after the group's unarchive: %+v, %+v, %+v", a.Archive, b.Archive, o.Archive)
	}
	if n := len(f.sent("POST /api/runs/{id}/unarchive")); n != 2 {
		t.Fatalf("the stand-in got %d unarchive calls, want 2", n)
	}
	f.good(p, "POST", "/api/runs/"+runA+"/unarchive", "")
	f.good(p, "POST", "/api/runs/"+draft.ID+"/unarchive", "")

	// The server is away: nothing is deleted, here or there.
	f.down()
	f.untouched("a delete with the server away", func() {
		text := f.refuses(p, http.StatusConflict, "server_unreachable", "DELETE", "/api/groups/"+g+"?contents=delete", "")
		if text != "Nothing was deleted: “Run aa” is on Studio, which is not connected." && text != "Nothing was deleted: “Run bb” is on Studio, which is not connected." {
			t.Errorf("the refusal: %q", text)
		}
	})
	_, hasA := f.runNow(p, runA)
	_, hasB := f.runNow(p, runB)
	_, hasDraft := f.runNow(p, draft.ID)
	if !hasA || !hasB || !hasDraft || f.groupArchived(p, g) || f.groupArchived(p, sub) {
		t.Fatalf("after the refused delete: records %v %v, the draft %v", hasA, hasB, hasDraft)
	}
	// Without the contents nothing is asked: the records move up with the draft.
	f.untouched("a delete of the group alone", func() { f.good(p, "DELETE", "/api/groups/"+sub+"?contents=keep", "") })
	if b, _ = f.runNow(p, runB); b.Group != g {
		t.Fatalf("the record is in %q after its group was deleted alone", b.Group)
	}

	// Back: the delete deletes the runs there, then everything here; the chat record on a run
	// goes with its run.
	f.st.Restart()
	f.returned(2)
	f.good(p, "DELETE", "/api/groups/"+g+"?contents=delete", "")
	if n := len(f.sent("DELETE /api/runs/{id}")); n != 2 {
		t.Fatalf("the stand-in got %d delete calls, want 2", n)
	}
	_, hasA = f.runNow(p, runA)
	_, hasB = f.runNow(p, runB)
	_, hasDraft = f.runNow(p, draft.ID)
	if _, hasChat := f.chatNow(p, recA); hasA || hasB || hasDraft || hasChat || f.rm.HasRun(runA) || f.rm.HasRun(runB) || f.rm.Has(recA) {
		t.Fatalf("after the delete: records %v %v, the draft %v, the chat on the run %v", hasA, hasB, hasDraft, hasChat)
	}
}

// The secret of the entry is in no answer and no event of a run on its server: the rig checks
// every one a page got when the test ends. This test makes the calls whose answers are built
// from the entry.
func TestRunAnswersHoldNoSecret(t *testing.T) {
	f := newFar(t, farOpt{runs: []model.RunView{runThere(runA)}})
	p := f.page("P")
	f.learnAgent(p, runA, agentA)
	f.good(p, "GET", "/api/runs/"+runA, "")
	f.good(p, "GET", "/api/runs/"+runA+"/detail", "")
	f.good(p, "POST", "/api/runs/"+runA+"/stop", "")
	d := f.remoteDraft(p, model.Ungrouped)
	f.good(p, "GET", "/api/runs/"+d.ID, "")
	f.good(p, "POST", "/api/runs/"+d.ID+"/start", form("goal", "Write the note"))
	f.st.Send(map[string]any{"type": "run", "run": runThere(runA)})
	f.events()
	raw := mustOK(t, f, p, "GET", "/api/state", "")
	if strings.Contains(raw, standin.DefaultSecret) || !strings.Contains(raw, runA) || !strings.Contains(raw, d.ID) {
		t.Fatalf("the snapshot: %s", raw)
	}
	f.down()
	f.refuses(p, http.StatusServiceUnavailable, "server_unreachable", "POST", "/api/runs/"+runA+"/stop", "")
}
