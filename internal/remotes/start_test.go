package remotes

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"ai-whiteboard/internal/editorbridge"
	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/servers/standin"
)

// chatToken is the MCP token of the unstarted chats of the tests: it must leave this server nowhere.
const chatToken = "tok-0123456789abcdef"

// got is one request a scripted route received.
type got struct {
	Method, URI, Body string
}

// script is a route of the stand-in whose answer the test sets and whose requests it can read.
// Without an answer it says 404 "not found", as the stand-in does for a route it does not have.
type script struct {
	mu   sync.Mutex
	h    func(w http.ResponseWriter, r *http.Request)
	gots []got
}

// script makes the stand-in serve the pattern from a script. One pattern, one script per rig.
func (rg *rig) script(pattern string) *script {
	s := &script{}
	rg.s.Handle(pattern, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		s.mu.Lock()
		s.gots = append(s.gots, got{r.Method, r.URL.RequestURI(), string(body)})
		h := s.h
		s.mu.Unlock()
		if h == nil {
			writeAnswer(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		h(w, r)
	})
	return s
}

func (s *script) set(h func(w http.ResponseWriter, r *http.Request)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.h = h
}

// answer makes the route answer every request with the status and v as JSON.
func (s *script) answer(status int, v any) {
	s.set(func(w http.ResponseWriter, r *http.Request) { writeAnswer(w, status, v) })
}

// hang makes the route never answer: a request waits until it ends, or until release is called.
// arrived gets one value per request.
func (s *script) hang() (arrived <-chan struct{}, release func()) {
	in, out := make(chan struct{}, 64), make(chan struct{})
	s.set(func(w http.ResponseWriter, r *http.Request) {
		in <- struct{}{}
		select {
		case <-out:
			panic(http.ErrAbortHandler) // released: the request ends with no answer
		case <-r.Context().Done():
		}
	})
	var once sync.Once
	return in, func() { once.Do(func() { close(out) }) }
}

func (s *script) calls() []got {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]got(nil), s.gots...)
}

func (s *script) count() int { return len(s.calls()) }

func writeAnswer(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// chatN is the id of the n-th chat of a test.
func chatN(n int) string { return fmt.Sprintf("2%07d-0000-4000-8000-000000000000", n) }

// unstarted gives the fake chat manager a chat that will start on the rig's entry, with what is
// known of a first message (state).
func (rg *rig) unstarted(id, state string) model.ChatMeta {
	meta := model.ChatMeta{
		ID: id, Agent: model.Claude, Name: "First words", UserNamed: true, Group: "g_here", Server: rg.entry,
		RemoteStart: state, Cwd: "/home/standin/work", Model: "standin-model", Effort: "high", Token: chatToken,
		Drafts:    map[string]*model.Draft{mainBranch: {Text: "typed"}},
		DraftRevs: map[string]int64{mainBranch: 3},
	}
	rg.local.mu.Lock()
	rg.local.chats[id] = meta
	rg.local.mu.Unlock()
	return meta
}

// startOf is what the fake chat manager knows of the chat's first message; ok is false for a
// chat it no longer has.
func (rg *rig) startOf(id string) (state string, ok bool) {
	meta, ok := rg.local.RemoteUnstarted(id)
	return meta.RemoteStart, ok
}

// told are the states SetRemoteStart was called with for the chat, in order.
func (rg *rig) told(id string) []string {
	rg.local.mu.Lock()
	defer rg.local.mu.Unlock()
	out := []string{}
	for _, s := range rg.local.starts {
		if rest, ok := strings.CutPrefix(s, id+"="); ok {
			out = append(out, rest)
		}
	}
	return out
}

func (rg *rig) handedOver(id string) bool {
	rg.local.mu.Lock()
	defer rg.local.mu.Unlock()
	for _, h := range rg.local.handed {
		if h == id {
			return true
		}
	}
	return false
}

// startAnswer is the answer of the creation call, as the remote server writes it.
func startAnswerOf(started, sent bool, chat *model.ChatView, errText, code string) map[string]any {
	out := map[string]any{"started": started, "sent": sent}
	if chat != nil {
		out["chat"] = chat
	}
	if errText == "" {
		out["ok"] = true
	} else {
		out["error"] = errText
		if code != "" {
			out["code"] = code
		}
	}
	return out
}

// serveViews makes the read of a chat answer the view of that id with the status.
func serveViews(get *script, status model.Status) {
	get.set(func(w http.ResponseWriter, r *http.Request) {
		writeAnswer(w, http.StatusOK, remoteView(r.PathValue("id"), status))
	})
}

// noSecret fails the test when text holds the entry's secret or a chat's token.
func noSecret(t *testing.T, what, text string) {
	t.Helper()
	for _, secret := range []string{standin.DefaultSecret, chatToken} {
		if strings.Contains(text, secret) {
			t.Errorf("%s holds a secret: %s", what, text)
		}
	}
}

// TestStartTable: every row of the table of the creation call's answers.
func TestStartTable(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	serveViews(get, model.StatusThinking)
	follower, _ := rg.page("page-follows")

	rows := []struct {
		name    string
		prior   string // RemoteStart before the call
		status  int    // the answer of the creation call
		started bool
		chat    bool
		raw     any // the answer, when it is not the creation call's shape
		errText string
		code    string

		want      StartOutcome
		swapped   bool
		wantState string
	}{
		{name: "200 started", status: 200, started: true, chat: true,
			want: StartOutcome{Status: 200}, swapped: true},
		{name: "an error that says started (AC16 c)", status: 500, started: true, chat: true, errText: "the agent refused the message",
			want: StartOutcome{500, "the agent refused the message", ""}, swapped: true},
		{name: "409 folder_missing of a repeat of a started chat", prior: model.RemoteUnconfirmed, status: 409, started: true, chat: true,
			errText: "folder not found: /home/standin/gone", code: "folder_missing",
			want: StartOutcome{409, "folder not found: /home/standin/gone", "folder_missing"}, swapped: true},
		{name: "not started, the chat is there", status: 409, chat: true, errText: "folder not found: /nowhere", code: "folder_missing",
			want: StartOutcome{409, "folder not found: /nowhere", "folder_missing"}, wantState: model.RemoteLeft},
		{name: "agent_missing reaches the caller (AC44)", status: 409, chat: true,
			errText: "the agent's program was not found: pi is not installed on this server", code: "agent_missing",
			want: StartOutcome{409, "the agent's program was not found: pi is not installed on this server", "agent_missing"}, wantState: model.RemoteLeft},
		{name: "429 cap", status: 429, chat: true, errText: "too many chats are running", code: "cap",
			want: StartOutcome{429, "too many chats are running", "cap"}, wantState: model.RemoteLeft},
		{name: "not started, no chat", prior: model.RemoteLeft, status: 409, errText: "the id is taken", code: "id_taken",
			want: StartOutcome{409, "the id is taken", "id_taken"}, wantState: ""},
		{name: "500 with no chat", prior: model.RemoteUnconfirmed, status: 500, errText: "disk full",
			want: StartOutcome{500, "disk full", ""}, wantState: ""},
		{name: "bad_request says nothing of the chat", prior: model.RemoteLeft, status: 400, errText: "a value is missing", code: "bad_request",
			want: StartOutcome{400, "a value is missing", "bad_request"}, wantState: model.RemoteLeft},
		{name: "bad_id says nothing of the chat", prior: model.RemoteLeft, status: 400, errText: "bad id", code: "bad_id",
			want: StartOutcome{400, "bad id", "bad_id"}, wantState: model.RemoteLeft},
		{name: "an error that is not the creation call's", prior: model.RemoteLeft, status: 403, raw: map[string]string{"error": "bad host"},
			want: StartOutcome{403, "bad host", ""}, wantState: model.RemoteLeft},
	}
	for i, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			id := chatN(i)
			rg.unstarted(id, row.prior)
			rg.b.Follow(follower.ID, editorbridge.Chat(id))
			view := remoteView(id, model.StatusThinking)
			var chat *model.ChatView
			if row.chat {
				chat = &view
			}
			if row.raw != nil {
				create.answer(row.status, row.raw)
			} else {
				create.answer(row.status, startAnswerOf(row.started, row.status == 200, chat, row.errText, row.code))
			}
			before := create.count()
			if got := rg.r.Start(context.Background(), id, "hello there"); got != row.want {
				t.Errorf("the outcome: %+v, want %+v", got, row.want)
			}
			if create.count() != before+1 {
				t.Errorf("%d creation calls", create.count()-before)
			}
			state, unstarted := rg.startOf(id)
			if row.swapped {
				if unstarted || !rg.handedOver(id) || !rg.r.Has(id) {
					t.Fatalf("no swap: unstarted %v, handed over %v, a record %v", unstarted, rg.handedOver(id), rg.r.Has(id))
				}
				d := rg.file(id)
				if d.Entry != rg.entry || d.Group != "g_here" || !d.View.Locked || d.View.Status != model.StatusThinking ||
					len(d.States) != 1 || d.States[0].Branch != mainBranch || !d.States[0].Locked {
					t.Errorf("the record: %+v", d)
				}
				if len(d.Drafts) != 0 || !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 4}) {
					t.Errorf("the record's drafts %v and counters %v", d.Drafts, d.DraftRevs)
				}
				var evs []string
				for {
					ev := follower.Next()
					evs = append(evs, fmt.Sprint(ev["type"]))
					if ev["type"] == "chat_reload" {
						if ev["chat"] != id {
							t.Errorf("chat_reload: %v", ev)
						}
						break
					}
				}
				if want := []string{"branch_state", "chat", "chat_reload"}; !reflect.DeepEqual(evs, want) {
					t.Errorf("the page got %v", evs)
				}
				return
			}
			if !unstarted || state != row.wantState || rg.r.Has(id) || rg.handedOver(id) {
				t.Errorf("after the call: unstarted %v in the state %q, a record %v, handed over %v", unstarted, state, rg.r.Has(id), rg.handedOver(id))
			}
		})
	}

	// The creation call: the eight values, and nothing else of the chat.
	first := create.calls()[0]
	var body map[string]any
	if err := json.Unmarshal([]byte(first.Body), &body); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"id": chatN(0), "agent": "claude", "cwd": "/home/standin/work", "model": "standin-model", "effort": "high",
		"name": "First words", "userNamed": true, "text": "hello there",
	}
	if first.Method != http.MethodPost || first.URI != "/api/chats" || !reflect.DeepEqual(body, want) {
		t.Errorf("the creation call: %s %s %v", first.Method, first.URI, body)
	}
	for _, c := range create.calls() {
		noSecret(t, "a creation call", c.Body)
	}
	b, err := os.ReadFile(rg.r.files.path(chatN(0)))
	if err != nil {
		t.Fatal(err)
	}
	noSecret(t, "the record's file", string(b))
	noSecret(t, "the log", strings.Join(rg.logs.all(), "\n"))
}

