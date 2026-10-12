package chats

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"ai-whiteboard/internal/model"
)

// A chat's two subagent settings, the depth and the cap: what a new chat starts with, how they
// are changed and when they no longer can be, what is remembered for the next chat, and what a
// branch, a fork, an API client's chat and a chat from before the settings have. What the
// settings do to a chat's subagents is not here: these tests are about the values alone.

func numPtr(n int) *int { return &n }

func lim(depth, limit int) model.SubLimits { return model.SubLimits{Depth: depth, Cap: limit} }

// subIs fails unless the chat id has the subagent settings want in its view, named the way the
// wire names them ("off" as a field of its own), and stored in its chat.json.
func (e *env) subIs(what, id string, want model.SubLimits) {
	e.t.Helper()
	v := e.view(id)
	if v.SubLimits() != want || v.SubOff != (want.Depth == 0) || v.SubDepth != want.Depth || v.SubCap != want.Cap {
		e.t.Fatalf("%s: the view has off %v, depth %d and cap %d, want %+v", what, v.SubOff, v.SubDepth, v.SubCap, want)
	}
	if m := e.metaOf(v); m.Subagents == nil || *m.Subagents != want {
		e.t.Fatalf("%s: chat.json has %+v, want %+v", what, m.Subagents, want)
	}
}

// stickySub is the subagent settings stored for the group on the server key; nil = none.
func (e *env) stickySub(group, key string) *model.SubLimits {
	e.t.Helper()
	return e.defs().Groups[group].On(key).Subagents
}

// stickyIs fails unless the settings stored for the group on the server key are want.
func (e *env) stickyIs(what, group, key string, want model.SubLimits) {
	e.t.Helper()
	if got := e.stickySub(group, key); got == nil || *got != want {
		e.t.Fatalf("%s: the defaults of %s on %s hold %+v, want %+v", what, group, key, got, want)
	}
}

// subDefaults are defaults that hold nothing but subagent settings for the local server: one
// entry per group named.
func subDefaults(per map[string]model.SubLimits) model.Defaults {
	d := model.Defaults{Groups: map[string]model.GroupDefaults{}}
	for g, l := range per {
		d.Groups[g] = model.LocalDefaults(model.ServerDefaults{Subagents: &l})
	}
	return d
}

// ---- a new chat ---------------------------------------------------------------

// A new chat is made with the settings of its place, stored in its chat.json: the group's for the
// chat's server, then the ungrouped group's, then depth 1 and cap 100. A chat on a board uses the
// board's group and a person's chat on a run the run's, as for the other defaults. Making a chat
// records nothing.
func TestSubSettingsOfANewChat(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t) // ownRun is in gOne
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	e.subIs("with nothing recorded", e.newChat(NewChat{Group: gOne, Agent: model.Claude}).ID, lim(1, 100))
	if d := e.defs(); len(d.Groups) != 0 {
		t.Fatalf("a new chat recorded defaults: %+v", d)
	}

	e.setDefaults(subDefaults(map[string]model.SubLimits{model.Ungrouped: lim(2, 25), gTwo: lim(0, 5)}))
	was := e.defaultsRaw()
	for what, c := range map[string]struct {
		n    NewChat
		want model.SubLimits
	}{
		"the ungrouped group":                 {NewChat{Group: model.Ungrouped, Agent: model.Claude}, lim(2, 25)},
		"a group with none of its own":        {NewChat{Group: gOne, Agent: model.Claude}, lim(2, 25)},
		"a group with its own":                {NewChat{Group: gTwo, Agent: model.Claude}, lim(0, 5)},
		"another agent in that group":         {NewChat{Group: gTwo, Agent: model.Cursor}, lim(0, 5)},
		"a board of that group":               {NewChat{Board: bd.ID, Agent: model.Pi}, lim(0, 5)},
		"a run of a group with none":          {NewChat{Run: ownRun, Agent: model.Claude}, lim(2, 25)},
		"a depth named":                       {NewChat{Group: gOne, Agent: model.Claude, SubDepth: numPtr(3)}, lim(3, 25)},
		"a cap named":                         {NewChat{Group: gTwo, Agent: model.Claude, SubCap: numPtr(100)}, lim(0, 100)},
		"both named, the lowest of each":      {NewChat{Group: gOne, Agent: model.Claude, SubDepth: numPtr(0), SubCap: numPtr(1)}, lim(0, 1)},
		"both named, the highest of each":     {NewChat{Group: gTwo, Agent: model.Claude, SubDepth: numPtr(3), SubCap: numPtr(100)}, lim(3, 100)},
		"with no agent the server could give": {NewChat{Group: gTwo}, lim(0, 5)},
	} {
		e.subIs(what, e.newChat(c.n).ID, c.want)
	}

	// A value outside the range is refused, not brought into it, and nothing is made.
	n, folders := len(e.m.Views()), e.chatFolders()
	for what, bad := range map[string]NewChat{
		"a depth above the most":  {SubDepth: numPtr(model.MaxSubDepth + 1)},
		"a depth below 0":         {SubDepth: numPtr(-1)},
		"a cap of 0":              {SubCap: numPtr(0)},
		"a cap above the most":    {SubCap: numPtr(model.MaxSubCap + 1)},
		"a good depth, a bad cap": {SubDepth: numPtr(2), SubCap: numPtr(101)},
	} {
		bad.Group, bad.Agent = gOne, model.Claude
		if _, err := e.m.CreateChat(bad); !errors.Is(err, ErrSubRange) {
			t.Fatalf("a new chat with %s: %v, want ErrSubRange", what, err)
		}
	}
	if len(e.m.Views()) != n || !reflect.DeepEqual(e.chatFolders(), folders) {
		t.Fatalf("the refused chats left %d chats and the folders %v", len(e.m.Views())-n, e.chatFolders())
	}
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("making chats changed the defaults:\n%s\nwant\n%s", got, was)
	}
}

