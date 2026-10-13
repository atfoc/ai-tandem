package app

import (
	"encoding/json"
	"os"
	"slices"
	"strings"
	"testing"

	"ai-whiteboard/internal/defaults"
	"ai-whiteboard/internal/model"
)

// remember makes g the group state.json names in "remoteGroup", as a server from before level 5
// left it.
func (e *env) remember(g string) {
	e.t.Helper()
	e.must(e.st.Update(func(s *model.State) error { s.RemoteGroup = g; return nil }))
}

// stateFile is state.json as it is on disk.
func (e *env) stateFile() map[string]json.RawMessage {
	e.t.Helper()
	raw, err := os.ReadFile(e.st.P.State)
	if err != nil {
		e.t.Fatal(err)
	}
	var keys map[string]json.RawMessage
	e.must(json.Unmarshal(raw, &keys))
	return keys
}

// The change-over of a server from before level 5: the group state.json names in "remoteGroup"
// is removed, whatever its name is now. Its board and its plain chats go to no group
// and keep their own archive marks; a chat on the board stays on it; a group nested in it goes
// to the top level with what is in it; its defaults go; and the id is forgotten. A group that is
// merely named "Remote" is an ordinary group and stays, with what is in it.
func TestLevel5DropRemoteGroup(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	first := e.group("First")
	remote := e.group("Inbox") // the owner renamed it: the id decides, not the name
	sub := e.subgroup("Sub", remote)
	deep := e.subgroup("Deep", sub)
	e.group("Last")
	named := e.group("Remote") // merely named so

	plain := e.chat(remote, "")
	shelved := e.chat(remote, "")
	e.must(e.a.Archive(KindChat, shelved))
	bd := e.board(remote)
	onBoard := e.chat("", bd)
	bdOld := e.board(remote)
	e.must(e.a.Archive(KindBoard, bdOld))
	inSub, inDeep := e.chat(sub, ""), e.chat(deep, "")
	bdSub := e.board(sub)
	other, otherBoard := e.chat(named, ""), e.board(named)
	elsewhere := e.chat(first, "")
	e.must(e.st.Update(func(s *model.State) error {
		defaults.RecordChange(&s.Defaults, remote, model.Claude, "/somewhere", model.ModelChoice{Model: "sonnet"})
		return nil
	}))
	e.remember(remote)
	if string(e.stateFile()["remoteGroup"]) != `"`+remote+`"` {
		t.Fatalf("state.json before: %s", e.stateFile()["remoteGroup"])
	}
	shelvedOp, boardOp := e.chatArchive(shelved), e.boardArchive(bdOld)
	subDefaults := defaultsOf(e, sub)

	e.must(e.a.DropRemoteGroup())

	// The groups: the named one is gone, the one nested in it is at the top level in its place
	// in the order, the one nested deeper is still in that one, and the rest is as it was.
	var got []string
	for _, g := range e.groups() {
		got = append(got, g.Name+"<"+g.Parent)
	}
	if want := []string{"First<", "Sub<", "Deep<" + sub, "Last<", "Remote<"}; !slices.Equal(got, want) {
		t.Fatalf("groups %v, want %v", got, want)
	}
	// What was in it is in no group, with its own archive mark.
	for _, id := range []string{plain, shelved} {
		if g := e.groupOf(id); g != model.Ungrouped {
			t.Errorf("the chat %s is in %s", id, g)
		}
	}
	if e.chatArchive(plain).Archived || e.chatArchive(shelved) != shelvedOp || !shelvedOp.Archived {
		t.Errorf("archive marks of the chats: %+v, %+v (was %+v)", e.chatArchive(plain), e.chatArchive(shelved), shelvedOp)
	}
	for _, id := range []string{bd, bdOld} {
		if b, _ := e.a.Boards.Get(id); b.Group != model.Ungrouped {
			t.Errorf("the board %s is in %s", id, b.Group)
		}
	}
	if e.boardArchive(bd).Archived || e.boardArchive(bdOld) != boardOp || !boardOp.Archived {
		t.Errorf("archive marks of the boards: %+v, %+v (was %+v)", e.boardArchive(bd), e.boardArchive(bdOld), boardOp)
	}
	// The chat on the board is still on it, and so in no group with it.
	if v, err := e.a.Chats.View(onBoard); err != nil || v.Board != bd || e.groupOf(onBoard) != model.Ungrouped {
		t.Errorf("the chat on the board: %+v, %v", v, err)
	}
	// What was in the nested groups is still in them.
	if e.groupOf(inSub) != sub || e.groupOf(inDeep) != deep {
		t.Errorf("the chats of the nested groups are in %s and %s", e.groupOf(inSub), e.groupOf(inDeep))
	}
	if b, _ := e.a.Boards.Get(bdSub); b.Group != sub {
		t.Errorf("the board of the nested group is in %s", b.Group)
	}
	// The group merely named "Remote", and everything else, is untouched.
	if b, _ := e.a.Boards.Get(otherBoard); e.groupOf(other) != named || b.Group != named || e.groupOf(elsewhere) != first {
		t.Errorf("the group named Remote lost something: chat in %s, board in %s", e.groupOf(other), b.Group)
	}
	// The defaults of the removed group are gone, the others stay; the id is forgotten, on disk.
	e.st.Read(func(s *model.State) {
		if _, has := s.Defaults.Groups[remote]; has || s.RemoteGroup != "" {
			t.Errorf("after the change-over: defaults of the group %v, remembered %q", has, s.RemoteGroup)
		}
	})
	if after := defaultsOf(e, sub); after != subDefaults {
		t.Errorf("the defaults of the nested group changed:\nbefore %s\nafter  %s", subDefaults, after)
	}
	file := e.stateFile()
	if _, has := file["remoteGroup"]; has || strings.Contains(string(file["groups"]), remote) || strings.Contains(string(file["defaults"]), remote) {
		t.Errorf("state.json after the change-over: remoteGroup %s, groups %s", file["remoteGroup"], file["groups"])
	}
	// The whole tree is every client's.
	snap := e.a.APISnapshot()
	if len(snap.Groups) != 5 || len(snap.Chats) != 7 || len(snap.Boards) != 4 {
		t.Errorf("the API snapshot after the change-over: %d groups, %d chats, %d boards", len(snap.Groups), len(snap.Chats), len(snap.Boards))
	}

	// It runs once: a second call changes nothing, not even for a group that got the name.
	before := string(mustJSON(t, e.a.APISnapshot()))
	e.must(e.a.UpdateGroup(sub, ptr("Remote"), nil))
	e.must(e.a.UpdateGroup(sub, ptr("Sub"), nil))
	e.must(e.a.DropRemoteGroup())
	if after := string(mustJSON(t, e.a.APISnapshot())); after != before {
		t.Errorf("a second change-over changed the tree:\nbefore %s\nafter  %s", before, after)
	}
}