// TestStartOnARun: the first message of a chat on a run names the run, and is refused before
// the call when the run's record is archived or gone.
func TestStartOnARun(t *testing.T) {
	open, shut, lost := runSeedOf(runN(1)), runSeedOf(runN(2)), runSeedOf(runN(3))
	shut.Archived, shut.View.Archived = true, true
	lost.Gone = true
	rg := newRig(t, rigOpt{snapshot: snapshotWithRuns(open.View, shut.View), runSeed: []RunRecord{open, shut, lost}})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	serveViews(get, model.StatusThinking)
	ctx := context.Background()
	on := func(id, run string) {
		meta := rg.unstarted(id, model.RemoteLeft)
		meta.Run, meta.Group = run, ""
		rg.local.mu.Lock()
		rg.local.chats[id] = meta
		rg.local.mu.Unlock()
	}

	// The creation call carries the run, and the record keeps it.
	on(chatN(1), open.ID)
	view := remoteView(chatN(1), model.StatusThinking)
	create.answer(http.StatusOK, startAnswerOf(true, true, &view, "", ""))
	if got := rg.r.Start(ctx, chatN(1), "hello"); got != started {
		t.Fatalf("the outcome: %+v", got)
	}
	var body map[string]any
	if err := json.Unmarshal([]byte(create.last(t).Body), &body); err != nil {
		t.Fatal(err)
	}
	if body["run"] != open.ID || body["id"] != chatN(1) || len(body) != 9 {
		t.Errorf("the creation call: %v", body)
	}
	if d := rg.file(chatN(1)); d.Run != open.ID || d.Group != "" {
		t.Errorf("the record: %+v", d)
	}

	// An archived run and a gone one: refused before the call, and what was known stays.
	sent := create.count()
	on(chatN(2), shut.ID)
	if got := rg.r.Start(ctx, chatN(2), "hello"); got != (StartOutcome{Status: http.StatusConflict, Error: "the run is archived"}) {
		t.Errorf("a chat on an archived run: %+v", got)
	}
	on(chatN(3), lost.ID)
	if got := rg.r.Start(ctx, chatN(3), "hello"); got != (StartOutcome{http.StatusNotFound, "This run is no longer on Studio.", "gone_there"}) {
		t.Errorf("a chat on a gone run: %+v", got)
	}
	// A run that is being archived here is archived for its chats.
	rg.script("POST /api/runs/{id}/archive").answer(http.StatusInternalServerError, map[string]string{"error": "boom"})
	if err := rg.r.ArchiveRun(ctx, open.ID, ""); err != nil {
		t.Fatal(err)
	}
	on(chatN(4), open.ID)
	if got := rg.r.Start(ctx, chatN(4), "hello"); got.Status != http.StatusConflict || got.Error != "the run is archived" {
		t.Errorf("a chat on a run that is being archived: %+v", got)
	}
	for _, id := range []string{chatN(2), chatN(3), chatN(4)} {
		if state, ok := rg.startOf(id); !ok || state != model.RemoteLeft || len(rg.told(id)) != 0 || rg.r.Has(id) {
			t.Errorf("the chat %s after the refusal: %q, %v, told %v", id, state, ok, rg.told(id))
		}
	}
	if create.count() != sent {
		t.Errorf("%d creation calls for chats on a run that is archived or gone", create.count()-sent)
	}

	// A refusal of the run's server is handed on: nothing of the chat is there.
	on(chatN(5), runN(9)) // no record here: the server answers for the run
	create.answer(http.StatusNotFound, startAnswerOf(false, false, nil, "no such run", ""))
	if got := rg.r.Start(ctx, chatN(5), "hello"); got != (StartOutcome{Status: http.StatusNotFound, Error: "no such run"}) {
		t.Errorf("a chat on a run the server lacks: %+v", got)
	}
	if state, ok := rg.startOf(chatN(5)); !ok || state != "" || !strings.Contains(create.last(t).Body, `"run":"`+runN(9)+`"`) {
		t.Errorf("after the server's refusal: %q, %v", state, ok)
	}
}