// D5: a run agent's chat gets no stored settings and reads as depth 1 and cap 100, whatever the
// run's group remembers, and no person changes it.
func TestSubSettingsLeaveRunAgentsAlone(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t)
	e.setDefaults(subDefaults(map[string]model.SubLimits{model.Ungrouped: lim(3, 5), gOne: lim(0, 9)}))
	was := e.defaultsRaw()
	id := e.agentChat("a_task", model.RoleTask, model.Claude)
	m := e.runMeta(id, true)
	if m.Subagents != nil || m.SubLimits() != lim(1, 100) {
		t.Fatalf("a run agent's chat.json: %+v, reads as %+v", m.Subagents, m.SubLimits())
	}
	if raw, err := os.ReadFile(filepath.Join(e.st.P.RunChatDir(ownRun, true, id), "chat.json")); err != nil || strings.Contains(string(raw), "subagents") {
		t.Fatalf("a run agent's chat.json names the settings: %s, %v", raw, err)
	}
	if err := e.m.Configure(id, ConfigReq{SubDepth: numPtr(2)}); !errors.Is(err, ErrRunAgent) {
		t.Fatalf("a change of a run agent's chat: %v, want ErrRunAgent", err)
	}
	e.sendOwned(id, "go")
	if m := e.runMeta(id, true); m.Subagents != nil || !m.Locked {
		t.Fatalf("a run agent's chat.json after its first message: %+v", m)
	}
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("a run agent's chat changed the defaults:\n%s\nwant\n%s", got, was)
	}
}

// ---- changing them ------------------------------------------------------------

