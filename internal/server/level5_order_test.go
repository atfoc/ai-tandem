package server

import (
	"fmt"
	"slices"
	"testing"

	"ai-whiteboard/internal/editorbridge/bridgetest"
	"ai-whiteboard/internal/model"
)

// The order of the tree (goal 3.3: a section shows the server's tree with the same groups, in the
// same order; contract 2.5): each list of a client's snapshot has one order, the same at every
// read, and it is the order the owner's page is given.

// l5Order is the ids of the four lists of a snapshot, each in the order it has there; a branch
// state is named by its chat and its branch.
type l5Order struct{ groups, boards, chats, states []string }

func l5OrderOf(t *testing.T, raw string) l5Order {
	t.Helper()
	snap := decode[struct {
		Groups, Boards, Chats []struct{ ID string }
		States                []struct{ Chat, Branch string }
	}](t, raw)
	var o l5Order
	for _, g := range snap.Groups {
		o.groups = append(o.groups, g.ID)
	}
	for _, b := range snap.Boards {
		o.boards = append(o.boards, b.ID)
	}
	for _, c := range snap.Chats {
		o.chats = append(o.chats, c.ID)
	}
	for _, s := range snap.States {
		o.states = append(o.states, s.Chat+"/"+s.Branch)
	}
	return o
}

// The owner's page and two clients make groups, boards and chats by turns. The groups are
// listed in the server's order, the boards and the chats oldest first, whoever made them, and the branch states by their chat. Every read of the tree has that order: the owner's
// page, each client's GET /api/state, read again and again, and the snapshot of a client that
// connects later. A rename, a move and an archive leave each thing where it is, and an order
// of the groups that the owner sets is the clients' too.
func TestLevel5ListsHaveOneOrder(t *testing.T) {
	t.Parallel()
	e := newL5Env(t)
	p := e.page(l5Owner)
	x, _ := e.l.api(apiX)
	y, _ := e.l.api(apiY)
	makers := []*bridgetest.Page{p, x, y}

	var want l5Order
	// Three groups, one by each, and a group nested in the second; then the third is moved in
	// front of the first: the order of the groups is the server's, not their age.
	for i, c := range makers {
		want.groups = append(want.groups, l5ID(t, l5Want(t, c, 200, "POST", "/api/groups", fmt.Sprintf(`{"name":"Group %d"}`, i))))
	}
	nested := l5ID(t, l5Want(t, x, 200, "POST", "/api/groups", `{"name":"Nested","parent":"`+want.groups[1]+`"}`))
	l5Want(t, y, 200, "POST", "/api/groups/"+want.groups[2]+"/move", `{"parent":"","before":"`+want.groups[0]+`"}`)
	e.st.Read(func(s *model.State) {
		want.groups = nil
		for _, g := range s.Groups {
			want.groups = append(want.groups, g.ID)
		}
	})
	if len(want.groups) != 4 || want.groups[0] == want.groups[1] || !slices.Contains(want.groups, nested) {
		t.Fatalf("the groups of the server: %v", want.groups)
	}
	// More of each kind than one bucket of a map holds, by the three in turn, in every group and
	// in none.
	places := append(slices.Clone(want.groups), model.Ungrouped)
	for i := 0; i < 12; i++ {
		c, g := makers[i%3], places[i%len(places)]
		board := l5ID(t, l5Want(t, c, 200, "POST", "/api/boards", fmt.Sprintf(`{"name":"board-%d","group":"%s"}`, i, g)))
		l5Want(t, c, 200, "POST", "/api/boards/"+board+"/release", nil)
		want.boards = append(want.boards, board)
		chat := l5ID(t, l5Want(t, makers[(i+1)%3], 200, "POST", "/api/chats", `{"agent":"claude","group":"`+g+`"}`))
		want.chats = append(want.chats, chat)
		want.states = append(want.states, chat+"/"+model.MainBranch)
	}
	slices.Sort(want.states)

	check := func(when string) {
		t.Helper()
		z, snap := e.l.api(l5Z)
		defer func() {
			z.Close()
			e.env.gone(l5Z)
		}()
		reads := map[string]string{"the snapshot of a client that connects": snap, "the owner's page": l5Want(t, p, 200, "GET", "/api/state", nil)}
		for i := 0; i < 4; i++ {
			reads[fmt.Sprintf("read %d of the client X", i)] = l5Want(t, x, 200, "GET", "/api/state", nil)
			reads[fmt.Sprintf("read %d of the client Y", i)] = l5Want(t, y, 200, "GET", "/api/state", nil)
		}
		for who, raw := range reads {
			got := l5OrderOf(t, raw)
			for _, list := range []struct {
				name      string
				got, want []string
			}{{"groups", got.groups, want.groups}, {"boards", got.boards, want.boards}, {"chats", got.chats, want.chats}, {"states", got.states, want.states}} {
				if !slices.Equal(list.got, list.want) {
					t.Errorf("%s, %s: the %s are in the order\n%v\nwant\n%v", when, who, list.name, list.got, list.want)
				}
			}
		}
	}
	check("after the makes")

	// A change of a thing leaves it where it is: its place is its age, not its last change.
	l5Want(t, x, 200, "POST", "/api/boards/"+want.boards[9]+"/rename", `{"name":"renamed"}`)
	l5Want(t, y, 200, "PATCH", "/api/boards/"+want.boards[2], `{"group":"`+nested+`"}`)
	l5Want(t, p, 200, "POST", "/api/boards/"+want.boards[5]+"/archive", nil)
	l5Want(t, y, 200, "PATCH", "/api/chats/"+want.chats[10], `{"name":"Renamed"}`)
	l5Want(t, p, 200, "PATCH", "/api/chats/"+want.chats[1], `{"group":"`+nested+`"}`)
	l5Want(t, x, 200, "POST", "/api/chats/"+want.chats[4]+"/archive", nil)
	l5Want(t, x, 200, "PATCH", "/api/groups/"+want.groups[0], `{"name":"Renamed"}`)
	check("after a rename, a move and an archive of each kind")

	// What is deleted leaves its list, and the rest stays as it was.
	l5Want(t, y, 200, "DELETE", "/api/boards/"+want.boards[0], nil)
	l5Want(t, p, 200, "DELETE", "/api/chats/"+want.chats[3], nil)
	want.states = slices.DeleteFunc(want.states, func(s string) bool { return s == want.chats[3]+"/"+model.MainBranch })
	want.boards, want.chats = want.boards[1:], slices.Delete(want.chats, 3, 4)
	check("after a delete of each kind")
}