// TestStartNotSent: the calls that send nothing, and the 401.
func TestStartNotSent(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	ctx := context.Background()

	if got := rg.r.Start(ctx, chatA, "hello"); got.Status != http.StatusNotFound || got.Error != "no such chat" {
		t.Errorf("a chat nobody has: %+v", got)
	}
	meta := rg.unstarted(chatA, "")
	meta.Agent = ""
	rg.local.mu.Lock()
	rg.local.chats[chatA] = meta
	rg.local.mu.Unlock()
	if got := rg.r.Start(ctx, chatA, "hello"); got.Status != http.StatusConflict || got.Code != "no_agent" || !strings.Contains(got.Error, "Studio") {
		t.Errorf("a chat with no agent: %+v", got)
	}
	if create.count() != 0 {
		t.Errorf("%d creation calls for a chat with no agent", create.count())
	}
	// The call holds the chat's values as they are when the message is sent: the agent chosen last.
	meta.Agent, meta.Model = model.Pi, "pi-model"
	rg.local.mu.Lock()
	rg.local.chats[chatA] = meta
	rg.local.mu.Unlock()
	create.answer(http.StatusConflict, startAnswerOf(false, false, nil, "the id is taken", "id_taken"))
	rg.r.Start(ctx, chatA, "hello")
	if q := create.last(t); !strings.Contains(q.Body, `"agent":"pi"`) || !strings.Contains(q.Body, `"model":"pi-model"`) {
		t.Errorf("the creation call after a change of agent: %s", q.Body)
	}

	// 401: the entry's matter. The chat is as it was.
	rg.unstarted(chatB, model.RemoteLeft)
	create.answer(http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
	want := StartOutcome{http.StatusServiceUnavailable, "Studio is not connected.", "server_unreachable"}
	if got := rg.r.Start(ctx, chatB, "hello"); got != want {
		t.Errorf("an answer of 401: %+v", got)
	}
	if state, ok := rg.startOf(chatB); !ok || state != model.RemoteLeft || rg.r.Has(chatB) || len(rg.told(chatB)) != 0 {
		t.Errorf("after a 401: %q, %v, told %v", state, ok, rg.told(chatB))
	}

	// Not connected (the 401 ended the entry's stream): nothing is sent, and the page keeps the
	// text (no 409).
	rg.until("the entry is not connected", func() bool { return !rg.r.connected(rg.entry) })
	sent := create.count()
	if got := rg.r.Start(ctx, chatB, "hello"); got != want {
		t.Errorf("an entry that is not connected: %+v", got)
	}
	if state, _ := rg.startOf(chatB); state != model.RemoteLeft || create.count() != sent {
		t.Errorf("after a call that was not sent: state %q, %d calls", state, create.count()-sent)
	}
}

// TestStartNoAnswer: a creation call that gets no answer, and the three answers of the read that
// settles it, and the read that gets none either.
func TestStartNoAnswer(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	_, release := create.hang()
	defer release()
	ctx := context.Background()
	const (
		notSent     = "Studio did not answer and the message was not sent. Send again."
		unconfirmed = "Studio did not answer: it is not known whether the first message arrived. Send again: it is sent only once."
	)

	t.Run("the chat has started there", func(t *testing.T) {
		id := chatN(1)
		rg.unstarted(id, "")
		serveViews(get, model.StatusThinking)
		if got := rg.r.Start(ctx, id, "hello"); got != (StartOutcome{Status: 200}) {
			t.Errorf("the outcome: %+v", got)
		}
		if !rg.r.Has(id) || !rg.handedOver(id) || !reflect.DeepEqual(rg.told(id), []string{model.RemoteUnconfirmed}) {
			t.Errorf("a record %v, handed over %v, told %v", rg.r.Has(id), rg.handedOver(id), rg.told(id))
		}
	})
	t.Run("the chat is there and has not started", func(t *testing.T) {
		id := chatN(2)
		rg.unstarted(id, "")
		get.set(func(w http.ResponseWriter, r *http.Request) {
			v := remoteView(id, model.StatusReady)
			v.Locked = false
			writeAnswer(w, http.StatusOK, v)
		})
		if got := rg.r.Start(ctx, id, "hello"); got != (StartOutcome{http.StatusBadGateway, notSent, "not_sent"}) {
			t.Errorf("the outcome: %+v", got)
		}
		if state, ok := rg.startOf(id); !ok || state != model.RemoteLeft || rg.r.Has(id) ||
			!reflect.DeepEqual(rg.told(id), []string{model.RemoteUnconfirmed, model.RemoteLeft}) {
			t.Errorf("state %q, told %v", state, rg.told(id))
		}
	})
	t.Run("the chat is not there", func(t *testing.T) {
		id := chatN(3)
		rg.unstarted(id, "")
		get.answer(http.StatusNotFound, map[string]string{"error": "no such chat"})
		if got := rg.r.Start(ctx, id, "hello"); got != (StartOutcome{http.StatusBadGateway, notSent, "not_sent"}) {
			t.Errorf("the outcome: %+v", got)
		}
		if state, ok := rg.startOf(id); !ok || state != "" || rg.r.Has(id) ||
			!reflect.DeepEqual(rg.told(id), []string{model.RemoteUnconfirmed, ""}) {
			t.Errorf("state %q, told %v", state, rg.told(id))
		}
	})
	t.Run("the read gets no answer either", func(t *testing.T) {
		id := chatN(4)
		rg.unstarted(id, "")
		_, free := get.hang()
		defer free()
		start := time.Now()
		if got := rg.r.Start(ctx, id, "hello"); got != (StartOutcome{http.StatusGatewayTimeout, unconfirmed, "start_unconfirmed"}) {
			t.Errorf("the outcome: %+v", got)
		}
		if took := time.Since(start); took < 300*time.Millisecond || took > 3*time.Second {
			t.Errorf("the two limits took %v", took)
		}
		if state, ok := rg.startOf(id); !ok || state != model.RemoteUnconfirmed || rg.r.Has(id) {
			t.Errorf("state %q, unstarted %v", state, ok)
		}
	})
	t.Run("an answer that tells nothing", func(t *testing.T) {
		// A success that does not say whether the chat started is no answer to go by.
		id := chatN(5)
		rg.unstarted(id, "")
		create.answer(http.StatusOK, map[string]any{"ok": true})
		serveViews(get, model.StatusThinking)
		if got := rg.r.Start(ctx, id, "hello"); got != (StartOutcome{Status: 200}) || !rg.r.Has(id) {
			t.Errorf("the outcome: %+v, a record %v", got, rg.r.Has(id))
		}
	})
}

// TestStartWhileTheStreamDrops: the stream ends while the creation call waits. The entry comes
// back with a snapshot that does not hold the chat yet; that snapshot does not settle the chat,
// whose call is still under way. The call's own read does.
func TestStartWhileTheStreamDrops(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	serveViews(get, model.StatusThinking)
	arrived, release := create.hang()
	defer release()
	rg.unstarted(chatA, model.RemoteLeft)

	done := make(chan StartOutcome, 1)
	go func() { done <- rg.r.Start(context.Background(), chatA, "hello") }()
	<-arrived
	rg.s.DropStreams()
	rg.returned(2)
	if state, ok := rg.startOf(chatA); !ok || state != model.RemoteLeft {
		t.Errorf("the snapshot of the return settled a chat whose call is under way: %q, %v", state, ok)
	}
	release() // the call ends with no answer
	if got := <-done; got != (StartOutcome{Status: 200}) {
		t.Errorf("the outcome: %+v", got)
	}
	if !rg.r.Has(chatA) || !reflect.DeepEqual(rg.told(chatA), []string{model.RemoteUnconfirmed}) {
		t.Errorf("a record %v, told %v", rg.r.Has(chatA), rg.told(chatA))
	}
}

// TestStartWhileTheServerGoes: the server goes away with the creation call under way. Nothing
// can be read: the first message is not confirmed, and server and agent of the chat stay fixed.
// The snapshot of the return settles it.
func TestStartWhileTheServerGoes(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	arrived, release := create.hang()
	defer release()
	rg.unstarted(chatA, "")
	p, _ := rg.page("page-1")
	rg.b.Follow(p.ID, editorbridge.Chat(chatA))

	done := make(chan StartOutcome, 1)
	go func() { done <- rg.r.Start(context.Background(), chatA, "hello") }()
	<-arrived
	rg.s.Stop()
	if got := <-done; got.Status != http.StatusGatewayTimeout || got.Code != "start_unconfirmed" {
		t.Errorf("the outcome: %+v", got)
	}
	if state, ok := rg.startOf(chatA); !ok || state != model.RemoteUnconfirmed || rg.r.Has(chatA) {
		t.Errorf("after the call: %q, %v", state, ok)
	}

	view := remoteView(chatA, model.StatusReady)
	rg.s.SetSnapshot(snapshotWith(view))
	rg.s.Restart()
	rg.returned(2)
	if _, ok := rg.startOf(chatA); ok || !rg.r.Has(chatA) || !rg.handedOver(chatA) {
		t.Fatal("the return did not settle the chat as started")
	}
	// The page: the swap's events, then the return's, with the record among the entry's.
	var evs []map[string]any
	for {
		ev := p.Next()
		evs = append(evs, ev)
		if ev["type"] == "chat" && len(evs) > 3 {
			break
		}
	}
	if got, want := types(evs), []string{"server_lists", "branch_state", "chat", "chat_reload", "server_back", "branch_state", "chat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the page got %v", got)
	}
	if rg.b.Followed(editorbridge.Chat(chatA)) {
		t.Error("the page's follow outlived the return")
	}
}

// TestSettleAtSnapshot: the three cases of a chat whose first message may have left, at the
// snapshot of a connect: started there, there and not started, not there. A chat with no mark
// is settled too when the snapshot holds it: its creation call was under way when this server's
// process ended.
func TestSettleAtSnapshot(t *testing.T) {
	startedID, leftID, absentID, quietID, cutID, madeID := chatN(1), chatN(2), chatN(3), chatN(4), chatN(5), chatN(6)
	startedView := remoteView(startedID, model.StatusTool)
	leftView := remoteView(leftID, model.StatusReady)
	leftView.Locked = false
	madeView := remoteView(madeID, model.StatusReady)
	madeView.Locked = false
	snap := snapshotWith(startedView, leftView, remoteView(cutID, model.StatusThinking), madeView)
	side := model.StateOf(startedID, "b1", startedView)
	side.Status = model.StatusReady
	snap["states"] = append(snap["states"].([]model.BranchState), side)

	get := (*script)(nil)
	rg := newRig(t, rigOpt{snapshot: snap, hold: true, wire: func(rg *rig) {
		get = rg.script("GET /api/chats/{id}")
		rg.unstarted(startedID, model.RemoteUnconfirmed)
		rg.unstarted(leftID, model.RemoteUnconfirmed)
		rg.unstarted(absentID, model.RemoteLeft)
		rg.unstarted(quietID, "") // nothing of it ever left, and it is not there: it is told nothing
		rg.unstarted(cutID, "")   // no mark, and it has started there
		rg.unstarted(madeID, "")  // no mark, and it was made there
		other := rg.unstarted(chatB, model.RemoteUnconfirmed)
		other.Server = "s_000000000000" // a chat of another entry
		rg.local.chats[chatB] = other
	}})
	p, _ := rg.page("page-1")
	rg.b.Follow(p.ID, editorbridge.Chat(startedID))
	rg.start()

	if _, ok := rg.startOf(startedID); ok || !rg.r.Has(startedID) || !rg.handedOver(startedID) {
		t.Fatal("the started chat is no record")
	}
	d := rg.file(startedID)
	if d.View.Status != model.StatusTool || d.Group != "g_here" || len(d.States) != 2 || d.States[1].Branch != "b1" ||
		!reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 4}) || len(d.Drafts) != 0 {
		t.Errorf("the record: %+v", d)
	}
	if _, ok := rg.startOf(cutID); ok || !rg.r.Has(cutID) || !rg.handedOver(cutID) || len(rg.told(cutID)) != 0 {
		t.Fatalf("the chat with no mark that has started there: a record %v, handed over %v, told %v",
			rg.r.Has(cutID), rg.handedOver(cutID), rg.told(cutID))
	}
	if d := rg.file(cutID); d.View.Status != model.StatusThinking || d.Group != "g_here" || !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 4}) {
		t.Errorf("its record: %+v", d)
	}
	for id, want := range map[string]string{leftID: model.RemoteLeft, absentID: "", quietID: "", madeID: model.RemoteLeft, chatB: model.RemoteUnconfirmed} {
		if state, ok := rg.startOf(id); !ok || state != want || rg.r.Has(id) {
			t.Errorf("the chat %s: state %q, unstarted %v, a record %v", id, state, ok, rg.r.Has(id))
		}
	}
	if got := rg.told(madeID); !reflect.DeepEqual(got, []string{model.RemoteLeft}) {
		t.Errorf("the chat with no mark that was made there was told %v", got)
	}
	if len(rg.told(quietID)) != 0 || len(rg.told(chatB)) != 0 {
		t.Errorf("chats that were not to be settled were told %v and %v", rg.told(quietID), rg.told(chatB))
	}
	if get.count() != 0 {
		t.Errorf("settling at a snapshot asked the server %d times", get.count())
	}
	// The page: the lists, the two swaps (the states, the view, and the reload of the chat it
	// follows), then the return with both records.
	var evs []map[string]any
	for range 13 {
		evs = append(evs, p.Next())
	}
	want := []string{"server_lists", "branch_state", "branch_state", "chat", "chat_reload", "branch_state", "chat",
		"server_back", "branch_state", "branch_state", "chat", "branch_state", "chat"}
	if got := types(evs); !reflect.DeepEqual(got, want) {
		t.Fatalf("the page got %v", got)
	}
}