// Until its first message a chat's settings are changed one at a time or together, with the
// other settings or without. The view and the chat event carry the outcome, and the value a
// reader held before is not written into.
func TestSubSettingsChange(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	c, err := e.m.get(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	c.mu.Lock()
	held := c.meta.Subagents
	c.mu.Unlock()
	evs := e.listen()

	e.configure(v.ID, ConfigReq{SubDepth: numPtr(0)})
	e.subIs("off", v.ID, lim(0, 100))
	if *held != lim(1, 100) {
		t.Fatalf("the settings read before the change were written into: %+v", *held)
	}
	if got := chatViews(t, evs.drain(t, e.br), v.ID); len(got) == 0 || !got[len(got)-1].SubOff || got[len(got)-1].SubLimits() != lim(0, 100) {
		t.Fatalf("the chat events of the change: %+v", got)
	}
	// "Off" is told by its own field: the view's JSON names no depth then, and a view that names
	// none of the three reads as the defaults.
	raw, err := json.Marshal(e.view(v.ID))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if _, has := wire["subDepth"]; has || wire["subOff"] != true || wire["subCap"] != float64(100) {
		t.Fatalf("the view of a chat that is off, on the wire: %s", raw)
	}

	e.configure(v.ID, ConfigReq{SubCap: numPtr(25)})
	e.subIs("the cap alone", v.ID, lim(0, 25))
	e.configure(v.ID, ConfigReq{SubDepth: numPtr(3), SubCap: numPtr(1)})
	e.subIs("both", v.ID, lim(3, 1))
	dir := t.TempDir()
	e.configure(v.ID, ConfigReq{SubDepth: numPtr(2), Model: "opus", Effort: "low", Cwd: dir})
	e.subIs("with the other settings", v.ID, lim(2, 1))
	if got := e.view(v.ID); got.Model != "opus" || got.Effort != "low" || got.Cwd != dir {
		t.Fatalf("the other settings of that request: %+v", got)
	}
	e.configure(v.ID, ConfigReq{Model: "sonnet"})
	e.subIs("after a change that names neither", v.ID, lim(2, 1))
	e.configure(v.ID, ConfigReq{Agent: model.Cursor})
	e.subIs("after another agent", v.ID, lim(2, 1)) // the settings are the same for all agents
	if got := chatViews(t, evs.drain(t, e.br), v.ID); len(got) != 5 || got[4].SubLimits() != lim(2, 1) || got[1].SubLimits() != lim(3, 1) {
		t.Fatalf("the chat events of five changes: %+v", got)
	}

	// A value outside the range is refused, not brought into it, and nothing of the request is
	// done: not the other setting it names either. Neither is anything of a request whose other
	// setting is refused.
	before, stored, sticky := e.view(v.ID), e.meta(v.ID), e.defaultsRaw()
	for what, req := range map[string]ConfigReq{
		"a depth above the most":             {SubDepth: numPtr(4)},
		"a depth below 0":                    {SubDepth: numPtr(-1)},
		"a cap of 0":                         {SubCap: numPtr(0)},
		"a cap below 0":                      {SubCap: numPtr(-5)},
		"a cap above the most":               {SubCap: numPtr(101)},
		"a good depth and a bad cap":         {SubDepth: numPtr(1), SubCap: numPtr(1000)},
		"a bad depth and a good cap":         {SubDepth: numPtr(7), SubCap: numPtr(10)},
		"a bad depth and a good folder":      {SubDepth: numPtr(9), Cwd: t.TempDir()},
		"a bad cap and another agent":        {SubCap: numPtr(0), Agent: model.Claude},
		"a bad depth and a model and effort": {SubDepth: numPtr(4), Model: "composer-2", Effort: "low"},
	} {
		if err := e.m.Configure(v.ID, req); !errors.Is(err, ErrSubRange) || !strings.Contains(err.Error(), "out of range") {
			t.Fatalf("a change to %s: %v, want ErrSubRange", what, err)
		}
	}
	if err := e.m.Configure(v.ID, ConfigReq{SubDepth: numPtr(0), SubCap: numPtr(7), Model: "no-such-model"}); !errors.Is(err, ErrBadChoice) {
		t.Fatalf("good settings with a model the catalog lacks: %v, want ErrBadChoice", err)
	}
	if err := e.m.Configure(v.ID, ConfigReq{SubDepth: numPtr(0), Cwd: filepath.Join(dir, "nowhere")}); err == nil {
		t.Fatal("good settings with a folder that is none were taken")
	}
	if got := e.view(v.ID); got != before {
		t.Fatalf("the refused changes left the view %+v, want %+v", got, before)
	}
	if got := e.meta(v.ID); !reflect.DeepEqual(got, stored) {
		t.Fatalf("the refused changes left chat.json %+v, want %+v", got, stored)
	}
	if got := e.defaultsRaw(); got != sticky {
		t.Fatalf("the refused changes left the defaults\n%s\nwant\n%s", got, sticky)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("the refused changes sent %v", got)
	}
}

// D2, D10, P6: the settings are fixed once the first message is sent, and on a branch and a
// fork from the start, a fork whose model and effort can still be changed included. A request
// that names either is refused whole, with a sentence that says why.
func TestSubSettingsAreFixed(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	fresh := e.create(model.Claude, gOne, "")
	e.configure(fresh.ID, ConfigReq{SubDepth: numPtr(2), SubCap: numPtr(40)})
	a := e.turn(fresh.ID, nil, 1)
	e.turn(fresh.ID, a, 2)
	e.m.naming.Wait()
	id := fresh.ID
	fork := e.fork(id, 3)  // holds a conversation: its model and effort can still be changed
	early := e.fork(id, 0) // made at the start: it has not started
	b, _, _ := e.branchTo(id, newAt(3), "aside")
	if f, s := e.view(fork.ID), e.view(early.ID); !f.Fresh || !f.Locked || s.Locked || s.Fresh {
		t.Fatalf("the two forks: %+v and %+v", f, s)
	}
	sticky := e.defaultsRaw()
	evs := e.listen()

	views := func() []model.ChatView {
		return []model.ChatView{e.view(id), e.view(fork.ID), e.view(early.ID)}
	}
	before := views()
	for what, to := range map[string]struct{ chat, branch string }{
		"a started chat":                   {id, model.MainBranch},
		"a branch":                         {id, b},
		"a fork that holds a conversation": {fork.ID, ""},
		"a fork made at the start":         {early.ID, ""},
	} {
		for with, req := range map[string]ConfigReq{
			"a depth":               {SubDepth: numPtr(0)},
			"a cap":                 {SubCap: numPtr(5)},
			"both":                  {SubDepth: numPtr(3), SubCap: numPtr(100)},
			"the values it has":     {SubDepth: numPtr(2), SubCap: numPtr(40)},
			"a depth and a model":   {SubDepth: numPtr(0), Model: "opus"},
			"a cap and an effort":   {SubCap: numPtr(5), Effort: "low"},
			"a value out of range":  {SubDepth: numPtr(99)},
			"a depth and an agent":  {SubDepth: numPtr(0), Agent: model.Cursor},
			"a cap and a folder":    {SubCap: numPtr(5), Cwd: t.TempDir()},
			"a depth and the local": {SubDepth: numPtr(1), Server: model.LocalServer},
		} {
			err := e.m.ConfigureOf(to.chat, to.branch, req)
			// The server and the agent are fixed for the same chats, and that refusal comes first.
			fixed := ErrSubFixed
			if req.Agent != "" || req.Server != "" {
				fixed = ErrAgentFixed
			}
			if !errors.Is(err, fixed) {
				t.Fatalf("%s, a change of %s: %v, want %v", what, with, err, fixed)
			}
		}
	}
	if err := e.m.Configure(id, ConfigReq{SubDepth: numPtr(1)}); err == nil || !strings.Contains(err.Error(), "subagent depth and cap can be changed only in a chat that has not started") {
		t.Fatalf("the sentence of the refusal: %v", err)
	}
	if got := views(); !reflect.DeepEqual(got, before) {
		t.Fatalf("the refused changes left %+v, want %+v", got, before)
	}
	for _, v := range before {
		if v.SubLimits() != lim(2, 40) {
			t.Fatalf("the settings of %s: %+v", v.ID, v.SubLimits())
		}
	}
	if got := e.defaultsRaw(); got != sticky {
		t.Fatalf("the refused changes left the defaults\n%s\nwant\n%s", got, sticky)
	}
	if got := evs.drain(t, e.br); len(got) != 0 {
		t.Fatalf("the refused changes sent %v", got)
	}

	// The fork's model can still be changed, as before: the settings stay out of that.
	if err := e.m.Configure(fork.ID, ConfigReq{Model: "opus"}); err != nil {
		t.Fatalf("the model of a fork that has had no message of its own: %v", err)
	}
	if v := e.view(fork.ID); v.Model != "opus" || v.SubLimits() != lim(2, 40) {
		t.Fatalf("the fork after its model was changed: %+v", v)
	}
}

// ---- the sticky defaults ------------------------------------------------------

// D11: a choice is remembered for the chat's group on the chat's server when it is made, and the
// first message confirms the chat's settings, changed or not. The next new chat of the group
// starts with them, whatever its agent; a group with none takes the ungrouped group's. The other
// defaults are not touched by a choice of these two, nor these two by a choice of the others.
func TestSubSettingsAreSticky(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	first := e.create(model.Claude, gOne, "")
	evs := e.listen()
	e.configure(first.ID, ConfigReq{SubDepth: numPtr(2)})
	// The whole pair is recorded, and nothing else: no agent, no folder, no model, no server.
	if got, want := e.defs(), subDefaults(map[string]model.SubLimits{gOne: lim(2, 100)}); !reflect.DeepEqual(got, want) {
		t.Fatalf("the defaults after one choice: %+v, want %+v", got, want)
	}
	sent := ofType(evs.drain(t, e.br), "defaults")
	if len(sent) != 1 {
		t.Fatalf("%d defaults events for one choice", len(sent))
	}
	raw, _ := json.Marshal(sent[0]["defaults"])
	var told model.Defaults
	if err := json.Unmarshal(raw, &told); err != nil || !reflect.DeepEqual(told, e.defs()) {
		t.Fatalf("the defaults event: %s, %v", raw, err)
	}

	second := e.create(model.Cursor, gOne, "")
	e.subIs("the next chat of the group, of another agent", second.ID, lim(2, 100))
	e.subIs("a chat of a group with none", e.create(model.Claude, gTwo, "").ID, lim(1, 100))
	e.configure(second.ID, ConfigReq{SubCap: numPtr(10)})
	e.stickyIs("after the cap was chosen in the second chat", gOne, model.LocalServer, lim(2, 10))
	e.subIs("the first chat, after a choice in the second", first.ID, lim(2, 100))

	// The ungrouped group's is what a group with none of its own uses.
	u := e.create(model.Claude, model.Ungrouped, "")
	e.subIs("a chat of the ungrouped group, with none of its own", u.ID, lim(1, 100))
	e.configure(u.ID, ConfigReq{SubDepth: numPtr(0), SubCap: numPtr(5)})
	inTwo := e.create(model.Pi, gTwo, "")
	e.subIs("a chat of a group with none, after the ungrouped group's choice", inTwo.ID, lim(0, 5))
	e.subIs("a chat of the group with its own", e.create(model.Claude, gOne, "").ID, lim(2, 10))
	if got := e.stickySub(gTwo, model.LocalServer); got != nil {
		t.Fatalf("a chat that was only made left its group %+v", got)
	}

	// The first message confirms what the chat has, changed or not: here the ungrouped group's.
	e.send(inTwo.ID, "hello", "")
	e.stickyIs("after the first message of a chat that changed nothing", gTwo, model.LocalServer, lim(0, 5))
	// The first chat was made before the group's choice changed and kept its own: its first
	// message makes those the group's again.
	e.send(first.ID, "hello", "")
	e.stickyIs("after the first message of the first chat", gOne, model.LocalServer, lim(2, 100))
	e.stickyIs("the ungrouped group, after two first messages elsewhere", model.Ungrouped, model.LocalServer, lim(0, 5))

	// A choice of the other settings records neither number, and a choice of these two leaves the
	// agent, the folder, the model and the effort that are recorded as they are.
	other := e.create(model.Claude, gOne, "")
	e.configure(other.ID, ConfigReq{SubDepth: numPtr(3), SubCap: numPtr(50)})
	part := e.defs().Groups[gOne].On(model.LocalServer)
	dir := t.TempDir()
	e.configure(other.ID, ConfigReq{Model: "opus", Effort: "max", Cwd: dir})
	now := e.defs().Groups[gOne].On(model.LocalServer)
	if *now.Subagents != lim(3, 50) || now.Cwd != dir || now.ByAgent[model.Claude] != (model.ModelChoice{Model: "opus", Effort: "max"}) {
		t.Fatalf("the group's part after a choice of the other settings: %+v", now)
	}
	e.configure(other.ID, ConfigReq{SubDepth: numPtr(1)})
	after := e.defs().Groups[gOne].On(model.LocalServer)
	if *after.Subagents != lim(1, 50) || after.Agent != part.Agent || after.Cwd != dir || !reflect.DeepEqual(after.ByAgent, now.ByAgent) || after.Run != nil {
		t.Fatalf("the group's part after a choice of the depth: %+v, was %+v", after, now)
	}
}

// A person's chat on a run is a chat like any other: it starts with the settings of the run's
// group and feeds them there, at a choice and at its first message. A chat on a board uses the
// board's group.
func TestSubSettingsOnARunAndOnABoard(t *testing.T) {
	t.Parallel()
	e, _ := runEnv(t) // ownRun is in gOne
	bd, err := e.bds.Create("board", gTwo, false)
	if err != nil {
		t.Fatal(err)
	}
	r := e.newChat(NewChat{Run: ownRun, Agent: model.Claude})
	e.configure(r.ID, ConfigReq{SubDepth: numPtr(3), SubCap: numPtr(8)})
	e.subIs("a chat on a run", r.ID, lim(3, 8))
	e.stickyIs("after a choice in a chat on a run", gOne, model.LocalServer, lim(3, 8))
	e.subIs("the next chat on the run", e.newChat(NewChat{Run: ownRun, Agent: model.Claude}).ID, lim(3, 8))
	e.subIs("a chat in the run's group", e.newChat(NewChat{Group: gOne, Agent: model.Claude}).ID, lim(3, 8))

	b := e.newChat(NewChat{Board: bd.ID, Agent: model.Claude})
	e.subIs("a chat on a board of another group", b.ID, lim(1, 100))
	e.configure(b.ID, ConfigReq{SubDepth: numPtr(0)})
	e.stickyIs("after a choice in a chat on a board", gTwo, model.LocalServer, lim(0, 100))
	e.stickyIs("the run's group, after a choice on the board", gOne, model.LocalServer, lim(3, 8))

	// The first message of each confirms its settings in the same group.
	e.setDefaults(model.Defaults{})
	e.send(r.ID, "hello", "")
	e.send(b.ID, "hello", "")
	e.stickyIs("after the first message of the chat on the run", gOne, model.LocalServer, lim(3, 8))
	e.stickyIs("after the first message of the chat on the board", gTwo, model.LocalServer, lim(0, 100))
}

// ---- another server -----------------------------------------------------------

// The settings are kept per server. A chat whose server is changed before its first message
// gets what a new chat of its group starts with on that server, as it gets that server's folder,
// and what the same request names is then applied. The change of server itself records nothing
// of them; a choice made on a server is recorded under that server's key, and the hand-over,
// which is the first message there, confirms them under it.
func TestSubSettingsFollowTheServer(t *testing.T) {
	t.Parallel()
	e, fs := remoteEnv(t, model.Claude)
	e.setDefaults(model.Defaults{Groups: map[string]model.GroupDefaults{gOne: {Servers: map[string]model.ServerDefaults{
		model.LocalServer: {Subagents: &model.SubLimits{Depth: 2, Cap: 10}},
		keyB:              {Subagents: &model.SubLimits{Depth: 3, Cap: 50}},
	}}}})
	was := e.defaultsRaw()
	v := e.newChat(NewChat{Group: gOne})
	e.subIs("made on this computer", v.ID, lim(2, 10))
	e.configure(v.ID, ConfigReq{Server: entB})
	e.subIs("moved to Bee", v.ID, lim(3, 50))
	e.configure(v.ID, ConfigReq{Server: entC})
	e.subIs("moved to Sea, which has none", v.ID, lim(1, 100))
	e.configure(v.ID, ConfigReq{Server: model.LocalServer})
	e.subIs("moved back", v.ID, lim(2, 10))
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("three changes of server changed the defaults:\n%s\nwant\n%s", got, was)
	}

	// With a server, what the request names is applied to that server's settings.
	e.configure(v.ID, ConfigReq{Server: entB, SubDepth: numPtr(0)})
	e.subIs("moved to Bee with a depth", v.ID, lim(0, 50))
	e.stickyIs("Bee's part after that", gOne, keyB, lim(0, 50))
	e.stickyIs("this computer's part after that", gOne, model.LocalServer, lim(2, 10))
	// A request whose settings are refused moves nothing.
	if err := e.m.Configure(v.ID, ConfigReq{Server: model.LocalServer, SubCap: numPtr(0)}); !errors.Is(err, ErrSubRange) {
		t.Fatalf("a move with a cap of 0: %v, want ErrSubRange", err)
	}
	if got := e.view(v.ID); got.Server != entB || got.SubLimits() != lim(0, 50) {
		t.Fatalf("the chat after the refused move: %+v", got)
	}

	// A chat made on Bee starts with Bee's, is changed there like here, and its hand-over
	// confirms what it has under Bee's key.
	w := e.onBee(gOne)
	e.subIs("made on Bee", w.ID, lim(0, 50))
	e.configure(w.ID, ConfigReq{SubDepth: numPtr(1), SubCap: numPtr(5)})
	e.subIs("changed on Bee", w.ID, lim(1, 5))
	e.configure(v.ID, ConfigReq{SubCap: numPtr(77)}) // the group's choice moves on while w waits
	e.stickyIs("Bee's part after another chat's choice", gOne, keyB, lim(0, 77))
	meta, err := e.m.HandOver(w.ID)
	if err != nil || meta.Subagents == nil || *meta.Subagents != lim(1, 5) {
		t.Fatalf("the hand-over: %+v, %v", meta.Subagents, err)
	}
	e.stickyIs("Bee's part after the hand-over", gOne, keyB, lim(1, 5))
	e.stickyIs("this computer's part after the hand-over", gOne, model.LocalServer, lim(2, 10))

	// A server that left the list: its chat is put on this computer, with this computer's.
	fs.mu.Lock()
	delete(fs.entries, entB)
	fs.mu.Unlock()
	if err := e.m.ResetServer(v.ID); err != nil {
		t.Fatal(err)
	}
	e.subIs("put back on this computer", v.ID, lim(2, 10))

	// A server that has not said who it is has no part of the defaults: its chats start with
	// depth 1 and cap 100, and a choice made there is the chat's alone.
	fs.change(entC, func(en *RemoteEntry) { en.Key = "" })
	sticky := e.defaultsRaw()
	x := e.newChat(NewChat{Group: gOne, Server: entC})
	e.subIs("made on a server with no key", x.ID, lim(1, 100))
	e.configure(x.ID, ConfigReq{SubDepth: numPtr(3)})
	e.subIs("changed on a server with no key", x.ID, lim(3, 100))
	if got := e.defaultsRaw(); got != sticky {
		t.Fatalf("a choice on a server with no key changed the defaults:\n%s\nwant\n%s", got, sticky)
	}
}