// The remembered group may be nested in another one, archived, or gone: what is in it goes to no
// group all the same, and a group that is gone leaves only the id to forget. A server that
// remembers no group is left as it is.
func TestLevel5DropRemoteGroupCorners(t *testing.T) {
	t.Parallel()
	t.Run("nested and archived", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		outer := e.group("Outer")
		remote := e.subgroup("Remote", outer)
		inner := e.subgroup("Inner", remote)
		chat, innerChat := e.chat(remote, ""), e.chat(inner, "")
		e.must(e.a.Archive(KindGroup, remote))
		op := e.chatArchive(chat)
		e.remember(remote)

		e.must(e.a.DropRemoteGroup())
		var got []string
		for _, g := range e.groups() {
			got = append(got, g.Name+"<"+g.Parent)
		}
		if want := []string{"Outer<", "Inner<"}; !slices.Equal(got, want) {
			t.Fatalf("groups %v, want %v", got, want)
		}
		// Each keeps the archive mark the group's archive gave it.
		if e.groupOf(chat) != model.Ungrouped || e.chatArchive(chat) != op || !op.Archived {
			t.Errorf("the chat: in %s, archive %+v (was %+v)", e.groupOf(chat), e.chatArchive(chat), op)
		}
		if e.groupOf(innerChat) != inner || !e.groupArchive(inner).Archived || e.groupArchive(inner).Op != op.Op {
			t.Errorf("the nested group: chat in %s, archive %+v", e.groupOf(innerChat), e.groupArchive(inner))
		}
	})
	t.Run("gone", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		g := e.group("G")
		chat := e.chat(g, "")
		e.remember("g_gone0000")
		e.must(e.a.DropRemoteGroup())
		if _, has := e.stateFile()["remoteGroup"]; has || len(e.groups()) != 1 || e.groupOf(chat) != g {
			t.Errorf("after the change-over: state.json names %s, %d groups, the chat in %s", e.stateFile()["remoteGroup"], len(e.groups()), e.groupOf(chat))
		}
	})
	t.Run("none remembered", func(t *testing.T) {
		t.Parallel()
		e := newEnv(t)
		g := e.group("Remote")
		chat := e.chat(g, "")
		before, err := os.ReadFile(e.st.P.State)
		e.must(err)
		e.must(e.a.DropRemoteGroup())
		after, err := os.ReadFile(e.st.P.State)
		e.must(err)
		if string(before) != string(after) || e.groupOf(chat) != g {
			t.Errorf("a server that remembers no group was changed:\nbefore %s\nafter  %s", before, after)
		}
	})
}

// defaultsOf is the defaults of a group as JSON.
func defaultsOf(e *env, group string) string {
	var b []byte
	e.st.Read(func(s *model.State) { b, _ = json.Marshal(s.Defaults.Groups[group]) })
	return string(b)
}

func ptr[T any](v T) *T { return &v }