// TestSettleHandsOverAChatWithARecord: a swap that was cut between its record and the
// hand-over left a record and the chat object. The snapshot hands the object over, whatever it
// tells of the chat, and settles nothing else for it.
func TestSettleHandsOverAChatWithARecord(t *testing.T) {
	there, absent := seedOf(chatA), seedOf(chatB)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(there.View), seed: []Record{there, absent}, hold: true, wire: func(rg *rig) {
		rg.unstarted(chatA, "")
		rg.unstarted(chatB, model.RemoteUnconfirmed)
	}})
	rg.start()
	for _, id := range []string{chatA, chatB} {
		if _, ok := rg.startOf(id); ok || !rg.handedOver(id) || !rg.r.Has(id) || len(rg.told(id)) != 0 {
			t.Errorf("the chat %s: handed over %v, a record %v, told %v", id, rg.handedOver(id), rg.r.Has(id), rg.told(id))
		}
	}
	if n, _ := rg.r.Counts(rg.entry); n != 2 {
		t.Errorf("%d records, want 2", n)
	}
	if v := rg.r.Views(); v[0].Gone || !v[1].Gone || v[0].Group != "g_here" {
		t.Errorf("the records after the snapshot: %+v", v)
	}
	// The records take the counters the objects had, the first branch's raised by one.
	for _, id := range []string{chatA, chatB} {
		if d := rg.file(id); !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 4}) || len(d.Drafts) != 0 {
			t.Errorf("the record of %s: counters %v, drafts %v", id, d.DraftRevs, d.Drafts)
		}
	}
}

// TestStartedEvent: a chat event that says an unstarted chat of the entry has started there
// makes the swap: a snapshot found the chat not started yet, or it has no mark at all. The
// events that come before a chat's record are not logged as dropped.
func TestStartedEvent(t *testing.T) {
	made := remoteView(chatA, model.StatusReady)
	made.Locked = false
	get := (*script)(nil)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(made), hold: true, wire: func(rg *rig) {
		get = rg.script("GET /api/chats/{id}")
		rg.unstarted(chatA, model.RemoteUnconfirmed)
		rg.unstarted(chatB, "")
	}})
	serveViews(get, model.StatusTool)
	rg.start()
	if state, ok := rg.startOf(chatA); !ok || state != model.RemoteLeft {
		t.Fatalf("the snapshot that lists the chat not started: %q, %v", state, ok)
	}
	p, _ := rg.page("page-1")
	rg.b.Follow(p.ID, editorbridge.Chat(chatA))

	// What tells nothing of a start is dropped, and not logged: the chat is this entry's.
	rg.s.Send(map[string]any{"type": "branch_state", "state": model.BranchState{Chat: chatA, Branch: mainBranch}})
	rg.s.Send(map[string]any{"type": "chat", "chat": made})
	rg.s.Send(map[string]any{"type": "chat_items", "chat": chatA, "version": 1, "updates": []any{}})
	if got := rg.barrier(p)[0]; len(got) != 0 || rg.r.Has(chatA) {
		t.Errorf("events of a chat that has not started: the page got %v, a record %v", got, rg.r.Has(chatA))
	}
	if n := rg.r.dropped.Load(); n != 3 {
		t.Errorf("%d events counted as dropped, want 3", n)
	}
	// A first message that is being sent is left to its call, and its events are not logged either.
	const sending = "3a000000-0000-4000-8000-00000000000a"
	for _, id := range []string{chatB, sending} {
		unlock, ok := rg.r.locks.start.try(id)
		if !ok {
			t.Fatal("the start lock is held")
		}
		rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(id, model.StatusThinking)})
		rg.barrier(p)
		unlock()
		if rg.r.Has(id) || rg.handedOver(id) {
			t.Errorf("an event swapped the chat %s while its first message was being sent", id)
		}
	}
	if n := rg.logs.count("is dropped"); n != 0 {
		t.Errorf("events before a chat's record were logged as dropped: %v", rg.logs.all())
	}

	// Started there: the swap, and the view is read.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusThinking)})
	evs := rg.barrier(p)[0]
	if got, want := types(evs), []string{"branch_state", "chat", "branch_state", "chat", "chat_reload"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the page got %v", got)
	}
	if _, ok := rg.startOf(chatA); ok || !rg.r.Has(chatA) || !rg.handedOver(chatA) {
		t.Fatal("the event did not swap the chat")
	}
	if d := rg.file(chatA); d.Group != "g_here" || !d.View.Locked || !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 4}) {
		t.Errorf("the record: %+v", d)
	}
	if v := rg.r.Views()[0]; v.ID != chatA || v.Status != model.StatusTool {
		t.Errorf("the record's view is not the one that was read: %+v", v)
	}
	// The same for a chat with no mark: its creation call was under way when the process ended.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatB, model.StatusThinking)})
	rg.barrier(p)
	if _, ok := rg.startOf(chatB); ok || !rg.r.Has(chatB) || !rg.handedOver(chatB) {
		t.Error("the event did not swap the chat with no mark")
	}
	// The next event has a record to go to.
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(chatA, model.StatusApproval)})
	if ev := p.Expect("chat"); field(ev, "chat", "status") != "approval" {
		t.Errorf("the event after the swap: %v", ev)
	}

	// A chat of another entry, and one nobody has here, are not swapped; the second is logged.
	const elsewhere, nobodys = "3b000000-0000-4000-8000-00000000000b", "3c000000-0000-4000-8000-00000000000c"
	other := rg.unstarted(elsewhere, model.RemoteUnconfirmed)
	other.Server = "s_000000000000"
	rg.local.mu.Lock()
	rg.local.chats[elsewhere] = other
	rg.local.mu.Unlock()
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(elsewhere, model.StatusThinking)})
	rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(nobodys, model.StatusThinking)})
	rg.barrier(p)
	if rg.r.Has(elsewhere) || rg.r.Has(nobodys) || rg.handedOver(elsewhere) {
		t.Error("an event made a record for a chat that is not this entry's")
	}
	if rg.logs.count(elsewhere) != 1 || rg.logs.count(nobodys) != 1 {
		t.Errorf("the dropped events of chats that are not this entry's: %v", rg.logs.all())
	}
}