// ---- an API client's chat -----------------------------------------------------

// D12: a chat made by an API client gets depth 1 and cap 100 unless the call names values,
// whatever the server remembers, and it feeds no default: not at its creation, not at a change
// and not at its first message.
func TestSubSettingsOfAnAPIClient(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.setDefaults(subDefaults(map[string]model.SubLimits{gOne: lim(3, 7), gTwo: lim(3, 7), model.Ungrouped: lim(3, 7)}))
	was := e.defaultsRaw()
	p := &places{g: gOne}
	for id, c := range map[string]struct {
		depth, limit *int
		want         model.SubLimits
	}{
		idA: {nil, nil, lim(1, 100)},
		idB: {numPtr(0), numPtr(7), lim(0, 7)},
		idC: {numPtr(3), nil, lim(3, 100)},
		idD: {nil, numPtr(1), lim(1, 1)},
	} {
		req := e.startReq(id, clientX)
		req.SubDepth, req.SubCap, req.Place = c.depth, c.limit, p.place
		res := e.start(req)
		if !res.Started || !res.Sent || res.Chat.SubLimits() != c.want || res.Chat.SubOff != (c.want.Depth == 0) {
			t.Fatalf("a creation call with %v and %v: %+v", c.depth, c.limit, res)
		}
		e.subIs("an API client's chat", id, c.want)
	}

	// A value outside the range is refused before anything is looked at.
	n, asked := len(e.m.Views()), p.n.Load()
	for what, change := range map[string]func(*StartReq){
		"a depth above the most": func(r *StartReq) { r.SubDepth = numPtr(4) },
		"a depth below 0":        func(r *StartReq) { r.SubDepth = numPtr(-1) },
		"a cap of 0":             func(r *StartReq) { r.SubCap = numPtr(0) },
		"a cap above the most":   func(r *StartReq) { r.SubCap = numPtr(101) },
	} {
		req := e.startReq(idE, clientX)
		req.Place = p.place
		change(&req)
		if res, err := e.m.Start(req); !errors.Is(err, ErrSubRange) || res != (StartResult{}) {
			t.Fatalf("a creation call with %s: %+v, %v, want ErrSubRange", what, res, err)
		}
		// The same for a chat that is there and started: the call is refused, not answered.
		req.ID = idA
		if res, err := e.m.Start(req); !errors.Is(err, ErrSubRange) || res != (StartResult{}) {
			t.Fatalf("a repeated creation call with %s: %+v, %v, want ErrSubRange", what, res, err)
		}
	}
	if len(e.m.Views()) != n || p.n.Load() != asked || e.m.ids.held() != 0 {
		t.Fatalf("the refused calls left %d chats, %d questions for the group, %d locks", len(e.m.Views())-n, p.n.Load()-asked, e.m.ids.held())
	}

	// A marked chat that has not started is changed like any other, and records nothing.
	v, err := e.m.CreateChat(NewChat{Client: clientY, Agent: model.Claude, Group: gTwo})
	if err != nil {
		t.Fatal(err)
	}
	e.subIs("a marked chat that was only made", v.ID, lim(1, 100))
	e.configure(v.ID, ConfigReq{SubDepth: numPtr(2), SubCap: numPtr(30)})
	e.subIs("a marked chat after a change", v.ID, lim(2, 30))
	e.send(v.ID, "hello", "")
	if got := e.defaultsRaw(); got != was {
		t.Fatalf("an API client's chats changed the defaults:\n%s\nwant\n%s", got, was)
	}
}

