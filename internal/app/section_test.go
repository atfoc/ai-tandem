package app

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"ai-whiteboard/internal/model"
	"ai-whiteboard/internal/remotes"
	"ai-whiteboard/internal/servers"
	"ai-whiteboard/internal/servers/standin"
)

// farTree is the snapshot of a stand-in server that has one group with a board and a chat in it.
// Its ids are given: a test makes them the ids of local things.
func farTree(group, board, chat string) map[string]any {
	snap := standin.DefaultSnapshot()
	snap["groups"] = []model.Group{{ID: group, Name: "Far", Collapsed: true}}
	snap["boards"] = []model.Board{{ID: board, Name: "far board", Group: group}}
	snap["chats"] = []model.ChatView{{ID: chat, Agent: model.Claude, Name: "far chat", Group: group, Status: model.StatusReady}}
	snap["states"] = []model.BranchState{{Chat: chat, Branch: model.MainBranch, Status: model.StatusReady}}
	return snap
}

// withServer gives the app of e a server list with one entry, the stand-in st, and the relay
// that holds its tree, and waits until the tree is held. It returns the entry's id.
func (e *env) withServer(st *standin.Server) string {
	e.t.Helper()
	const limit = 5 * time.Second
	m, err := servers.Open(servers.Options{Root: e.t.TempDir(), LocalID: "0b0e6f52-1c3d-4a8e-b7f1-93a2c4d5e6f7",
		Timing: servers.Timing{Dial: limit, Handshake: limit, Headers: limit, Hello: limit, FirstEvent: limit, Call: limit, Jitter: -1}})
	e.must(err)
	relay, err := remotes.Open(remotes.Options{Servers: m, Bridge: e.a.Bridge, Logf: e.t.Logf})
	e.must(err)
	m.SetHooks(relay.Hooks())
	e.t.Cleanup(func() { m.Close(); relay.Close() })
	e.a.Servers, e.a.Remotes = m, relay
	v, saved, _, err := m.Add(context.Background(), servers.Input{
		Name: "far", Address: st.URL(), Secret: standin.DefaultSecret, SelfSigned: true, Pin: st.Fingerprint()}, true)
	if err != nil || !saved {
		e.t.Fatalf("the entry is not saved: %v", err)
	}
	m.Start()
	for end := time.Now().Add(limit); ; time.Sleep(2 * time.Millisecond) {
		if _, held := relay.Sections()[v.ID]; held {
			return v.ID
		}
		if time.Now().After(end) {
			e.t.Fatal("the tree of the server did not come")
		}
	}
}

// Without a server list, and with one whose entries hold no tree, "sections" is an empty object,
// never null.
func TestSectionSnapshotWithoutATree(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	raw, err := json.Marshal(e.a.Snapshot())
	e.must(err)
	if !strings.Contains(string(raw), `"sections":{}`) {
		t.Fatalf("the snapshot of an app without servers: %s", raw)
	}
}

// The snapshot holds the tree of a connected server under its entry id, as that server has it
// but for "collapsed", and its own lists hold nothing of that server: not even a thing with the
// id of a local one.
func TestSectionSnapshotHoldsTheTreeBesideTheLocalLists(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("Here")
	b := e.board(g)
	c := e.chat(g, "")
	// The far server uses the ids of the local group, board and chat for things of its own.
	entry := e.withServer(standin.Start(t, standin.Options{Snapshot: farTree(g, b, c)}))

	snap := e.a.Snapshot()
	tree, held := snap.Sections[entry]
	if !held || len(snap.Sections) != 1 {
		t.Fatalf("sections: %+v", snap.Sections)
	}
	if len(tree.Groups) != 1 || tree.Groups[0].Name != "Far" || tree.Groups[0].Collapsed {
		t.Errorf("the section's groups: %+v", tree.Groups)
	}
	if len(tree.Boards) != 1 || tree.Boards[0].Name != "far board" || len(tree.Chats) != 1 || tree.Chats[0].Name != "far chat" ||
		len(tree.States) != 1 || tree.Defaults.Groups == nil {
		t.Errorf("the section's tree: %+v", tree)
	}
	if len(snap.Groups) != 1 || snap.Groups[0].Name != "Here" || len(snap.Boards) != 1 || snap.Boards[0].Name != "board" ||
		len(snap.Chats) != 1 || snap.Chats[0].Name == "far chat" {
		t.Errorf("the local lists: groups %+v, boards %+v, chats %+v", snap.Groups, snap.Boards, snap.Chats)
	}
	raw, err := json.Marshal(snap)
	e.must(err)
	var shape struct {
		Sections map[string]map[string]json.RawMessage `json:"sections"`
	}
	e.must(json.Unmarshal(raw, &shape))
	for _, key := range []string{"groups", "boards", "chats", "states", "defaults"} {
		if v, ok := shape.Sections[entry][key]; !ok || string(v) == "null" {
			t.Errorf("the section's %q on the wire: %s", key, v)
		}
	}
	if strings.Contains(string(shape.Sections[entry]["groups"]), "collapsed") {
		t.Errorf("the section's groups carry collapsed: %s", shape.Sections[entry]["groups"])
	}
}

// A local group holds local things only: archiving it, bringing it back and deleting it with
// everything in it sends a connected server nothing, and leaves that server's tree as it was,
// also when a thing there has the id of one that is archived or deleted here.
func TestSectionLocalGroupReachesNoOtherServer(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	g := e.group("Here")
	b := e.board(g)
	c := e.chat(g, "")
	st := standin.Start(t, standin.Options{Snapshot: farTree(g, b, c)})
	entry := e.withServer(st)

	e.must(e.a.Archive(KindGroup, g))
	e.must(e.a.Unarchive(KindGroup, g))
	e.must(e.a.Archive(KindChat, c))
	e.must(e.a.Unarchive(KindChat, c))
	e.must(e.a.DeleteGroup(g, true))

	for _, r := range st.Requests() {
		if r.Method != http.MethodGet || (r.Path != servers.HelloPath && r.Path != servers.StreamPath) {
			t.Errorf("the server was sent %s %s", r.Method, r.Path)
		}
	}
	snap := e.a.Snapshot()
	if len(snap.Groups) != 0 || len(snap.Boards) != 0 || len(snap.Chats) != 0 {
		t.Errorf("the local lists after the delete: %+v %+v %+v", snap.Groups, snap.Boards, snap.Chats)
	}
	tree := snap.Sections[entry]
	if len(tree.Groups) != 1 || len(tree.Boards) != 1 || len(tree.Chats) != 1 ||
		tree.Boards[0].Archived || tree.Chats[0].Archived {
		t.Errorf("the section after the local changes: %+v", tree)
	}
}