// TestFirstTextKept: the server answers that the chat had started before this call, which sent
// nothing. When a call sent before had another text, the page is told so with a 409 and keeps
// the text; a repeat of the same text, and a call with no earlier one known, are 200.
func TestFirstTextKept(t *testing.T) {
	rg := newRig(t, rigOpt{limits: Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	ctx := context.Background()
	kept := StartOutcome{http.StatusConflict, "The first message had already arrived on Studio; this text was not sent.", "first_text_kept"}

	// lost sends text as a first message that gets no answer, to the call or to the read.
	lost := func(id, text string) {
		t.Helper()
		_, free := create.hang()
		_, freeGet := get.hang()
		defer free()
		defer freeGet()
		if got := rg.r.Start(ctx, id, text); got.Status != http.StatusGatewayTimeout || got.Code != "start_unconfirmed" {
			t.Fatalf("a first message with no answer: %+v", got)
		}
	}
	// arrived makes the server answer that the chat had started, and whether this call sent its text.
	arrived := func(id string, sent bool) {
		view := remoteView(id, model.StatusThinking)
		create.answer(http.StatusOK, startAnswerOf(true, sent, &view, "", ""))
		serveViews(get, model.StatusThinking)
	}
	swapped := func(id string) bool {
		_, unstarted := rg.startOf(id)
		return !unstarted && rg.r.Has(id) && rg.handedOver(id)
	}

	t.Run("the same text", func(t *testing.T) {
		id := chatN(1)
		rg.unstarted(id, "")
		lost(id, "hello")
		arrived(id, false)
		if got := rg.r.Start(ctx, id, "hello"); got != started || !swapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, swapped(id))
		}
	})
	t.Run("another text", func(t *testing.T) {
		id := chatN(2)
		rg.unstarted(id, "")
		lost(id, "hello")
		arrived(id, false)
		if got := rg.r.Start(ctx, id, "hello, and more"); got != kept {
			t.Errorf("the outcome: %+v", got)
		}
		if !swapped(id) {
			t.Error("the chat that had started is no record")
		}
		if q := create.last(t); !strings.Contains(q.Body, `"text":"hello, and more"`) {
			t.Errorf("the second creation call: %s", q.Body)
		}
	})
	t.Run("no earlier call is known", func(t *testing.T) {
		// As after a restart of this server: the mark is in chat.json, the text was never kept.
		id := chatN(3)
		rg.unstarted(id, model.RemoteUnconfirmed)
		arrived(id, false)
		if got := rg.r.Start(ctx, id, "whatever"); got != started || !swapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, swapped(id))
		}
	})
	t.Run("this call sent its text", func(t *testing.T) {
		id := chatN(4)
		rg.unstarted(id, "")
		lost(id, "hello")
		arrived(id, true)
		if got := rg.r.Start(ctx, id, "hello, and more"); got != started || !swapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, swapped(id))
		}
	})
	t.Run("a refusal between the two", func(t *testing.T) {
		// The server said that the chat had not started, without it ("") and with it ("left"):
		// that tells of the refused call alone. The call of before may still wait there and
		// start the chat, so its text stays kept.
		for i, mark := range []string{"", model.RemoteLeft} {
			id := chatN(50 + i)
			rg.unstarted(id, "")
			lost(id, "hello")
			refusal := startAnswerOf(false, false, nil, "the id is taken", "id_taken")
			if mark == model.RemoteLeft {
				left := remoteView(id, model.StatusReady)
				left.Locked = false
				refusal = startAnswerOf(false, false, &left, "the agent did not start", "agent_failed")
			}
			create.answer(http.StatusConflict, refusal)
			if got := rg.r.Start(ctx, id, "hello"); got.Code != refusal["code"] {
				t.Fatalf("the refusal: %+v", got)
			}
			if state, _ := rg.startOf(id); state != mark {
				t.Errorf("the mark after the refusal %s: %q", refusal["code"], state)
			}
			arrived(id, false)
			if got := rg.r.Start(ctx, id, "hello, and more"); got != kept || !swapped(id) {
				t.Errorf("after the refusal %s: %+v, swapped %v", refusal["code"], got, swapped(id))
			}
		}
	})
	t.Run("two texts were sent before", func(t *testing.T) {
		// Which of the two arrived is not known: the page keeps its text.
		id := chatN(6)
		rg.unstarted(id, "")
		lost(id, "hello")
		lost(id, "hello, and more")
		arrived(id, false)
		if got := rg.r.Start(ctx, id, "hello, and more"); got != kept || !swapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, swapped(id))
		}
	})
	t.Run("the view is missing in the answer", func(t *testing.T) {
		id := chatN(7)
		rg.unstarted(id, "")
		lost(id, "hello")
		create.answer(http.StatusOK, startAnswerOf(true, false, nil, "", ""))
		serveViews(get, model.StatusThinking)
		if got := rg.r.Start(ctx, id, "hello, and more"); got != kept || !swapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, swapped(id))
		}
	})

	// What is kept of a text goes with the swap, and with the chat object.
	rg.unstarted(chatA, "")
	lost(chatA, "hello")
	rg.unstarted(chatB, "")
	lost(chatB, "hello")
	rg.local.mu.Lock()
	delete(rg.local.chats, chatA)
	rg.local.mu.Unlock()
	if got := rg.r.Start(ctx, chatA, "hello"); got.Status != http.StatusNotFound {
		t.Errorf("a first message of a chat that is gone: %+v", got)
	}
	rg.r.fmu.Lock()
	left := len(rg.r.firsts)
	_, ofB := rg.r.firsts[chatB]
	rg.r.fmu.Unlock()
	if left != 1 || !ofB {
		t.Errorf("%d texts are kept, want that of the one chat that is not settled", left)
	}
	// The files hold nothing of it.
	sum := fmt.Sprintf("%x", sha256.Sum256([]byte("hello")))
	for id := range map[string]bool{chatN(1): true, chatN(2): true} {
		b, err := os.ReadFile(rg.r.files.path(id))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), sum) || strings.Contains(string(b), "hello") {
			t.Errorf("the record's file holds the text or its hash: %s", b)
		}
	}
}

// TestStartOnce: of many first messages of one chat at once, one is sent.
func TestStartOnce(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	serveViews(get, model.StatusThinking)
	rg.unstarted(chatA, "")
	view := remoteView(chatA, model.StatusThinking)
	hold := make(chan struct{})
	create.set(func(w http.ResponseWriter, r *http.Request) {
		<-hold
		writeAnswer(w, http.StatusOK, startAnswerOf(true, true, &view, "", ""))
	})

	const n = 24
	out := make(chan StartOutcome, n)
	for range n {
		go func() { out <- rg.r.Start(context.Background(), chatA, "hello") }()
	}
	for range n - 1 {
		if got := <-out; got.Status != http.StatusConflict || got.Code != "busy" {
			t.Errorf("a call while another is under way: %+v", got)
		}
	}
	close(hold)
	if got := <-out; got != (StartOutcome{Status: 200}) {
		t.Errorf("the call that was sent: %+v", got)
	}
	if create.count() != 1 {
		t.Errorf("%d creation calls, want 1", create.count())
	}
	// The chat has started: a first message that comes now is not sent either.
	if got := rg.r.Start(context.Background(), chatA, "hello"); got.Status != http.StatusConflict || create.count() != 1 {
		t.Errorf("a first message for a started chat: %+v, %d calls", got, create.count())
	}
}

// TestSwapOrder: the swap as a page sees it, and its order here: the record is there before the
// chat manager lets go of the chat.
func TestSwapOrder(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	p, _ := rg.page("page-follows")
	q, _ := rg.page("page-other")

	var mu sync.Mutex
	recordFirst := map[string]bool{}
	rg.local.mu.Lock()
	rg.local.onHand = func(id string) {
		mu.Lock()
		defer mu.Unlock()
		recordFirst[id] = rg.r.Has(id) && len(rg.r.Views()) > 0
	}
	rg.local.mu.Unlock()

	start := func(id string, read model.Status) (follower, other []map[string]any) {
		t.Helper()
		rg.unstarted(id, "")
		rg.b.Follow(p.ID, editorbridge.Chat(id))
		view := remoteView(id, model.StatusThinking)
		create.answer(http.StatusOK, startAnswerOf(true, true, &view, "", ""))
		serveViews(get, read)
		if got := rg.r.Start(context.Background(), id, "hello"); got != (StartOutcome{Status: 200}) {
			t.Fatalf("the outcome: %+v", got)
		}
		evs := rg.barrier(p, q)
		return evs[0], evs[1]
	}

	// The read after the swap tells what the answer told.
	follower, other := start(chatA, model.StatusThinking)
	if got, want := types(follower), []string{"branch_state", "chat", "chat_reload"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the following page got %v", got)
	}
	if got, want := types(other), []string{"branch_state", "chat"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the other page got %v", got)
	}
	st, chat := follower[0]["state"], follower[1]["chat"]
	if field(st, "chat") != chatA || field(st, "branch") != mainBranch || field(st, "locked") != true ||
		field(st, "draftRev") != float64(4) || field(st, "draft") != nil {
		t.Errorf("the state: %v", st)
	}
	if field(chat, "id") != chatA || field(chat, "group") != "g_here" || field(chat, "server") != rg.entry ||
		field(chat, "locked") != true || field(chat, "draftRev") != float64(4) || field(chat, "draft") != nil ||
		field(chat, "hasDraft") != nil || field(chat, "start") != nil {
		t.Errorf("the view: %v", chat)
	}
	if follower[2]["chat"] != chatA {
		t.Errorf("chat_reload: %v", follower[2])
	}

	// The read tells more than the answer did: the events before the record was there were dropped.
	follower, _ = start(chatB, model.StatusTool)
	if got, want := types(follower), []string{"branch_state", "chat", "branch_state", "chat", "chat_reload"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("the following page got %v", got)
	}
	if field(follower[1], "chat", "status") != "thinking" || field(follower[2], "state", "status") != "tool" || field(follower[3], "chat", "status") != "tool" {
		t.Errorf("the events: %v", follower)
	}
	mu.Lock()
	defer mu.Unlock()
	if !recordFirst[chatA] || !recordFirst[chatB] {
		t.Errorf("the chat was handed over before its record was there: %v", recordFirst)
	}
	for _, c := range get.calls() {
		if c.Method != http.MethodGet || !strings.HasPrefix(c.URI, "/api/chats/") {
			t.Errorf("the read after the swap: %+v", c)
		}
	}
	if get.count() != 2 {
		t.Errorf("%d reads after two swaps", get.count())
	}
}

// quick are the limits of a rig whose calls without an answer end soon.
var quick = Limits{Start: 150 * time.Millisecond, Settle: 150 * time.Millisecond}

// lose sends text as the first message of the chat id, which gets no answer, to the call or to
// the read: the chat is "unconfirmed" and the text is kept.
func (rg *rig) lose(create, get *script, id, text string) {
	rg.t.Helper()
	_, free := create.hang()
	_, freeGet := get.hang()
	defer free()
	defer freeGet()
	if got := rg.r.Start(context.Background(), id, text); got.Status != http.StatusGatewayTimeout || got.Code != "start_unconfirmed" {
		rg.t.Fatalf("a first message with no answer: %+v", got)
	}
}

// draft makes text the stored draft of the first branch of the unstarted chat id, on the
// counter rev: what the saves of a page leave on the chat object.
func (rg *rig) draft(id, text string, rev int64) {
	rg.local.mu.Lock()
	defer rg.local.mu.Unlock()
	meta := rg.local.chats[id]
	meta.Drafts = nil
	if text != "" {
		meta.Drafts = map[string]*model.Draft{mainBranch: {Text: text}}
	}
	meta.DraftRevs = map[string]int64{mainBranch: rev}
	rg.local.chats[id] = meta
}

// keptFirst is what the relay keeps of the creation calls of the chat id.
func (rg *rig) keptFirst(id string) (first firstText, had bool) {
	rg.r.fmu.Lock()
	defer rg.r.fmu.Unlock()
	first, had = rg.r.firsts[id]
	return first, had
}