// A creation call that is repeated for a chat that did not start gives the chat the settings of
// the call, as a new chat would get them: what the call does not name is depth 1 and cap 100, not
// what the call before named.
func TestSubSettingsOfARepeatedStart(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	gone := &noStart{}
	e.m.Spawners[model.Claude] = gone
	req := e.startReq(idA, clientX)
	req.SubDepth, req.SubCap = numPtr(3), numPtr(9)
	if res, err := e.m.Start(req); err == nil || !res.Exists || res.Started || res.Chat.SubLimits() != lim(3, 9) {
		t.Fatalf("a start whose program does not start: %+v, %v", res, err)
	}
	e.subIs("after the failed start", idA, lim(3, 9))
	req.SubDepth, req.SubCap = nil, numPtr(4)
	if res, err := e.m.Start(req); err == nil || res.Started || res.Chat.SubLimits() != lim(1, 4) {
		t.Fatalf("the call again, with a cap alone: %+v, %v", res, err)
	}
	e.subIs("after the second failed start", idA, lim(1, 4))
	req.SubDepth, req.SubCap = nil, nil
	if res, err := e.m.Start(req); err == nil || res.Started || res.Chat.SubLimits() != lim(1, 100) {
		t.Fatalf("the call again, with neither: %+v, %v", res, err)
	}
	e.m.Spawners[model.Claude] = e.claude
	req.SubDepth = numPtr(0)
	if res := e.start(req); !res.Started || !res.Sent || !res.Chat.SubOff || res.Chat.SubLimits() != lim(0, 100) {
		t.Fatalf("the call that starts the chat: %+v", res)
	}
	e.subIs("after the start", idA, lim(0, 100))
	// Started: a repeat changes nothing, whatever it names.
	req.SubDepth, req.SubCap = numPtr(3), numPtr(3)
	if res := e.start(req); res.Sent || res.Chat.SubLimits() != lim(0, 100) {
		t.Fatalf("a repeat for the started chat: %+v", res)
	}
	if len(e.m.Views()) != 1 || len(e.defs().Groups) != 0 {
		t.Fatalf("%d chats, the defaults %+v", len(e.m.Views()), e.defs())
	}
}

