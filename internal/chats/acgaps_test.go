package chats

import (
	"errors"
	"reflect"
	"testing"

	"ai-whiteboard/internal/agenttest"
	"ai-whiteboard/internal/model"
)

// AC30: a branch that has no message of its own because its first send failed is a branch of a
// started chat all the same: its agent and its server are fixed.
func TestAgentIsFixedOnABranchWhoseFirstSendFailed(t *testing.T) {
	t.Parallel()
	e, f := fakeEnv(t, model.Claude)
	f.Script(func(tn *agenttest.Turn) { tn.Say("an answer") })
	v := e.create(model.Claude, gOne, "")
	e.send(v.ID, "hello", "")
	waitFor(t, "the turn to end", func() bool { return e.view(v.ID).Usage.Turns == 1 })

	// A new branch at the start of the chat, whose process does not start.
	f.FailSpawn(errors.New("claude: bad login"))
	if err := e.m.SendTo(v.ID, newAt(0), "another start", "", nil); err == nil {
		t.Fatal("SendTo with a start that fails gave no error")
	}
	tree, err := e.m.Tree(v.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(tree.Branches) < 2 {
		// The failed send left no branch: there is nothing whose agent could change. The chat
		// itself is as fixed as before.
		for _, req := range []ConfigReq{{Agent: model.Pi}, {Server: model.LocalServer}} {
			if err := e.m.ConfigureOf(v.ID, "", req); !errors.Is(err, ErrAgentFixed) {
				t.Fatalf("no branch stayed, Configure %+v: %v, want ErrAgentFixed", req, err)
			}
		}
		return
	}
	b := tree.Branches[len(tree.Branches)-1]
	if b.At != 0 || b.From != model.MainBranch {
		t.Fatalf("the branch that stayed: %+v", b)
	}
	for _, it := range b.Items {
		if it.Kind == "text" {
			t.Fatalf("the branch whose send failed has an answer: %+v", b)
		}
	}
	was := e.meta(branchChatID(v.ID, b.ID))
	for _, branch := range []string{b.ID, "", model.MainBranch} {
		for _, req := range []ConfigReq{{Agent: model.Pi}, {Agent: model.Claude}, {Server: model.LocalServer}} {
			if err := e.m.ConfigureOf(v.ID, branch, req); !errors.Is(err, ErrAgentFixed) {
				t.Fatalf("branch %q, Configure %+v: %v, want ErrAgentFixed", branch, req, err)
			}
		}
	}
	if got := e.meta(branchChatID(v.ID, b.ID)); !reflect.DeepEqual(got, was) {
		t.Fatalf("the refused changes left the branch %+v, was %+v", got, was)
	}
	if got := e.meta(v.ID); got.Agent != model.Claude {
		t.Fatalf("the chat's agent after the refused changes: %q", got.Agent)
	}
}