// keepFirst makes the relay keep text as the one of a creation call sent for the chat id to the entry.
func (rg *rig) keepFirst(id, entry, text string) {
	rg.r.fmu.Lock()
	defer rg.r.fmu.Unlock()
	rg.r.firsts[id] = firstText{entry: entry, sum: sha256.Sum256([]byte(text))}
}

// isSwapped reports whether the chat id is a record and no chat object any more.
func (rg *rig) isSwapped(id string) bool {
	_, unstarted := rg.startOf(id)
	return !unstarted && rg.r.Has(id) && rg.handedOver(id)
}

// TestFirstTextKeptAfterASnapshot: a snapshot that lists the chat as not started, or does not
// list it, is no answer to its creation call, which may still wait there: the text of that call
// stays kept, and a first message with another text that finds the chat started is answered 409.
func TestFirstTextKeptAfterASnapshot(t *testing.T) {
	rg := newRig(t, rigOpt{limits: quick})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	ctx := context.Background()
	kept := StartOutcome{http.StatusConflict, "The first message had already arrived on Studio; this text was not sent.", "first_text_kept"}
	other, same, absent := chatN(1), chatN(2), chatN(3)
	for _, id := range []string{other, same, absent} {
		rg.unstarted(id, "")
		rg.lose(create, get, id, "hello")
	}

	// The link returns: the snapshot lists two of the chats, made and not started.
	var made []model.ChatView
	for _, id := range []string{other, same} {
		v := remoteView(id, model.StatusReady)
		v.Locked = false
		made = append(made, v)
	}
	rg.s.SetSnapshot(snapshotWith(made...))
	rg.s.DropStreams()
	rg.returned(2)
	for id, want := range map[string]string{other: model.RemoteLeft, same: model.RemoteLeft, absent: ""} {
		if state, ok := rg.startOf(id); !ok || state != want {
			t.Fatalf("the chat %s after the snapshot: %q, %v, want %q", id, state, ok, want)
		}
	}

	// The creation call of before started the chat meanwhile: this call sends nothing.
	arrived := func(id string) {
		view := remoteView(id, model.StatusThinking)
		create.answer(http.StatusOK, startAnswerOf(true, false, &view, "", ""))
		serveViews(get, model.StatusThinking)
	}
	arrived(other)
	if got := rg.r.Start(ctx, other, "hello, and more"); got != kept || !rg.isSwapped(other) {
		t.Errorf("another text after the snapshot: %+v, swapped %v", got, rg.isSwapped(other))
	}
	arrived(same)
	if got := rg.r.Start(ctx, same, "hello"); got != started || !rg.isSwapped(same) {
		t.Errorf("the same text after the snapshot: %+v, swapped %v", got, rg.isSwapped(same))
	}
	// A chat the snapshot does not list may be in a creation call that still waits there.
	arrived(absent)
	if got := rg.r.Start(ctx, absent, "hello, and more"); got != kept || !rg.isSwapped(absent) {
		t.Errorf("another text for a chat that was not there: %+v, swapped %v", got, rg.isSwapped(absent))
	}
}

// TestFirstTextKeptByTheRead: a first message whose call gets no answer and whose read finds
// the chat started. The read does not say which text started the chat: after a call with
// another text the page keeps this one (409), in each of the three ends of a call that are no
// answer. A repeat of the same text, and a call with no earlier one, are 200.
func TestFirstTextKeptByTheRead(t *testing.T) {
	rg := newRig(t, rigOpt{limits: quick})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	ctx := context.Background()
	kept := StartOutcome{http.StatusConflict,
		"The chat has started on Studio; it is not known which of the two texts arrived, so this text is kept here.", "first_text_kept"}

	ends := []struct {
		name string
		set  func() (free func())
	}{
		{"no answer", func() func() { _, free := create.hang(); return free }},
		{"an answer that is not the creation call's", func() func() {
			create.answer(http.StatusOK, map[string]any{"ok": true})
			return func() {}
		}},
		{"a success that started nothing", func() func() {
			create.answer(http.StatusOK, startAnswerOf(false, false, nil, "", ""))
			return func() {}
		}},
	}
	for i, end := range ends {
		t.Run(end.name, func(t *testing.T) {
			for j, c := range []struct {
				before, text string
				want         StartOutcome
			}{
				{"hello", "hello, and more", kept},
				{"hello", "hello", started},
				{"", "hello", started},
			} {
				id := chatN(10*i + j + 1)
				rg.unstarted(id, "")
				if c.before != "" {
					rg.lose(create, get, id, c.before)
				}
				free := end.set()
				serveViews(get, model.StatusThinking)
				got := rg.r.Start(ctx, id, c.text)
				free()
				if got != c.want || !rg.isSwapped(id) {
					t.Errorf("%q after %q: %+v, swapped %v, want %+v", c.text, c.before, got, rg.isSwapped(id), c.want)
				}
			}
		})
	}
}

// TestSwapTakesTheCountersOfTheHandOver: the saves of a draft that the chat manager took while
// the creation call was under way raised the chat's counters. The record starts on the counters
// the chat had when it was handed over, so a page's next save, on its own counter, is taken.
func TestSwapTakesTheCountersOfTheHandOver(t *testing.T) {
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	serveViews(get, model.StatusThinking)
	p, _ := rg.page("page-1")

	// during makes the creation call of the chat id take three saves of its draft before its
	// answer, and a save on another branch.
	during := func(id string) {
		view := remoteView(id, model.StatusThinking)
		create.set(func(w http.ResponseWriter, r *http.Request) {
			rg.local.mu.Lock()
			meta := rg.local.chats[id]
			meta.Drafts = map[string]*model.Draft{mainBranch: {Text: "typed on"}}
			meta.DraftRevs = map[string]int64{mainBranch: 6, "b1": 2}
			rg.local.chats[id] = meta
			rg.local.mu.Unlock()
			writeAnswer(w, http.StatusOK, startAnswerOf(true, true, &view, "", ""))
		})
	}

	rg.unstarted(chatA, "") // the counter of main is 3
	during(chatA)
	if got := rg.r.Start(context.Background(), chatA, "hello"); got != started {
		t.Fatalf("the outcome: %+v", got)
	}
	if d := rg.file(chatA); !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 7, "b1": 2}) || len(d.Drafts) != 0 {
		t.Errorf("the record: counters %v, drafts %v", d.DraftRevs, d.Drafts)
	}
	evs := rg.barrier(p)[0]
	if len(evs) < 2 || field(evs[0], "state", "draftRev") != float64(7) || field(evs[0], "state", "draft") != nil ||
		field(evs[1], "chat", "draftRev") != float64(7) {
		t.Errorf("the page got %v", evs)
	}
	// The page that saved during the call is on 6, and on 7 after the message's removal.
	if rep := rg.r.SetDraft(chatA, mainBranch, 6, model.Draft{Text: "late"}); rep.Status != http.StatusConflict || body(t, rep)["rev"] != float64(7) {
		t.Errorf("a save on the counter of before the message: %d %s", rep.Status, rep.Body)
	}
	if rep := rg.r.SetDraft(chatA, mainBranch, 7, model.Draft{Text: "next"}); rep.Status != http.StatusOK || body(t, rep)["rev"] != float64(8) {
		t.Errorf("a save on the counter of the hand-over: %d %s", rep.Status, rep.Body)
	}

	// A record that was there already is raised too, and never lowered.
	seed := seedOf(chatB)
	seed.DraftRevs = map[string]int64{mainBranch: 1, "b1": 9}
	rg.adopt(seed)
	rg.unstarted(chatB, "")
	during(chatB)
	if got := rg.r.Start(context.Background(), chatB, "hello"); got != started {
		t.Fatalf("the outcome with a record: %+v", got)
	}
	if d := rg.file(chatB); !reflect.DeepEqual(d.DraftRevs, map[string]int64{mainBranch: 7, "b1": 9}) || len(d.Drafts) != 0 {
		t.Errorf("the record that was there: counters %v, drafts %v", d.DraftRevs, d.Drafts)
	}
}