// ---- a branch and a fork ------------------------------------------------------

// D10: a branch and a fork carry their source's settings, as values of their own, and feed no
// default: a fork's first message does not make them its group's.
func TestSubSettingsOnForksAndBranches(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	v := e.create(model.Claude, gOne, "")
	e.configure(v.ID, ConfigReq{SubDepth: numPtr(2), SubCap: numPtr(7)})
	a := e.turn(v.ID, nil, 1)
	e.turn(v.ID, a, 2)
	e.m.naming.Wait()

	fork := e.fork(v.ID, 3)
	e.subIs("a fork", fork.ID, lim(2, 7))
	early := e.fork(v.ID, 0)
	e.subIs("a fork made at the start", early.ID, lim(2, 7))
	e.subIs("a fork of a fork", e.fork(fork.ID, 3).ID, lim(2, 7))
	b, bid, _ := e.branchTo(v.ID, newAt(3), "aside")
	if got := e.meta(bid).Subagents; got == nil || *got != lim(2, 7) {
		t.Fatalf("a branch's chat.json has %+v", got)
	}
	e.subIs("the chat, on its new branch", v.ID, lim(2, 7))
	if cur := e.cur(v.ID); cur != b {
		t.Fatalf("the current branch is %q, want %q", cur, b)
	}
	// Each chat object holds a value of its own.
	held := map[*model.SubLimits]string{}
	for _, id := range []string{v.ID, fork.ID, early.ID, bid} {
		c, err := e.m.get(id)
		if err != nil {
			t.Fatal(err)
		}
		c.mu.Lock()
		p := c.meta.Subagents
		c.mu.Unlock()
		if p == nil || *p != lim(2, 7) {
			t.Fatalf("the chat object %s holds %+v", id, p)
		}
		if other, shared := held[p]; shared {
			t.Fatalf("%s and %s share their settings", id, other)
		}
		held[p] = id
	}

	// The group's choice has moved on since: the first messages of the forks leave it.
	e.configure(e.create(model.Claude, gOne, "").ID, ConfigReq{SubDepth: numPtr(1), SubCap: numPtr(50)})
	e.send(fork.ID, "on the fork", "")
	e.send(early.ID, "on the early fork", "")
	e.subIs("a fork after its first message", fork.ID, lim(2, 7))
	e.subIs("a fork made at the start, after its first message", early.ID, lim(2, 7))
	e.stickyIs("the group after the forks' first messages", gOne, model.LocalServer, lim(1, 50))
}

