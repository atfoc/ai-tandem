package remotes

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"ai-whiteboard/internal/chats"
	"ai-whiteboard/internal/model"
)

// A chat's subagent settings and another server: they go with the first message, the record
// shows what that server says the chat has, and a record's are fixed.

// TestStartCarriesTheSubSettings: the creation call names the chat's depth and cap, a depth of 0
// too, and depth 1 and cap 100 for a chat that has none stored. The record that takes the chat's
// place has the settings of the view its server sent.
func TestStartCarriesTheSubSettings(t *testing.T) {
	t.Parallel()
	rg := newRig(t, rigOpt{})
	create := rg.script("POST /api/chats")
	get := rg.script("GET /api/chats/{id}")
	ctx := context.Background()
	lim := func(depth, limit int) *model.SubLimits { return &model.SubLimits{Depth: depth, Cap: limit} }

	for i, c := range []struct {
		what   string
		stored *model.SubLimits // the chat's here; nil = a chat from before the settings
		sent   model.SubLimits  // what the creation call must name
		there  func(v *model.ChatView)
		shown  model.SubLimits // what the record reads as
	}{
		{"off, with a cap", lim(0, 7), model.SubLimits{Depth: 0, Cap: 7},
			func(v *model.ChatView) { v.SubOff, v.SubCap = true, 7 }, model.SubLimits{Depth: 0, Cap: 7}},
		{"three levels", lim(3, 100), model.SubLimits{Depth: 3, Cap: 100},
			func(v *model.ChatView) { v.SubDepth, v.SubCap = 3, 100 }, model.SubLimits{Depth: 3, Cap: 100}},
		{"the defaults", lim(1, 100), model.SubLimits{Depth: 1, Cap: 100},
			func(v *model.ChatView) { v.SubDepth, v.SubCap = 1, 100 }, model.SubLimits{Depth: 1, Cap: 100}},
		{"a chat from before the settings", nil, model.SubLimits{Depth: 1, Cap: 100},
			func(v *model.ChatView) { v.SubDepth, v.SubCap = 1, 100 }, model.SubLimits{Depth: 1, Cap: 100}},
		// A server from before the settings reads past the two fields and starts the chat as it
		// starts every chat. Its view names none of the three, and so the record says what the
		// chat runs with there: one level, and the default cap, not what was chosen here.
		{"a server from before the settings", lim(0, 5), model.SubLimits{Depth: 0, Cap: 5},
			func(v *model.ChatView) {}, model.SubLimits{Depth: 1, Cap: 100}},
	} {
		id := chatN(i + 1)
		meta := rg.unstarted(id, "")
		meta.Subagents = c.stored
		rg.local.mu.Lock()
		rg.local.chats[id] = meta
		rg.local.mu.Unlock()
		view := remoteView(id, model.StatusThinking)
		c.there(&view)
		create.answer(http.StatusOK, startAnswerOf(true, true, &view, "", ""))
		get.set(func(w http.ResponseWriter, r *http.Request) { writeAnswer(w, http.StatusOK, view) })
		if got := rg.r.Start(ctx, id, "hello", ""); got != started {
			t.Fatalf("%s: the outcome %+v", c.what, got)
		}
		var body map[string]any
		if err := json.Unmarshal([]byte(create.last(t).Body), &body); err != nil {
			t.Fatal(err)
		}
		// Both are in the body as numbers, the 0 of "off" too: it is not left out as empty.
		if body["subDepth"] != float64(c.sent.Depth) || body["subCap"] != float64(c.sent.Cap) {
			t.Errorf("%s: the creation call names depth %v and cap %v, want %+v", c.what, body["subDepth"], body["subCap"], c.sent)
		}
		if !rg.handedOver(id) {
			t.Errorf("%s: the chat was not handed over", c.what)
		}
		d := rg.file(id)
		if got := viewOf(d); got.SubLimits() != c.shown || got.SubOff != (c.shown.Depth == 0) {
			t.Errorf("%s: the record shows off %v, depth %d, cap %d, want %+v", c.what, got.SubOff, got.SubDepth, got.SubCap, c.shown)
		}
	}
}

// TestPatchRefusesTheSubSettings: a record is a started chat, so its subagent settings are
// fixed: a change that names either is refused here, whatever else it names, and nothing is sent.
func TestPatchRefusesTheSubSettings(t *testing.T) {
	t.Parallel()
	seed := seedOf(chatA)
	rg := newRig(t, rigOpt{snapshot: snapshotWith(seed.View), seed: []Record{seed}})
	patch := rg.script("PATCH /api/chats/{id}")
	ctx := context.Background()
	n := func(v int) *int { return &v }
	name := "x"
	for _, req := range []PatchReq{{SubDepth: n(0)}, {SubCap: n(5)}, {SubDepth: n(2), SubCap: n(10)}, {SubDepth: n(1), Model: "other-model"},
		{SubCap: n(100), Name: &name}, {SubDepth: n(99)}} {
		rep := rg.r.Patch(ctx, chatA, "", req)
		if rep.Status != http.StatusConflict || body(t, rep)["error"] != chats.ErrSubFixed.Error() {
			t.Errorf("%+v: %d %s", req, rep.Status, rep.Body)
		}
	}
	if patch.count() != 0 || rg.file(chatA).View.Name != seed.View.Name {
		t.Errorf("a refused change sent %d, and the record is named %q", patch.count(), rg.file(chatA).View.Name)
	}
}