// TestSwapKeepsAnEditedDraft: a first message got no answer, the page put its text back and the
// person changed it, which the chat object stored as its draft. When a snapshot or an event
// then says that the chat has started, no page waits for that: the record keeps the draft that
// is another text than the one sent, and the pages are told. The text that was sent goes, and
// so does any draft when nothing is kept of the call (as after a restart of this server).
func TestSwapKeepsAnEditedDraft(t *testing.T) {
	rg := newRig(t, rigOpt{limits: quick})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	p, _ := rg.page("page-1")
	const sent, edited = "first M1", "first M1 EDITED"

	bySnapshot := func(ids ...string) {
		var views []model.ChatView
		for _, id := range ids {
			views = append(views, remoteView(id, model.StatusThinking))
		}
		rg.s.SetSnapshot(snapshotWith(views...))
		rg.s.DropStreams()
	}
	byEvent := func(ids ...string) {
		serveViews(get, model.StatusThinking)
		for _, id := range ids {
			rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(id, model.StatusThinking)})
		}
	}
	cases := []struct {
		name  string
		lost  []string // the texts of the first messages that got no answer
		draft string   // the stored draft when the chat starts
		rev   int64    // and its counter
		want  string   // the record's draft
	}{
		{"edited", []string{sent}, edited, 4, edited},
		{"as it was sent", []string{sent}, sent, 3, ""},
		{"as it was sent, with a space typed after it", []string{sent}, sent + " \n", 4, ""},
		{"emptied", []string{sent}, "", 4, ""},
		{"two texts were sent", []string{sent, edited}, edited, 4, edited},
		{"nothing is kept of the call", nil, edited, 4, ""},
	}
	n := 0
	for _, how := range []struct {
		name string
		swap func(ids ...string)
	}{{"by a snapshot", bySnapshot}, {"by an event", byEvent}} {
		t.Run(how.name, func(t *testing.T) {
			var ids []string
			for _, c := range cases {
				n++
				id := chatN(n)
				ids = append(ids, id)
				mark := model.RemoteUnconfirmed
				if len(c.lost) > 0 {
					mark = ""
				}
				rg.unstarted(id, mark) // its draft is "typed" on the counter 3
				for _, text := range c.lost {
					rg.lose(create, get, id, text)
				}
				rg.draft(id, c.draft, c.rev)
			}
			how.swap(ids...)
			// The swaps are made in the order of the ids: the page is read up to the last one's view.
			var evs []map[string]any
			for last := ids[len(ids)-1]; ; {
				ev := p.Next()
				evs = append(evs, ev)
				if ev["type"] == "chat" && field(ev, "chat", "id") == last {
					break
				}
			}
			for i, c := range cases {
				id := ids[i]
				if !rg.isSwapped(id) {
					t.Fatalf("%s: the chat is no record", c.name)
				}
				d := rg.file(id)
				// The counter is raised for the message that was sent, and once more for a kept draft.
				rev := c.rev + 1
				if c.want != "" {
					rev++
				}
				if got := d.Drafts[mainBranch]; (got == nil) != (c.want == "") || (got != nil && got.Text != c.want) || d.DraftRevs[mainBranch] != rev {
					t.Errorf("%s: the record's draft %+v on %d, want %q on %d", c.name, got, d.DraftRevs[mainBranch], c.want, rev)
				}
				// The first state and the first view the pages get of the record tell the draft.
				var want any
				if c.want != "" {
					want = c.want
				}
				var state, view map[string]any
				for _, ev := range evs {
					if state == nil && ev["type"] == "branch_state" && field(ev, "state", "chat") == id {
						state = ev
					}
					if view == nil && ev["type"] == "chat" && field(ev, "chat", "id") == id {
						view = ev
					}
				}
				if state == nil || field(state, "state", "draft", "text") != want || field(state, "state", "draftRev") != float64(rev) {
					t.Errorf("%s: the state the page got: %v", c.name, state)
				}
				if view == nil || field(view, "chat", "draft", "text") != want || field(view, "chat", "draftRev") != float64(rev) ||
					(field(view, "chat", "hasDraft") == true) != (c.want != "") {
					t.Errorf("%s: the view the page got: %v", c.name, view)
				}
				// The page saves on the counter it was told.
				if rep := rg.r.SetDraft(id, mainBranch, rev, model.Draft{Text: "more"}); rep.Status != http.StatusOK {
					t.Errorf("%s: a save after the swap: %d %s", c.name, rep.Status, rep.Body)
				}
			}
		})
	}
	// Nothing of the texts is kept once the chats are records.
	rg.r.fmu.Lock()
	left := len(rg.r.firsts)
	rg.r.fmu.Unlock()
	if left != 0 {
		t.Errorf("%d texts are still kept", left)
	}

	// A page that waits for its first message handles its text by the answer: no draft is kept.
	id := chatN(n + 1)
	rg.unstarted(id, "")
	rg.lose(create, get, id, sent)
	rg.draft(id, edited, 4)
	view := remoteView(id, model.StatusThinking)
	create.answer(http.StatusOK, startAnswerOf(true, false, &view, "", ""))
	serveViews(get, model.StatusThinking)
	if got := rg.r.Start(context.Background(), id, edited); got.Code != "first_text_kept" {
		t.Fatalf("the outcome: %+v", got)
	}
	if d := rg.file(id); len(d.Drafts) != 0 || d.DraftRevs[mainBranch] != 5 {
		t.Errorf("the record of a first message that was asked for: drafts %v on %d", d.Drafts, d.DraftRevs[mainBranch])
	}
}

// TestSwapTellsAKeptDraftAsAChangeOfItsOwn: the record of a started chat is there to be read
// before the swap gives it the draft it keeps from the chat object. A page that reads in
// between has the record with no draft, and it takes a draft only on a counter it has not seen:
// what Relay.States hands out during the hand-over is the state with the kept draft, or a state
// with no draft on a lower counter than the one the draft ends on, which the pages are told.
func TestSwapTellsAKeptDraftAsAChangeOfItsOwn(t *testing.T) {
	const sent, edited = "first M1", "first M1 EDITED"
	for _, how := range []struct {
		name string
		swap func(rg *rig, get *script, id string)
	}{
		{"by a snapshot", func(rg *rig, get *script, id string) {
			rg.s.SetSnapshot(snapshotWith(remoteView(id, model.StatusThinking)))
			rg.s.DropStreams()
		}},
		{"by an event", func(rg *rig, get *script, id string) {
			serveViews(get, model.StatusThinking)
			rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(id, model.StatusThinking)})
		}},
	} {
		t.Run(how.name, func(t *testing.T) {
			rg := newRig(t, rigOpt{limits: quick})
			create := rg.script("POST /api/chats")
			get := rg.script("GET /api/chats/{id}")
			p, _ := rg.page("page-1")
			id := chatN(1)
			rg.unstarted(id, "")
			rg.lose(create, get, id, sent)
			rg.draft(id, edited, 4)

			// What a reader of the snapshot gets while the object is handed over.
			var during []model.BranchState
			rg.local.mu.Lock()
			rg.local.onHand = func(handed string) {
				for _, st := range rg.r.States() {
					if handed == id && st.Chat == id && st.Branch == mainBranch {
						during = append(during, st)
					}
				}
			}
			rg.local.mu.Unlock()
			how.swap(rg, get, id)
			var told map[string]any
			for {
				ev := p.Next()
				if told == nil && ev["type"] == "branch_state" && field(ev, "state", "chat") == id && field(ev, "state", "draft", "text") == edited {
					told = ev
				}
				if ev["type"] == "chat" && field(ev, "chat", "id") == id {
					break
				}
			}
			rg.local.mu.Lock() // the hand-over of the swap has returned: its events came after it
			rg.local.onHand = nil
			rg.local.mu.Unlock()

			d := rg.file(id)
			if got := d.Drafts[mainBranch]; got == nil || got.Text != edited {
				t.Fatalf("the record's draft: %+v, want %q", got, edited)
			}
			final := d.DraftRevs[mainBranch]
			if len(during) != 1 {
				t.Fatalf("the states of the chat during the hand-over: %+v, want one", during)
			}
			switch st := during[0]; {
			case st.Draft != nil && st.Draft.Text == edited:
				if st.DraftRev != final {
					t.Errorf("during the hand-over the kept draft is on %d, and it ends on %d", st.DraftRev, final)
				}
			case st.Draft != nil:
				t.Errorf("during the hand-over the draft is %+v", st.Draft)
			case st.DraftRev >= final:
				t.Errorf("during the hand-over the record has no draft on the counter %d, and the kept draft comes on %d: a page that read it does not take the draft", st.DraftRev, final)
			}
			if told == nil || field(told, "state", "draftRev") != float64(final) {
				t.Errorf("the state with the draft that the page got: %v, want the counter %d", told, final)
			}
		})
	}
}