// ---- a chat from before the settings ------------------------------------------

// dropSub takes the stored settings out of the chat.json of the chat id, which is then as one
// written before the settings existed.
func (e *env) dropSub(id string) {
	e.t.Helper()
	path := filepath.Join(e.st.P.ChatDir(id), "chat.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		e.t.Fatal(err)
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		e.t.Fatal(err)
	}
	if _, has := m["subagents"]; !has {
		e.t.Fatalf("chat.json of %s names no settings: %s", id, raw)
	}
	delete(m, "subagents")
	if raw, err = json.Marshal(m); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		e.t.Fatal(err)
	}
}

// named reports whether the chat.json of the chat id names the settings.
func (e *env) named(id string) bool {
	e.t.Helper()
	raw, err := os.ReadFile(filepath.Join(e.st.P.ChatDir(id), "chat.json"))
	if err != nil {
		e.t.Fatal(err)
	}
	return strings.Contains(string(raw), `"subagents"`)
}

// A chat that was made before the settings existed has none stored, and none is written for it:
// not when it is loaded, not when it goes on. It reads as depth 1 and cap 100, and so do the
// branch and the fork made from it, which store none either. One that has started cannot be
// given any; one that has not can, and its first message confirms what it reads as.
func TestSubSettingsOfAChatFromBefore(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.setDefaults(subDefaults(map[string]model.SubLimits{gOne: lim(3, 9)})) // not this chat's: it has none
	old := e.create(model.Claude, gOne, "")
	a := e.turn(old.ID, nil, 1)
	_ = a
	e.m.naming.Wait()
	unstarted := e.create(model.Claude, gTwo, "")
	e.dropSub(old.ID)
	e.dropSub(unstarted.ID)
	e.setDefaults(subDefaults(map[string]model.SubLimits{gOne: lim(3, 9)})) // the first message recorded old's
	e.boot()

	reads := func(what, id string) {
		t.Helper()
		if v := e.view(id); v.SubLimits() != lim(1, 100) || v.SubOff || v.SubDepth != 1 || v.SubCap != 100 {
			t.Fatalf("%s: off %v, depth %d, cap %d", what, v.SubOff, v.SubDepth, v.SubCap)
		}
	}
	for what, id := range map[string]string{"a started chat from before": old.ID, "an unstarted chat from before": unstarted.ID} {
		reads(what, id)
		if e.named(id) {
			t.Fatalf("%s was given settings by the load", what)
		}
	}
	if err := e.m.Configure(old.ID, ConfigReq{SubDepth: numPtr(2)}); !errors.Is(err, ErrSubFixed) {
		t.Fatalf("a change of a started chat from before: %v, want ErrSubFixed", err)
	}
	// It goes on as it was: its chat.json is written again, and still names none.
	e.turn(old.ID, nil, 2)
	e.m.naming.Wait()
	if e.named(old.ID) || !e.meta(old.ID).Locked || e.meta(old.ID).Usage.Turns != 2 {
		t.Fatalf("the chat from before after another turn: named %v, %+v", e.named(old.ID), e.meta(old.ID))
	}
	reads("after another turn", old.ID)

	// Its fork and its branch carry what it has: nothing stored, the same reading.
	fork := e.fork(old.ID, 3)
	_, bid, _ := e.branchTo(old.ID, newAt(3), "aside")
	if e.named(fork.ID) || e.named(bid) {
		t.Fatalf("a copy of a chat from before names settings: the fork %v, the branch %v", e.named(fork.ID), e.named(bid))
	}
	reads("the fork of a chat from before", fork.ID)
	reads("the chat from before, on its new branch", old.ID)
	if m := e.meta(bid); m.SubLimits() != lim(1, 100) {
		t.Fatalf("the branch of a chat from before reads as %+v", m.SubLimits())
	}

	// The defaults were not read for it, and not fed by its turn.
	e.stickyIs("the group of the chat from before", gOne, model.LocalServer, lim(3, 9))

	// An unstarted one: its first message confirms what it reads as, and before that it can be
	// given settings like any chat that has not started.
	other := e.create(model.Claude, gTwo, "")
	e.dropSub(other.ID)
	e.boot()
	e.send(unstarted.ID, "hello", "")
	e.stickyIs("after the first message of an unstarted chat from before", gTwo, model.LocalServer, lim(1, 100))
	if e.named(unstarted.ID) {
		t.Fatal("the first message gave the chat from before stored settings")
	}
	e.configure(other.ID, ConfigReq{SubCap: numPtr(5)})
	e.subIs("an unstarted chat from before, after a choice", other.ID, lim(1, 5))
	e.stickyIs("after that choice", gTwo, model.LocalServer, lim(1, 5))
}