// TestFirstTextStaysWhileTheChatIsNotThere: a first message got no answer, and then this server
// is told that the chat is not there, or has not started: by a snapshot, by two, or by the read
// that settles the call. None of them is an answer to the creation call, which may still wait
// in a server that was halted: the text of the call stays kept. So when the chat starts after
// all, an event keeps a draft that was changed since, and a first message with another text is
// answered 409. A chat that never arrived loses nothing: its next call sends its text.
func TestFirstTextStaysWhileTheChatIsNotThere(t *testing.T) {
	const sent, edited = "first N", "first N EDITED"
	ctx := context.Background()
	kept := StartOutcome{http.StatusConflict, "The first message had already arrived on Studio; this text was not sent.", "first_text_kept"}
	notSent := StartOutcome{http.StatusBadGateway, "Studio did not answer and the message was not sent. Send again.", "not_sent"}
	// byRead sends the first message of each chat with no answer to the call; the read is get's.
	byRead := func(rg *rig, create *script, ids []string) {
		_, free := create.hang()
		defer free()
		for _, id := range ids {
			if got := rg.r.Start(ctx, id, sent); got != notSent {
				t.Fatalf("a first message with no answer whose read finds nothing started: %+v", got)
			}
		}
	}
	// bySnapshot sends the first message of each chat with no answer to the call or the read;
	// then n snapshots in a row do not list the chats.
	bySnapshot := func(rg *rig, create, get *script, ids []string, n int) {
		for _, id := range ids {
			rg.lose(create, get, id, sent)
		}
		rg.s.SetSnapshot(snapshotWith())
		for i := range n {
			rg.s.DropStreams()
			rg.returned(i + 2)
		}
	}
	for _, way := range []struct {
		name string
		mark string // of the chats afterwards
		tell func(rg *rig, create, get *script, ids []string)
	}{
		{"a snapshot that lacks the chat", "", func(rg *rig, create, get *script, ids []string) {
			bySnapshot(rg, create, get, ids, 1)
		}},
		{"two snapshots that lack the chat", "", func(rg *rig, create, get *script, ids []string) {
			bySnapshot(rg, create, get, ids, 2)
		}},
		{"a read that does not find the chat", "", func(rg *rig, create, get *script, ids []string) {
			get.answer(http.StatusNotFound, map[string]string{"error": "no such chat"})
			byRead(rg, create, ids)
		}},
		{"a read that finds the chat not started", model.RemoteLeft, func(rg *rig, create, get *script, ids []string) {
			get.set(func(w http.ResponseWriter, r *http.Request) {
				v := remoteView(r.PathValue("id"), model.StatusReady)
				v.Locked = false
				writeAnswer(w, http.StatusOK, v)
			})
			byRead(rg, create, ids)
		}},
	} {
		t.Run(way.name, func(t *testing.T) {
			rg := newRig(t, rigOpt{limits: quick})
			create := rg.script("POST /api/chats")
			get := rg.script("GET /api/chats/{id}")
			p, _ := rg.page("page-1")
			changed, asSent, spaced, other, same, fresh := chatN(1), chatN(2), chatN(3), chatN(4), chatN(5), chatN(6)
			ids := []string{changed, asSent, spaced, other, same, fresh}
			for _, id := range ids {
				rg.unstarted(id, "") // its draft is "typed" on the counter 3
			}
			way.tell(rg, create, get, ids)
			for _, id := range ids {
				first, had := rg.keptFirst(id)
				if state, ok := rg.startOf(id); !ok || state != way.mark || rg.r.Has(id) {
					t.Fatalf("the chat %s: mark %q, unstarted %v, a record %v", id, state, ok, rg.r.Has(id))
				}
				if !had || first.entry != rg.entry || first.mixed || first.sum != sha256.Sum256([]byte(sent)) {
					t.Errorf("the chat %s: the text of its first message is not kept (%v)", id, had)
				}
			}

			// The creation calls of before are carried out there after all. No page waits for
			// the chats that an event tells of: the draft that was changed since is kept.
			drafts := []struct {
				id, draft string
				rev       int64
				want      string
			}{{changed, edited, 4, edited}, {asSent, sent, 3, ""}, {spaced, sent + " \n", 4, ""}}
			serveViews(get, model.StatusThinking)
			for _, c := range drafts {
				rg.draft(c.id, c.draft, c.rev)
				rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(c.id, model.StatusThinking)})
			}
			// The swaps are made in the order of the events: the page is read up to the last one's view.
			var evs []map[string]any
			for {
				ev := p.Next()
				evs = append(evs, ev)
				if ev["type"] == "chat" && field(ev, "chat", "id") == spaced {
					break
				}
			}
			for _, c := range drafts {
				if !rg.isSwapped(c.id) {
					t.Fatalf("the draft %q: the event did not swap the chat", c.draft)
				}
				d := rg.file(c.id)
				rev := c.rev + 1
				if c.want != "" {
					rev++ // a kept draft is a change of its own
				}
				if got := d.Drafts[mainBranch]; (got == nil) != (c.want == "") || (got != nil && got.Text != c.want) || d.DraftRevs[mainBranch] != rev {
					t.Errorf("the draft %q: the record's draft %+v on %d, want %q on %d", c.draft, got, d.DraftRevs[mainBranch], c.want, rev)
				}
			}
			var told any
			for _, ev := range evs {
				if ev["type"] == "branch_state" && field(ev, "state", "chat") == changed && told == nil {
					told = field(ev, "state", "draft", "text")
				}
			}
			if told != edited {
				t.Errorf("the pages were told the draft %v of the chat whose text was changed, want %q", told, edited)
			}

			// A page that sends: the chat had started with the text of before, or had not.
			arrived := func(id string, sent bool) {
				view := remoteView(id, model.StatusThinking)
				create.answer(http.StatusOK, startAnswerOf(true, sent, &view, "", ""))
			}
			arrived(other, false)
			if got := rg.r.Start(ctx, other, edited); got != kept || !rg.isSwapped(other) {
				t.Errorf("another text for a chat that had started: %+v, swapped %v", got, rg.isSwapped(other))
			}
			arrived(same, false)
			if got := rg.r.Start(ctx, same, sent); got != started || !rg.isSwapped(same) {
				t.Errorf("the same text for a chat that had started: %+v, swapped %v", got, rg.isSwapped(same))
			}
			arrived(fresh, true)
			if got := rg.r.Start(ctx, fresh, edited); got != started || !rg.isSwapped(fresh) {
				t.Errorf("another text for a chat that never arrived: %+v, swapped %v", got, rg.isSwapped(fresh))
			}
			if d := rg.file(fresh); len(d.Drafts) != 0 {
				t.Errorf("the record of the chat that never arrived has the draft %+v", d.Drafts[mainBranch])
			}
			// Nothing is kept once the chats are records.
			for _, id := range ids {
				if _, had := rg.keptFirst(id); had {
					t.Errorf("the text of the chat %s is still kept", id)
				}
			}
		})
	}
}

// TestFirstTextOfAnotherServer: what is kept of a first message is that of the entry it was
// sent to. After the chat was put on another server, a first message there is the first one
// known: it is not compared with the text of before, at a call, at a read or at a swap.
func TestFirstTextOfAnotherServer(t *testing.T) {
	rg := newRig(t, rigOpt{limits: quick})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	p, _ := rg.page("page-1")
	ctx := context.Background()
	const elsewhere = "s_000000000000"
	const before, text = "hello", "hello, and more"

	t.Run("the read says started", func(t *testing.T) {
		// Only this text went to this entry: there are no two texts to tell apart.
		id := chatN(1)
		rg.unstarted(id, "")
		rg.keepFirst(id, elsewhere, before)
		_, free := create.hang()
		defer free()
		serveViews(get, model.StatusThinking)
		if got := rg.r.Start(ctx, id, text); got != started || !rg.isSwapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, rg.isSwapped(id))
		}
	})
	t.Run("the answer says started, not sent", func(t *testing.T) {
		// As with no earlier call known.
		id := chatN(2)
		rg.unstarted(id, "")
		rg.keepFirst(id, elsewhere, before)
		view := remoteView(id, model.StatusThinking)
		create.answer(http.StatusOK, startAnswerOf(true, false, &view, "", ""))
		serveViews(get, model.StatusThinking)
		if got := rg.r.Start(ctx, id, text); got != started || !rg.isSwapped(id) {
			t.Errorf("the outcome: %+v, swapped %v", got, rg.isSwapped(id))
		}
	})
	t.Run("a call with no answer starts afresh", func(t *testing.T) {
		// The text kept is this call's alone, so the draft that is this text goes at the swap.
		id := chatN(3)
		rg.unstarted(id, "")
		rg.keepFirst(id, elsewhere, before)
		rg.lose(create, get, id, text)
		if first, had := rg.keptFirst(id); !had || first.entry != rg.entry || first.mixed || first.sum != sha256.Sum256([]byte(text)) {
			t.Errorf("kept of the call: %v, of the entry %q, mixed %v", had, first.entry, first.mixed)
		}
		rg.draft(id, text, 4)
		serveViews(get, model.StatusThinking)
		rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(id, model.StatusThinking)})
		rg.barrier(p)
		if !rg.isSwapped(id) {
			t.Fatal("the event did not swap the chat")
		}
		if d := rg.file(id); len(d.Drafts) != 0 || d.DraftRevs[mainBranch] != 5 {
			t.Errorf("the record: the draft %+v on %d", d.Drafts[mainBranch], d.DraftRevs[mainBranch])
		}
	})
	t.Run("a swap no page waits for", func(t *testing.T) {
		// Nothing is known of a call to this entry, as after a restart: no draft is kept.
		id := chatN(4)
		rg.unstarted(id, "")
		rg.keepFirst(id, elsewhere, before)
		rg.draft(id, text, 4)
		serveViews(get, model.StatusThinking)
		rg.s.Send(map[string]any{"type": "chat", "chat": remoteView(id, model.StatusThinking)})
		rg.barrier(p)
		if !rg.isSwapped(id) {
			t.Fatal("the event did not swap the chat")
		}
		if d := rg.file(id); len(d.Drafts) != 0 || d.DraftRevs[mainBranch] != 5 {
			t.Errorf("the record: the draft %+v on %d", d.Drafts[mainBranch], d.DraftRevs[mainBranch])
		}
		if _, had := rg.keptFirst(id); had {
			t.Error("the text of before is still kept after the swap")
		}
	})
	t.Run("a snapshot forgets", func(t *testing.T) {
		// A text sent to this entry is kept while its chat is an unstarted chat of this entry:
		// not for one that was put on another server, nor for one that is gone.
		here, moved, gone := chatN(5), chatN(6), chatN(7)
		rg.unstarted(here, "")
		away := rg.unstarted(moved, "")
		away.Server = elsewhere
		rg.local.mu.Lock()
		rg.local.chats[moved] = away
		rg.local.mu.Unlock()
		for _, id := range []string{here, moved, gone} {
			rg.keepFirst(id, rg.entry, before)
		}
		rg.s.SetSnapshot(snapshotWith())
		rg.s.DropStreams()
		rg.returned(2)
		for id, want := range map[string]bool{here: true, moved: false, gone: false} {
			if _, had := rg.keptFirst(id); had != want {
				t.Errorf("the chat %s after the snapshot: kept %v, want %v", id, had, want)
			}
		}
	})
}
